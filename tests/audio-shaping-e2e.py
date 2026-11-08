"""Offline, isolated MV3 worker responsiveness and waveform regression."""
import json
import shutil
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PROBE = r"""async () => {
  const context = new AudioContext({sampleRate:48000}); await context.resume();
  const player = new NtAudioPlayer(context, context.destination, () => {});
  const make = seconds => {
    const buffer = context.createBuffer(1, 48000 * seconds, 48000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 2 * Math.PI * 150 / 48000) * .1;
    return buffer;
  };
  const cancellations = [];
  for (const seconds of [14,30]) {
    const buffer = make(seconds), before = buffer.getChannelData(0).slice();
    let timerDelay;
    const start = performance.now();
    const cleared = new Promise(resolve => setTimeout(() => {
      timerDelay = performance.now() - start; player.clear(); resolve();
    }, 0));
    const scheduled = await player.enqueueBufferAsync(buffer, {tempo:1.6});
    await cleared;
    const intact = buffer.getChannelData(0).every((sample,i) => sample === before[i]);
    cancellations.push({seconds,timerDelay,scheduled,intact,sources:player.sources.size});
  }
  const buffer = make(2), original = buffer.getChannelData(0).slice();
  const began = performance.now();
  const scheduled = await player.enqueueBufferAsync(buffer, {tempo:1.6,pitch:.8});
  const workerMs = performance.now() - began;
  const source = [...player.sources][0];
  const expected = ntTimeStretch(original,.5,48000);
  const actual = source.buffer.getChannelData(0);
  const exact = actual.length === expected.length && actual.every((sample,i) => sample === expected[i]);
  const duration = source.buffer.duration / source.playbackRate.value;
  let crossings = 0;
  for (let i = 1; i < actual.length; i++) if (actual[i-1] < 0 && actual[i] >= 0) crossings++;
  const pitchHz = crossings / source.buffer.duration * source.playbackRate.value;
  const workerUsed = !!player.shaper.worker;
  const worker = player.shaper.worker;
  let terminations = 0;
  const terminate = worker.terminate.bind(worker);
  worker.terminate = () => { terminations++; terminate(); };
  player.clear();
  const keptIdle = player.shaper.worker === worker && terminations === 0;
  const warmStart = performance.now();
  const warmScheduled = await player.enqueueBufferAsync(buffer, {tempo:1.6,pitch:.8});
  const warmMs = performance.now() - warmStart;
  const warmSource = [...player.sources][0];
  const warmSamples = warmSource.buffer.getChannelData(0);
  const warmExact = warmSamples.length === expected.length && warmSamples.every((sample,i) => sample === expected[i]);
  const reused = player.shaper.worker === worker;
  const intact = buffer.getChannelData(0).every((sample,i) => sample === original[i]);
  player.clear();
  const pcm = new Int16Array(24000 * 2);
  let firstMs = null;
  const streamStart = performance.now(), originalStart = context.createBufferSource.bind(context);
  context.createBufferSource = () => {
    const source = originalStart(), start = source.start.bind(source);
    source.start = (...args) => { if (firstMs === null) firstMs = performance.now()-streamStart; return start(...args); };
    return source;
  };
  await player.enqueuePcm16Async(pcm.buffer,24000,{tempo:1.3,stream:true,preservePitch:true});
  const result = {cancellations,worker:{scheduled,workerUsed,workerMs,exact,duration,pitchHz,
    warmScheduled,warmMs,warmExact,keptIdle,reused,intact},stream:{firstMs,sources:player.sources.size}};
  player.destroy(); result.worker.terminations=terminations;
  await context.close(); return result;
}"""

with tempfile.TemporaryDirectory(prefix="nt-audio-shaping-") as temporary, sync_playwright() as p:
    extension = Path(temporary) / "extension"
    extension.mkdir()
    for name in ["manifest.json", "src", "assets"]:
        source = ROOT / name
        (shutil.copytree if source.is_dir() else shutil.copy)(source, extension / name)
    context = p.chromium.launch_persistent_context(str(Path(temporary) / "profile"),
        channel="chromium", headless=True, args=[f"--disable-extensions-except={extension}",
        f"--load-extension={extension}", "--autoplay-policy=no-user-gesture-required"])
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
        extension_id = worker.url.split("/")[2]
        page = context.new_page()
        page.goto(f"chrome-extension://{extension_id}/src/offscreen/offscreen.html")
        result = {"browser": context.browser.version, **page.evaluate(PROBE)}
        output = ROOT / "test-results" / "audio-shaping-e2e.json"
        output.parent.mkdir(exist_ok=True)
        output.write_text(json.dumps(result, indent=2), encoding="utf-8")
        for item in result["cancellations"]:
            assert item["timerDelay"] < 150, item
            assert not item["scheduled"] and item["sources"] == 0 and item["intact"], item
        shaped = result["worker"]
        assert shaped["scheduled"] and shaped["workerUsed"] and shaped["exact"], shaped
        assert all(shaped[key] for key in ["warmScheduled", "warmExact", "keptIdle", "reused", "intact"]), shaped
        assert shaped["terminations"] == 1, shaped
        assert abs(shaped["duration"] - 1.25) < .001 and abs(shaped["pitchHz"] - 120) < 3, shaped
        assert result["stream"]["firstMs"] < 150 and result["stream"]["sources"] > 0, result
        print(json.dumps(result), flush=True)
    finally:
        context.close()
