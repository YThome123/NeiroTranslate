"""Small opt-in paid-provider check. Keys come only from process environment.

NT_ELEVEN_API_KEY / NT_GEMINI_API_KEY. Optional NT_ELEVEN_VOICE_ID.
Uses an isolated temporary profile, never saves keys in extension storage.
One short ElevenLabs phrase and one Gemini Live translation may consume quota.
Reports/audio go to ignored test-results/, never the release archive.
"""

import base64
import json
import os
import shutil
import sys
import tempfile
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8")

CHECK = """async keys => {
  const results = {};
  const clean = error => [keys.eleven, keys.gemini].filter(Boolean).reduce(
    (text, key) => text.split(key).join('[redacted]'), String(error?.message || error));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  if (keys.eleven) {
    let bytes = 0, firstMs = null;
    const started = performance.now(), audio = getPlayer();
    audio.clear();
    try {
      await audioCtx.resume();
      await ntElevenLabsStream('Привет! Проверяем естественную озвучку.', {gt:'ru'}, {
        elevenApiKey: keys.eleven, elevenVoiceId: keys.voice,
        elevenModel:'eleven_v4_turbo', elevenStability:0.5, elevenSimilarity:0.75
      }, (pcm, rate) => {
        if (firstMs === null) firstMs = Math.round(performance.now() - started);
        bytes += pcm.byteLength; audio.enqueuePcm16(pcm, rate);
      }, AbortSignal.timeout(12000));
      await audio.whenIdle();
      results.elevenlabs = {ok:true,model:'eleven_v4_turbo',pcmBytes:bytes,firstPcmMs:firstMs};
    } catch (error) { audio.clear(); results.elevenlabs = {ok:false,error:clean(error),pcmBytes:bytes}; }
  }
  if (keys.gemini) {
    const model = 'gemini-3.5-live-translate-preview', started = performance.now();
    let ready = false, fatal = '', transcript = '', pcmBytes = 0, firstPcmMs = null;
    const chunks = [], audio = getPlayer(); audio.clear();
    const session = new NtGeminiLive({apiKey:keys.gemini,model,targetLang:'ru',targetName:'Russian',
      onStatus:code => { if(code === 'ready') ready = true; },
      onFatal:detail => {fatal = clean(detail);},
      onTranscript:line => {if(line.kind === 'output') transcript = line.text;},
      onAudio:(encoded,rate) => {
        const raw = atob(encoded), bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
        chunks.push(bytes); pcmBytes += bytes.length;
        if(firstPcmMs === null) firstPcmMs = Math.round(performance.now() - started);
        audio.enqueuePcm16(bytes.buffer,rate);
      }});
    let inputContext;
    try {
      session.connect();
      const setupDeadline = performance.now() + 14500;
      while(!ready && !fatal && performance.now() < setupDeadline) await sleep(50);
      if (!ready) throw new Error(fatal || 'Live setup did not complete');
      results.gemini = {ok:true,liveSetup:true,model};
      inputContext = new AudioContext({sampleRate:16000});
      const buffers = await ntGoogleTts('Hello! Welcome to the stream.', {gt:'en'}, inputContext, AbortSignal.timeout(7000));
      const samples = [];
      for (let buffer of buffers) {
        if (buffer.sampleRate !== 16000) {
          const offline = new OfflineAudioContext(1,Math.ceil(buffer.duration*16000),16000);
          const source = offline.createBufferSource(); source.buffer=buffer;source.connect(offline.destination);source.start();
          buffer = await offline.startRendering();
        }
        samples.push(...buffer.getChannelData(0));
      }
      // Natural cadence plus 800ms silence so the last spoken word can finish.
      for(let offset=0;offset<samples.length+12800;offset+=1600) {
        if(fatal) throw new Error(fatal);
        const bytes = new Uint8Array(3200), view = new DataView(bytes.buffer);
        for(let i=0;i<1600;i++) view.setInt16(i*2,Math.round(Math.max(-1,Math.min(1,samples[offset+i]||0))*32767),true);
        session.sendAudio(btoa(String.fromCharCode(...bytes)));
        await sleep(100);
      }
      const outputDeadline = performance.now() + 12000;
      while ((!pcmBytes || !/[а-яё]/i.test(transcript)) && !fatal && performance.now()<outputDeadline) await sleep(100);
      if(fatal) throw new Error(fatal);
      results.gemini = {...results.gemini,audioTranslation:pcmBytes>0 && /[а-яё]/i.test(transcript),
        pcmBytes,transcript,firstPcmMs};
      if(pcmBytes) {
        const all = new Uint8Array(pcmBytes);let offset=0;
        for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
        let binary = '';
        for(let i=0;i<all.length;i+=32768) binary += String.fromCharCode(...all.subarray(i,i+32768));
        results.gemini.audioBase64=btoa(binary);
      }
    } catch(error) {
      results.gemini = {...(results.gemini||{}),ok:ready,liveSetup:ready,model,error:clean(error),pcmBytes,transcript};
    } finally { session.close(); audio.clear(); if(inputContext) await inputContext.close(); }
  }
  return results;
}"""


def main():
    keys = {"eleven": os.environ.get("NT_ELEVEN_API_KEY", ""), "gemini": os.environ.get("NT_GEMINI_API_KEY", ""),
            "voice": os.environ.get("NT_ELEVEN_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")}
    if not (keys["eleven"] or keys["gemini"]):
        print("Set NT_ELEVEN_API_KEY and/or NT_GEMINI_API_KEY in the process environment.")
        return 2
    with tempfile.TemporaryDirectory(prefix="nt-paid-live-") as scratch:
        temp = Path(scratch)
        ext = temp / "ext"
        ext.mkdir()
        for name in ("manifest.json", "src", "assets"):
            source = ROOT / name
            (shutil.copytree if source.is_dir() else shutil.copy)(source, ext / name)
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(str(temp / "profile"), channel="chromium", headless=True,
                args=[f"--disable-extensions-except={ext}",f"--load-extension={ext}","--autoplay-policy=no-user-gesture-required"])
            try:
                worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
                ext_id = worker.url.split("/")[2]
                page = ctx.new_page()
                page.goto(f"chrome-extension://{ext_id}/src/options/options.html")
                page.wait_for_function("() => settings !== null")
                result = page.evaluate(CHECK, keys)
            finally:
                ctx.close()
    destination = ROOT / "test-results"
    destination.mkdir(exist_ok=True)
    if result.get("gemini", {}).get("audioBase64"):
        pcm = base64.b64decode(result["gemini"].pop("audioBase64"))
        with wave.open(str(destination / "gemini-live-sample.wav"), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(24000)
            audio.writeframes(pcm)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    for value in (keys["eleven"], keys["gemini"]):
        if value:
            text = text.replace(value, "[redacted]")
    (destination / "paid-providers-live.json").write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
