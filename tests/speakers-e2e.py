"""Real Chromium checks for the audio pieces unit tests cannot reach.

1. The speaker AudioWorklet loads into a real AudioWorklet scope (speakers.js +
   speaker-worklet.js) and its frames, mapped to wall-clock time, separate a low
   and a high voice played through a real AudioContext.
2. NtAudioPlayer renders a phrase with tempo/pitch shaping in an OfflineAudioContext:
   the rendered audio has the planned duration and the planned pitch.

The extension page (offscreen.html) is opened as a normal tab so production code
runs unmodified; no tab capture is involved (that needs a user gesture).
Run: python tests/speakers-e2e.py   Results: test-results/speakers.json
"""

import json
import shutil
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "test-results" / "speakers.json"
sys.stdout.reconfigure(encoding="utf-8")

WORKLET = """async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitForFrames = async (from, hz) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (speakerFrames.filter(f => f.wall >= from && Math.abs(f.f0 - hz) < 12).length >= 60) return;
      await sleep(50);
    }
    throw new Error('AudioWorklet did not produce enough voiced frames at ' + hz + ' Hz');
  };
  capCtx = new AudioContext({sampleRate: 16000});
  const osc = capCtx.createOscillator();
  // Harmonic-rich wave, like voiced speech rather than a pure sine.
  osc.setPeriodicWave(capCtx.createPeriodicWave(new Float32Array([0, 1, .6, .4, .3, .2]), new Float32Array(6)));
  osc.frequency.value = 118;
  const level = capCtx.createGain(); level.gain.value = 0.25; osc.connect(level);
  const silent = capCtx.createGain(); silent.gain.value = 0; silent.connect(capCtx.destination);
  const loaded = await startSpeakerAnalysis(level, silent);
  await capCtx.resume();
  osc.start();
  const t0 = Date.now(); await waitForFrames(t0, 118);
  osc.frequency.setValueAtTime(232, capCtx.currentTime);
  const t1 = Date.now(); await waitForFrames(t1, 232);
  const t2 = Date.now();
  const low = speakerAt(t0 + 250, t1 - 100, null);
  const high = speakerAt(t1 + 250, t2 - 100, low && low.cluster);
  const lowAgain = speakerAt(t0 + 400, t1 - 200, high && high.cluster);
  const frames = speakerFrames.length;
  const voiced = speakerFrames.filter(f => f.f0 > 0).length;
  osc.stop(); await capCtx.close(); capCtx = null;
  return {loaded, frames, voiced, low, high, lowAgain};
}"""

PLAYER = """async () => {
  const rate = 48000, seconds = 2, hz = 200;
  const offline = new OfflineAudioContext(1, rate * 3, rate);
  // An offline context is "suspended" until rendering starts; the player only
  // nudges resume(), which must not reject here.
  offline.resume = () => Promise.resolve();
  const input = offline.createBuffer(1, rate * seconds, rate);
  const data = input.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = 0.4 * Math.sin(2 * Math.PI * hz * i / rate) + 0.15 * Math.sin(4 * Math.PI * hz * i / rate);
  const player = new NtAudioPlayer(offline, offline.destination, () => {});
  const t = performance.now();
  player.enqueueBuffer(input, {tempo: 1.5, pitch: 0.8});
  const shapingMs = performance.now() - t;
  const rendered = (await offline.startRendering()).getChannelData(0);
  player.destroy();
  let first = -1, last = -1;
  for (let i = 0; i < rendered.length; i++) if (Math.abs(rendered[i]) > 0.02) { if (first < 0) first = i; last = i; }
  let crossings = 0;
  for (let i = first + 1; i < last; i++) if (rendered[i - 1] < 0 && rendered[i] >= 0) crossings++;
  const duration = (last - first) / rate;
  return {duration, frequency: crossings / duration, shapingMs};
}"""

STREAMED_PLAYER = """async () => {
  const rate = 24000, bytes = new Uint8Array(rate * 0.65 * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length / 2; i++) view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * 180 * i / rate) * 10000), true);
  const results = [];
  for (const packetBytes of [4800, 9600]) {
    const offline = new OfflineAudioContext(1, rate * 2, rate);
    offline.resume = () => Promise.resolve();
    const player = new NtAudioPlayer(offline, offline.destination, () => {});
    for (let at = 0; at < bytes.length; at += packetBytes) {
      player.enqueuePcm16(bytes.slice(at, at + packetBytes).buffer, rate,
        {tempo: 4 / 3, stream: true, preservePitch: true});
    }
    player.flushPcm16();
    const data = (await offline.startRendering()).getChannelData(0);
    player.destroy();
    let first = -1, last = -1, crossings = 0, maxJump = 0;
    for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > 0.02) {if (first < 0) first = i; last = i;}
    for (let i = first + 1; i < last; i++) if (data[i - 1] < 0 && data[i] >= 0) crossings++;
    for (let i = first + 1; i < last; i++) maxJump = Math.max(maxJump,Math.abs(data[i]-data[i-1]));
    const duration = (last - first) / rate;
    results.push({duration, frequency: crossings / duration, maxJump, audio: data});
  }
  let difference = 0;
  for (let i = 0; i < results[0].audio.length; i++) difference = Math.max(difference, Math.abs(results[0].audio[i] - results[1].audio[i]));
  return {difference, metrics: results.map(({duration, frequency, maxJump}) => ({duration, frequency, maxJump}))};
}"""


def check(results, name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def main():
    results = []
    with tempfile.TemporaryDirectory(prefix="nt-speakers-") as scratch:
        tmp = Path(scratch)
        ext = tmp / "ext"
        ext.mkdir()
        for item in ("manifest.json", "src", "assets"):
            src = ROOT / item
            (shutil.copytree if src.is_dir() else shutil.copy)(src, ext / item)
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                str(tmp / "profile"), channel="chromium", headless=True,
                args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}",
                      "--autoplay-policy=no-user-gesture-required"])
            try:
                sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
                ext_id = sw.url.split("/")[2]
                page = ctx.new_page()
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(f"chrome-extension://{ext_id}/src/offscreen/offscreen.html")

                w = page.evaluate(WORKLET)
                check(results, "speaker worklet loads in a real AudioWorklet scope", w["loaded"], f"{w['frames']} frames")
                check(results, "worklet reports voiced pitch frames", w["voiced"] > 60, f"{w['voiced']} voiced of {w['frames']}")
                low, high, again = w["low"], w["high"], w["lowAgain"]
                check(results, "low voice is classified low", bool(low) and low["pitchClass"] == "low", json.dumps(low))
                check(results, "high voice is classified high", bool(high) and high["pitchClass"] == "high", json.dumps(high))
                check(results, "two voices become two speakers",
                      bool(low and high) and low["cluster"] != high["cluster"])
                check(results, "the first voice is recognised again", bool(again and low) and again["cluster"] == low["cluster"],
                      json.dumps(again))
                check(results, "measured pitch is accurate", bool(low and high) and abs(low["hz"] - 118) <= 6 and abs(high["hz"] - 232) <= 10,
                      f"{low and low['hz']} Hz / {high and high['hz']} Hz")

                r = page.evaluate(PLAYER)
                check(results, "tempo 1.5 shortens a 2 s phrase to ~1.33 s", abs(r["duration"] - 2 / 1.5) < 0.05, f"{r['duration']:.3f} s")
                check(results, "pitch 0.8 lowers 200 Hz to ~160 Hz", abs(r["frequency"] - 160) < 6, f"{r['frequency']:.1f} Hz")
                check(results, "shaping a 2 s phrase is fast", r["shapingMs"] < 150, f"{r['shapingMs']:.1f} ms")
                streamed = page.evaluate(STREAMED_PLAYER)
                check(results, "streamed tempo preserves pitch for both packet sizes", all(abs(m["frequency"] - 180) < 8 for m in streamed["metrics"]), json.dumps(streamed["metrics"]))
                check(results, "streamed tempo shortens audio without losing its tail", all(0.48 < m["duration"] < 0.56 for m in streamed["metrics"]))
                check(results, "real WebAudio output does not depend on network packet size", streamed["difference"] < 0.000001, str(streamed["difference"]))
                check(results, "stream block joins do not introduce clicks on a steady tone", all(m["maxJump"] < 0.06 for m in streamed["metrics"]), json.dumps([m["maxJump"] for m in streamed["metrics"]]))
                check(results, "no page errors", not errors, "; ".join(errors))
            finally:
                ctx.close()
    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text(json.dumps({"results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    failed = [r for r in results if not r["ok"]]
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
