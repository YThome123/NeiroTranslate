"""Real Chromium video/extension/WebAudio regression suite for pause, seek and lag.

Run: python tests/playback-e2e.py [--live-network]
External providers are substituted at HTTP boundaries to reproduce slow/out-of-order
responses. No production functions are replaced. The audio probe is injected only
into a temporary extension copy and measures real WebAudio samples and source stops.
Results (including failures and timings): test-results/playback.json.
"""

import json
import shutil
import statistics
import sys
import tempfile
import time
import traceback
import zipfile
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = "https://playback.neirotranslate.test"
LATENCY = "--latency" in sys.argv
LOOKAHEAD = "--lookahead" in sys.argv
LIVE_NETWORK = "--live-network" in sys.argv or LATENCY
if LOOKAHEAD:
    REPORT_NAME = (
        "lookahead-"
        + ("live-" if LIVE_NETWORK else "")
        + ("before.json" if "--baseline" in sys.argv else "after.json")
    )
elif LATENCY:
    REPORT_NAME = (
        "latency-before.json" if "--baseline" in sys.argv else "latency-after.json"
    )
else:
    REPORT_NAME = "playback-live.json" if LIVE_NETWORK else "playback.json"
REPORT = ROOT / "test-results" / REPORT_NAME
PAGE = """<!doctype html><html lang="en"><meta charset="utf-8"><title>Playback QA</title>
<body><video id="v" controls playsinline style="width:800px;height:450px"></video>
<script>window.track=document.querySelector('video').addTextTrack('subtitles','English','en');
track.mode='showing';fetch('/demo.webm').then(r=>r.blob()).then(b=>{
document.querySelector('video').src=URL.createObjectURL(b);});</script></body></html>"""
sys.stdout.reconfigure(encoding="utf-8")


class Suite:
    def __init__(self, ctx, sw):
        self.ctx, self.sw = ctx, sw
        self.errors, self.results, self.metrics = [], [], {}
        self.page = ctx.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(ORIGIN)
        self.page.wait_for_function("document.querySelector('video').readyState>=4")
        self.tab = sw.evaluate(
            "async origin => (await chrome.tabs.query({url:origin+'/*'}))[0].id", ORIGIN
        )
        sw.evaluate("""() => {
          const nativeFetch=fetch;
          self.qa={mode:'ok',requests:[],pending:[],events:[],browser:[],stops:0};
          globalThis.fetch=async (url,options) => {
            if (!/translate.google/.test(String(url))) return nativeFetch(url,options);
            const q=new URL(url).searchParams.get('q');
            const entry={text:q,at:Date.now(),aborted:false}; qa.requests.push(entry);
            options?.signal?.addEventListener('abort',()=>{entry.aborted=true;},{once:true});
            if (qa.mode==='live') return nativeFetch(url,options);
            if (qa.mode==='delay') await new Promise(resolve=>setTimeout(resolve,250));
            if (qa.mode==='hold') await new Promise(resolve=>qa.pending.push(resolve));
            if (qa.mode==='error') return new Response('',{status:503});
            return new Response(JSON.stringify([[['Перевод: '+q]],null,'en']));
          };
          const nativeSend=chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage=(msg,...args) => {
            qa.events.push({type:msg.type,text:msg.text,at:Date.now()});
            return nativeSend(msg,...args);
          };
        }""")

    def wait(self, condition, timeout=4000):
        end = time.monotonic() + timeout / 1000
        last = None
        while time.monotonic() < end:
            last = condition()
            if last:
                return last
            self.page.wait_for_timeout(25)
        raise AssertionError(f"Condition timed out after {timeout} ms; last={last!r}")

    def audio(self, **message):
        try:
            return self.sw.evaluate(
                "msg=>chrome.runtime.sendMessage({type:'NT_QA_AUDIO',...msg})", message
            )
        except PlaywrightError as error:
            if "Receiving end does not exist" in str(error):
                return (
                    None  # The browser->Google fallback is still creating the document.
                )
            raise

    def state(self):
        return self.sw.evaluate("()=>state")

    def line(self):
        return self.page.evaluate(
            "()=>document.querySelector('#neirotranslate-root')?.shadowRoot.querySelector('.line').textContent || ''"
        )

    def pause(self):
        self.page.evaluate("()=>document.querySelector('video').pause()")
        self.wait(lambda: self.state()["paused"])

    def play(self):
        self.page.evaluate("()=>document.querySelector('video').play()")
        self.wait(lambda: not self.state()["paused"])

    def seek(self, position):
        self.page.evaluate(
            "at=>{document.querySelector('video').currentTime=at;}", position
        )
        self.page.wait_for_function(
            "!document.querySelector('video').seeking && document.querySelector('video').readyState>=4"
        )
        assert (
            abs(
                self.page.evaluate("document.querySelector('video').currentTime")
                - position
            )
            < 0.5
        )

    def reset(self, text, mode="ok", voice="google", cues=None, audio_mode="ok"):
        if LIVE_NETWORK:
            mode, audio_mode = "live", "live"
        self.sw.evaluate("()=>stop()")
        self.page.evaluate("""() => {
          const v=document.querySelector('video'); v.pause(); v.playbackRate=1; v.loop=false;
          v.currentTime=0; v.volume=0.8;
          for(const cue of [...track.cues]) track.removeCue(cue);
        }""")
        self.page.wait_for_function("!document.querySelector('video').seeking")
        self.sw.evaluate(
            """async cfg => {
          qa.pending.splice(0).forEach(resolve=>resolve());
          qa.mode=cfg.mode; qa.requests=[]; qa.events=[]; qa.browser=[];
          await chrome.storage.local.set({source:'captions',voice:cfg.voice,targetLang:'ru',uiLang:'ru',
            originalVolume:0.25,dubVolume:1,hideNativeCaptions:true,showOriginal:true});
        }""",
            {"mode": mode, "voice": voice},
        )
        res = self.sw.evaluate("id=>start(id)", self.tab)
        assert res.get("ok"), res
        if voice == "google":
            assert self.audio(
                mode=audio_mode, duration=getattr(self, "audio_duration", 8)
            )["ok"]
        self.page.evaluate(
            "rows=>rows.forEach(([start,end,text])=>track.addCue(new VTTCue(start,end,text)))",
            cues or [[0, 24, text]],
        )
        # Start the media clock only after setup; short cues must not elapse while
        # Chromium creates the offscreen document on a busy machine.
        self.media_started_at = self.page.evaluate(
            "()=>{document.querySelector('video').play(); return Date.now();}"
        )
        self.wait(lambda: self.sw.evaluate("()=>qa.requests.length>0"))

    def release(self):
        self.sw.evaluate(
            "()=>{qa.mode='ok';qa.pending.splice(0).forEach(resolve=>resolve());}"
        )

    def quiet(self):
        info = self.audio()
        return (
            info
            and info["sources"] == 0
            and info["rms"] < 0.00001
            and not info["busy"]
            and info["queue"] == 0
        )

    def scenario(self, name, fn):
        started = time.monotonic()
        try:
            fn()
            row = {"name": name, "passed": True}
            print("PASS " + name, flush=True)
        except Exception as error:
            row = {
                "name": name,
                "passed": False,
                "error": str(error),
                "trace": traceback.format_exc(),
            }
            print("FAIL " + name + " — " + str(error), flush=True)
            try:
                row["diagnostics"] = {
                    "state": self.state(),
                    "line": self.line(),
                    "video": self.page.evaluate(
                        "()=>{const v=document.querySelector('video');return {at:v.currentTime,paused:v.paused,seeking:v.seeking,ended:v.ended,ready:v.readyState,seekable:[...Array(v.seekable.length)].map((_,i)=>[v.seekable.start(i),v.seekable.end(i)])}}"
                    ),
                    "worker": self.sw.evaluate(
                        "()=>({requests:qa.requests,events:qa.events.slice(-20)})"
                    ),
                    "audio": self.audio(),
                }
                print(json.dumps(row["diagnostics"], ensure_ascii=False), flush=True)
                self.page.screenshot(
                    path=str(REPORT.parent / f"failure-{len(self.results) + 1}.png")
                )
            except Exception:
                pass
        row["duration_ms"] = round((time.monotonic() - started) * 1000)
        self.results.append(row)

    def immediate(self):
        started = time.time() * 1000
        self.reset("A finalized cue.", voice="off")
        self.wait(lambda: "A finalized cue." in self.line())
        request = self.sw.evaluate("()=>qa.requests[0]")
        event = self.sw.evaluate(
            "()=>qa.events.find(e=>e.type==='NT_SUBTITLE' && e.text)"
        )
        delay = event["at"] - request["at"]
        self.metrics["fixture_translation_ms"] = delay
        self.metrics["startup_to_overlay_ms"] = round(time.time() * 1000 - started)
        assert delay < 500, f"translation took {delay} ms on immediate HTTP fixture"

    def pause_request(self):
        self.reset("Held before pause.", mode="hold")
        self.pause()
        assert self.sw.evaluate("()=>qa.requests.some(r=>r.aborted)")
        self.release()
        self.page.wait_for_timeout(300)
        assert not self.line()
        assert self.quiet(), self.audio()
        assert not self.sw.evaluate(
            "()=>qa.events.some(e=>e.type==='NT_SUBTITLE' && e.text)"
        )

    def resume_request(self):
        self.reset("Resume this cue.", mode="hold", voice="off")
        self.pause()
        self.release()
        self.play()
        self.wait(lambda: "Resume this cue." in self.line())
        assert (
            len(
                self.sw.evaluate(
                    "()=>qa.events.filter(e=>e.type==='NT_SUBTITLE' && e.text)"
                )
            )
            == 1
        )

    def pause_audio(self):
        self.reset("A long spoken cue.")
        self.wait(lambda: self.audio()["rms"] > 0.01)
        before = self.audio()
        started = time.monotonic()
        self.pause()
        self.wait(self.quiet, timeout=600)
        self.metrics["pause_to_silence_ms"] = round((time.monotonic() - started) * 1000)
        after = self.audio()
        assert after["stops"] > before["stops"], after
        assert (
            abs(self.page.evaluate("document.querySelector('video').volume") - 0.8)
            < 0.01
        )
        self.page.wait_for_timeout(250)
        assert self.audio()["starts"] == before["starts"]

    def pause_tts(self):
        self.reset("Hold the synthesis.", audio_mode="hold")
        self.wait(lambda: self.audio()["pending"] > 0)
        self.pause()
        self.wait(lambda: self.audio()["requests"][0]["aborted"])
        self.audio(mode="ok", release=True)
        self.page.wait_for_timeout(300)
        assert self.quiet(), self.audio()
        assert self.audio()["starts"] == 0

    def fresh_tts(self):
        self.reset(
            "old",
            audio_mode="hold",
            cues=[[0, 0.8, "Stalled old synthesis."], [0.8, 24, "Fresh synthesis."]],
        )
        self.wait(lambda: self.audio()["pending"] > 0)
        self.audio(mode="ok")
        self.wait(lambda: "Fresh synthesis." in self.line())
        started = time.monotonic()
        self.wait(lambda: self.audio()["starts"] > 0, timeout=2500)
        self.metrics["fresh_tts_after_stalled_ms"] = round(
            (time.monotonic() - started) * 1000
        )
        assert self.audio()["requests"][0]["aborted"]
        self.audio(release=True)

    def hedged_audio(self):
        self.reset("A faster voice server wins.", audio_mode="slow-primary")
        self.wait(lambda: self.audio()["rms"] > 0.01)
        before = self.audio()
        attempts = [
            request
            for request in before["requests"]
            if request["version"] == before["version"]
        ]
        elapsed = round(time.time() * 1000 - attempts[0]["at"])
        self.metrics["slow_primary_to_backup_audio_ms"] = elapsed
        assert elapsed < 1500, before
        assert len(attempts) == 2
        assert attempts[0]["aborted"]
        assert before["starts"] == 1
        self.pause()
        self.audio(mode="ok", release=True)
        self.page.wait_for_timeout(300)
        assert self.quiet()
        assert self.audio()["starts"] == before["starts"]

    def early_chunk(self):
        text = "First sentence. " * 12 + "SECONDCHUNK " * 12
        self.reset(text, audio_mode="hold-tail")
        self.wait(lambda: self.audio()["rms"] > 0.01, timeout=1500)
        before = self.audio()
        assert before["pending"] > 0
        assert before["busy"], (
            "The tail must still be loading when the first part speaks"
        )
        self.pause()
        self.audio(mode="ok", release=True)
        self.page.wait_for_timeout(300)
        assert self.quiet()
        assert self.audio()["starts"] == before["starts"]

    def prepared_cue(self):
        self.reset(
            "first",
            mode="delay",
            audio_mode="delay",
            cues=[[0, 1.8, "Current cue."], [2, 24, "UPCOMING prepared cue."]],
        )
        self.wait(lambda: self.audio()["rms"] > 0.01)
        self.wait(
            lambda: self.page.evaluate(
                "document.querySelector('video').currentTime>1.2"
            )
        )
        before = self.audio()
        assert before["starts"] == 1, (
            "Preparation must not speak the future phrase early"
        )
        assert "UPCOMING" not in self.line()
        future = [r for r in before["requests"] if "UPCOMING" in r["text"]]
        assert future, "Future speech must be fetched before its cue starts"
        self.wait(
            lambda: (
                "UPCOMING" in self.line() and self.audio()["starts"] > before["starts"]
            )
        )
        delay = round(
            (self.page.evaluate("document.querySelector('video').currentTime") - 2)
            * 1000
        )
        self.metrics["prepared_cue_to_audio_ms"] = delay
        # Record latency rather than asserting a wall-clock SLA on a loaded host.
        # The behavioral gate is no early playback and no new network request.
        assert len(
            [r for r in self.audio()["requests"] if "UPCOMING" in r["text"]]
        ) == len(future)

    def pause_preparation(self):
        self.reset(
            "first",
            audio_mode="hold-future",
            cues=[
                [0, 1.8, "Current speech."],
                [2, 24, "UPCOMING cancelled preparation."],
            ],
        )
        self.wait(lambda: self.audio()["pending"] > 0 and self.audio()["rms"] > 0.01)
        before = self.audio()["starts"]
        self.pause()
        self.wait(
            lambda: all(
                r["aborted"]
                for r in self.audio()["requests"]
                if "UPCOMING" in r["text"]
            )
        )
        self.audio(mode="ok", release=True)
        self.page.wait_for_timeout(300)
        assert self.quiet()
        assert self.audio()["starts"] == before

    def browser_deadline(self):
        self.sw.evaluate("""() => {
          self.qaTts={speak:chrome.tts.speak,getVoices:chrome.tts.getVoices,stop:chrome.tts.stop};
          chrome.tts.getVoices=cb=>cb([{voiceName:'QA Russian',lang:'ru-RU'}]);voiceCache=null;
          chrome.tts.speak=(text,opts,cb)=>{qa.browser.push(text);qa.browserStartStops=qa.stops;opts.onEvent({type:'start'});cb?.();};
          chrome.tts.stop=()=>{qa.stops++;};
        }""")
        try:
            self.reset(
                "Bound browser speech.",
                voice="browser",
                cues=[[0, 2, "Bound browser speech."]],
            )
            self.wait(lambda: self.sw.evaluate("()=>qa.browser.length>0"))
            # Anchor the assertion at engine start: a busy test driver may only
            # observe the browser call after its short cue already expired.
            self.wait(
                lambda: self.sw.evaluate(
                    "()=>qa.stops>qa.browserStartStops && !ttsBusy"
                ),
                timeout=5000,
            )
        finally:
            self.sw.evaluate("()=>{Object.assign(chrome.tts,qaTts);voiceCache=null;}")

    def seek_request(self):
        self.reset(
            "old",
            mode="hold",
            voice="off",
            cues=[[0, 4, "Before seek."], [10, 24, "After seek."]],
        )
        self.seek(10)
        self.release()
        self.wait(lambda: "After seek." in self.line())
        lines = self.sw.evaluate(
            "()=>qa.events.filter(e=>e.type==='NT_SUBTITLE' && e.text).map(e=>e.text)"
        )
        assert all("Before seek." not in line for line in lines), lines

    def seek_audio(self):
        self.reset(
            "old", cues=[[0, 4, "Old spoken cue."], [10, 24, "Fresh spoken cue."]]
        )
        self.wait(lambda: self.audio()["rms"] > 0.01)
        before = self.audio()
        self.seek(10)
        self.wait(lambda: "Fresh spoken cue." in self.line())
        self.wait(lambda: self.audio()["starts"] > before["starts"])
        assert self.audio()["stops"] > before["stops"]
        assert self.audio()["sources"] == 1, self.audio()

    def seek_paused(self):
        self.reset(
            "old", cues=[[0, 4, "Paused old cue."], [10, 24, "Paused fresh cue."]]
        )
        self.pause()
        count = self.sw.evaluate("()=>qa.requests.length")
        self.seek(10)
        self.page.wait_for_timeout(300)
        assert self.sw.evaluate("()=>qa.requests.length") == count
        assert self.quiet()
        self.play()
        self.wait(lambda: "Paused fresh cue." in self.line())

    def stop_request(self):
        self.reset("Stop pending translation.", mode="hold")
        self.sw.evaluate("()=>stop()")
        self.release()
        self.page.wait_for_timeout(200)
        assert not self.state()["active"]
        assert self.page.locator("#neirotranslate-root").count() == 0
        assert self.sw.evaluate("async()=>!(await hasOffscreen())")

    def stop_audio(self):
        self.reset("Stop active audio.")
        self.wait(lambda: self.audio()["rms"] > 0.01)
        self.sw.evaluate("()=>stop()")
        assert self.sw.evaluate("async()=>!(await hasOffscreen())")
        self.wait(
            lambda: (
                abs(self.page.evaluate("document.querySelector('video').volume") - 0.8)
                < 0.01
            )
        )

    def restart(self):
        self.reset("Previous session.", mode="hold", voice="off")
        old = self.state()["sessionId"]
        self.reset("Replacement session.", voice="off")
        self.wait(lambda: "Replacement session." in self.line())
        assert self.state()["sessionId"] != old
        assert "Previous" not in self.line()

    def out_of_order(self):
        self.reset(
            "old",
            mode="hold",
            voice="off",
            cues=[[0, 0.6, "Slow old cue."], [0.6, 24, "Fast new cue."]],
        )
        self.sw.evaluate("()=>{qa.mode='ok';}")
        self.wait(lambda: "Fast new cue." in self.line())
        self.release()
        self.page.wait_for_timeout(200)
        assert "Fast new cue." in self.line()

    def expired(self):
        self.reset(
            "Already expired.",
            mode="hold",
            voice="off",
            cues=[[0, 0.45, "Already expired."]],
        )
        self.wait(
            lambda: self.page.evaluate(
                "document.querySelector('video').currentTime > 0.65"
            )
        )
        self.release()
        self.page.wait_for_timeout(200)
        assert not self.line()

    def no_backlog(self):
        cues = [[i * 0.4, i * 0.4 + 0.39, f"Quick cue {i}."] for i in range(9)]
        self.reset("quick", cues=cues)
        self.wait(
            lambda: self.page.evaluate(
                "document.querySelector('video').currentTime>3.3"
            ),
            timeout=5000,
        )
        info = self.audio()
        self.metrics["rapid_cues_max_observed_ahead_sec"] = round(info["ahead"], 3)
        assert info["sources"] <= 1, info
        assert info["queue"] <= 1, info
        # The fixture answers every 0.4 s cue with 8 s of audio, so one phrase may
        # be scheduled seconds ahead (capped by its hard deadline). What must hold
        # is that it does not stay: an overrunning phrase yields to a newer one,
        # so the phrase being spoken belongs to one of the latest cues.
        assert info["ahead"] < 4.0, info
        assert self.sw.evaluate("()=>voiceQueue.pendingCount") <= 1
        spoken = self.sw.evaluate(
            "()=>qa.events.filter(e=>e.type==='NT_OFF_SPEAK').map(e=>e.text)"
        )
        playing = self.page.evaluate("document.querySelector('video').currentTime")
        current_cue = int(playing / 0.4)
        latest = int(spoken[-1].rstrip(".").rsplit(" ", 1)[-1])
        assert current_cue - latest <= 3, (spoken, playing)
        assert len(spoken) >= 2, spoken
        self.pause()
        self.wait(self.quiet)

    def speech_deadline(self):
        self.reset(
            "Hi.",
            cues=[[0, 2, "Hi."]],
        )
        self.wait(lambda: self.audio()["starts"] > 0)
        self.wait(
            lambda: self.page.evaluate(
                "document.querySelector('video').currentTime>3.8"
            )
        )
        assert self.quiet(), self.audio()

    def long_cue(self):
        self.reset(
            "A long cue remains relevant.",
            cues=[[0, 12, "A long cue remains relevant."]],
        )
        self.wait(lambda: self.audio()["rms"] > 0.01)
        self.wait(
            lambda: self.page.evaluate("document.querySelector('video').currentTime>7"),
            timeout=9000,
        )
        assert self.line(), (
            "Valid long subtitle disappeared after the short request budget"
        )
        assert self.page.evaluate(
            "!document.querySelector('#neirotranslate-root').shadowRoot.querySelector('.subs').classList.contains('hidden')"
        )
        assert self.audio()["rms"] > 0.01, self.audio()

    def subtitle_deadline(self):
        self.reset(
            "Hide this finished cue.",
            voice="off",
            cues=[[0, 1.5, "Hide this finished cue."]],
        )
        self.wait(lambda: bool(self.line()))
        self.wait(
            lambda: self.page.evaluate(
                "document.querySelector('video').currentTime>1.85"
            )
        )
        assert not self.line(), self.line()

    def reload(self):
        self.reset("Before navigation.", voice="off")
        self.pause()
        self.play()
        self.wait(lambda: bool(self.line()))
        self.page.reload()
        self.page.wait_for_function("document.querySelector('video').readyState>=2")
        self.page.wait_for_selector("#neirotranslate-root", state="attached")
        self.page.evaluate(
            "()=>{track.addCue(new VTTCue(0,24,'After navigation.'));document.querySelector('video').play();}"
        )
        self.wait(lambda: "After navigation." in self.line())

    def repeat(self):
        self.reset("Repeated pause and seek.")
        for i in range(4):
            self.pause()
            self.wait(self.quiet)
            self.seek(i + 1)
            self.play()
            self.wait(lambda: bool(self.line()))
        assert self.state()["active"]

    def ratechange(self):
        self.reset("Playback speed.")
        self.wait(lambda: self.audio()["rms"] > 0.01)
        before = self.audio()
        self.page.evaluate("()=>{document.querySelector('video').playbackRate=2;}")
        self.wait(lambda: self.audio()["version"] > before["version"])
        assert self.audio()["stops"] > before["stops"]

    def ended(self):
        self.reset("End of video.")
        self.wait(lambda: self.audio()["rms"] > 0.01)
        self.seek(self.page.evaluate("document.querySelector('video').duration-0.12"))
        self.wait(lambda: self.page.evaluate("document.querySelector('video').ended"))
        self.wait(lambda: self.state()["paused"])
        self.wait(self.quiet)

    def browser_fallback(self):
        # Chrome headless lacks OS voice packages. Inject only the chrome.tts boundary.
        self.sw.evaluate("""() => {
          self.qaTts={speak:chrome.tts.speak,getVoices:chrome.tts.getVoices,stop:chrome.tts.stop};
          chrome.tts.getVoices=cb=>cb([{voiceName:'QA Russian',lang:'ru-RU'}]); voiceCache=null;
          chrome.tts.speak=(text,opts,cb)=>{qa.browser.push(text);opts.onEvent({type:'start'});cb?.();};
          chrome.tts.stop=()=>{qa.stops++;};
        }""")
        try:
            self.reset("Fallback spoken cue.", audio_mode="error")
            self.wait(lambda: self.sw.evaluate("()=>qa.browser.length>0"))
            assert self.state()["status"] == "voice_fallback", self.state()
            before = self.sw.evaluate("()=>qa.stops")
            self.pause()
            assert self.sw.evaluate("()=>qa.stops") > before
        finally:
            self.sw.evaluate("()=>{Object.assign(chrome.tts,qaTts);voiceCache=null;}")

    def missing_browser(self):
        self.sw.evaluate("""() => {
          self.qaTts={speak:chrome.tts.speak,getVoices:chrome.tts.getVoices,stop:chrome.tts.stop};
          chrome.tts.getVoices=cb=>cb([]);voiceCache=null;
          chrome.tts.speak=(text,opts,cb)=>{opts.onEvent({type:'error',errorMessage:'No voice installed'});cb?.();};
        }""")
        try:
            self.reset("Use Google when no browser voice exists.", voice="browser")
            self.wait(lambda: bool(self.audio() and self.audio()["rms"] > 0.01))
            assert self.audio()["starts"] > 0
        finally:
            self.sw.evaluate("()=>{Object.assign(chrome.tts,qaTts);voiceCache=null;}")

    def buffering(self):
        self.reset("Wait until the player is ready.")
        self.wait(lambda: self.audio()["rms"] > 0.01)
        self.page.evaluate(
            "()=>{const v=document.querySelector('video');v.playbackRate=0;v.dispatchEvent(new Event('waiting'));}"
        )
        self.wait(lambda: self.state()["paused"])
        self.wait(self.quiet)
        self.page.wait_for_timeout(350)  # Cross at least two playback polls.
        assert self.state()["paused"]
        assert not self.line()
        self.page.evaluate(
            "()=>{const v=document.querySelector('video');v.playbackRate=1;v.dispatchEvent(new Event('playing'));}"
        )
        self.wait(lambda: bool(self.line()))

    def recovered_google(self):
        self.sw.evaluate("""() => {
          self.qaTts={speak:chrome.tts.speak,getVoices:chrome.tts.getVoices,stop:chrome.tts.stop};
          chrome.tts.getVoices=cb=>cb([{voiceName:'QA Russian',lang:'ru-RU'}]);voiceCache=null;
          chrome.tts.speak=(text,opts,cb)=>{qa.browser.push(text);opts.onEvent({type:'start'});cb?.();setTimeout(()=>opts.onEvent({type:'end'}),1200);};
          chrome.tts.stop=()=>{qa.stops++;};
        }""")
        try:
            self.reset(
                "old",
                audio_mode="error",
                cues=[
                    [0, 1.4, "Browser fallback first."],
                    [1.4, 24, "Google has recovered."],
                ],
            )
            self.wait(lambda: self.sw.evaluate("()=>qa.browser.length>0"))
            before = self.sw.evaluate("()=>qa.stops")
            self.audio(mode="ok")
            self.wait(lambda: "Google has recovered." in self.line())
            self.wait(lambda: self.audio()["rms"] > 0.01)
            assert self.sw.evaluate("()=>qa.stops") > before
            assert not self.sw.evaluate("()=>ttsBusy")
        finally:
            self.sw.evaluate("()=>{Object.assign(chrome.tts,qaTts);voiceCache=null;}")

    def both_voices_fail(self):
        self.sw.evaluate("""() => {
          self.qaTts={speak:chrome.tts.speak,getVoices:chrome.tts.getVoices,stop:chrome.tts.stop};
          chrome.tts.getVoices=cb=>cb([{voiceName:'Broken Russian',lang:'ru-RU'}]);voiceCache=null;
          chrome.tts.speak=(text,opts,cb)=>{qa.browser.push(text);opts.onEvent({type:'error',errorMessage:'No OS voice'});cb?.();};
        }""")
        try:
            self.reset("Both voice services are unavailable.", audio_mode="error")
            self.wait(lambda: self.state()["status"] == "voice_error")
            assert self.line()
            assert len(self.audio()["requests"]) == 2
            assert len(self.sw.evaluate("()=>qa.browser")) == 1
            assert self.quiet()
        finally:
            self.sw.evaluate("()=>{Object.assign(chrome.tts,qaTts);voiceCache=null;}")

    def run(self):
        if LOOKAHEAD:
            self.run_lookahead()
            return
        if LATENCY:
            self.run_latency()
            return
        if LIVE_NETWORK:
            self.run_live()
            return
        for name, fn in [
            ("finalized captions translate immediately", self.immediate),
            (
                "pause aborts pending translation and rejects its late reply",
                self.pause_request,
            ),
            ("resume translates the current cue exactly once", self.resume_request),
            (
                "pause stops real scheduled audio and silences the output",
                self.pause_audio,
            ),
            ("pause during TTS fetch prevents late decoded audio", self.pause_tts),
            (
                "stalled synthesis is bounded and a fresh queued cue can recover",
                self.fresh_tts,
            ),
            (
                "a slow Google host is hedged and its late audio cannot return",
                self.hedged_audio,
            ),
            (
                "first speech chunk plays while the tail loads; pause cancels both",
                self.early_chunk,
            ),
            (
                "a prepared future cue reuses audio without early or duplicate playback",
                self.prepared_cue,
            ),
            (
                "pause cancels a future audio preparation and rejects late output",
                self.pause_preparation,
            ),
            (
                "seek rejects an old translation and shows the destination cue",
                self.seek_request,
            ),
            (
                "seek stops old audio before speaking the destination cue",
                self.seek_audio,
            ),
            ("seek while paused stays silent until playback resumes", self.seek_paused),
            (
                "Stop cancels a pending request and destroys the audio document",
                self.stop_request,
            ),
            ("Stop during real audio restores original volume", self.stop_audio),
            ("restart cannot replay an old session", self.restart),
            (
                "a slow earlier reply cannot overwrite a newer subtitle",
                self.out_of_order,
            ),
            ("a reply past its cue deadline is discarded", self.expired),
            ("rapid captions cannot accumulate a voice queue", self.no_backlog),
            (
                "speech ends within a bounded grace after its cue",
                self.speech_deadline,
            ),
            (
                "browser speech expires even if its engine never sends end",
                self.browser_deadline,
            ),
            (
                "valid long captions and speech survive the request freshness budget",
                self.long_cue,
            ),
            ("subtitles clear when a cue ends", self.subtitle_deadline),
            ("page reload resumes translation after previous pauses", self.reload),
            ("repeated pause/resume/seek remains functional", self.repeat),
            ("playback speed change clears old scheduled sound", self.ratechange),
            ("video end cancels speech", self.ended),
            ("buffering stays silent until the playing event", self.buffering),
            (
                "recovered Google follows browser fallback without overlap",
                self.recovered_google,
            ),
            (
                "both unavailable voices report an error while keeping subtitles",
                self.both_voices_fail,
            ),
            (
                "Google TTS outage falls back to browser voice; pause cancels it",
                self.browser_fallback,
            ),
            (
                "missing browser voice falls back to real Google audio playback",
                self.missing_browser,
            ),
        ]:
            self.scenario(name, fn)
        self.scenario("no uncaught page errors", lambda: self.assert_no_errors())
        self.sw.evaluate("()=>stop()")

    def original(self):
        return self.page.evaluate(
            "()=>document.querySelector('#neirotranslate-root')?.shadowRoot.querySelector('.orig').textContent || ''"
        )

    def run_latency(self):
        samples = []
        phrases = [
            "Welcome back to the stream, everyone.",
            "Today we are building a neural network from scratch.",
            "First, let's look at how a single neuron works.",
            "Then we apply an activation function to the result.",
            "Don't forget to drop your questions in the chat.",
        ]
        for index, phrase in enumerate(phrases):

            def measure(phrase=phrase):
                self.reset(phrase)
                self.wait(lambda: self.audio()["rms"] > 0.001, timeout=7000)
                now = time.time() * 1000
                info = self.audio()
                worker = self.sw.evaluate(
                    "()=>({requests:qa.requests,events:qa.events})"
                )
                shown = next(
                    event["at"]
                    for event in worker["events"]
                    if event["type"] == "NT_SUBTITLE" and event.get("text")
                )
                samples.append(
                    {
                        "phrase": phrase,
                        "cue_to_audio_ms": round(now - self.media_started_at),
                        "translation_ms": shown - worker["requests"][0]["at"],
                        "tts_to_audio_ms": round(now - info["requests"][0]["at"]),
                        "tts_requests": info["requests"],
                    }
                )
                print(json.dumps(samples[-1], ensure_ascii=False), flush=True)

            self.scenario(f"latency sample {index + 1}", measure)
        self.metrics["latency_samples"] = samples
        for field in ("cue_to_audio_ms", "translation_ms", "tts_to_audio_ms"):
            values = [sample[field] for sample in samples]
            if values:
                self.metrics[field] = {
                    "median": statistics.median(values),
                    "min": min(values),
                    "max": max(values),
                }
        self.sw.evaluate("()=>stop()")

    def run_lookahead(self):
        phrases = [
            "Welcome back to the stream, everyone.",
            "Today we are building a neural network from scratch.",
            "First, let's look at how a single neuron works.",
            "Then we apply an activation function to the result.",
            "Don't forget to drop your questions in the chat.",
        ]
        cues = [[2 + 4 * i, 5.5 + 4 * i, text] for i, text in enumerate(phrases)]
        self.reset("", mode="delay", audio_mode="delay", cues=cues)
        samples = {}
        starts = 0
        end = time.monotonic() + 25
        while len(samples) < len(cues) and time.monotonic() < end:
            info = self.audio()
            original = self.original()
            media = self.page.evaluate("document.querySelector('video').currentTime")
            if (
                info
                and info["starts"] > starts
                and info["rms"] > 0.001
                and original in phrases
                and original not in samples
            ):
                starts = info["starts"]
                delay = round((media - cues[phrases.index(original)][0]) * 1000)
                assert delay >= 0, "A future cue must not speak early"
                samples[original] = delay
                print(
                    f"TIMING cue {phrases.index(original) + 1}: {delay} ms", flush=True
                )
            self.page.wait_for_timeout(25)
        self.metrics["lookahead_cue_to_audio_ms"] = samples
        values = list(samples.values())
        if values:
            self.metrics["lookahead_median_ms"] = statistics.median(values)
        self.scenario(
            "all five known cues translate and play",
            lambda: self.assert_five_samples(samples),
        )
        self.sw.evaluate("()=>stop()")

    @staticmethod
    def assert_five_samples(samples):
        assert len(samples) == 5, f"Only {len(samples)}/5 cues produced audio"

    def live_start(self):
        self.reset("The stream is ready. Welcome everyone.")
        self.wait(lambda: any("а" <= ch.lower() <= "я" for ch in self.line()))
        self.wait(lambda: self.audio()["rms"] > 0.001)
        first = self.sw.evaluate("()=>qa.requests[0].at")
        shown = self.sw.evaluate(
            "()=>qa.events.find(e=>e.type==='NT_SUBTITLE' && e.text).at"
        )
        info = self.audio()
        self.metrics["real_translation_ms"] = shown - first
        self.metrics["real_tts_request_to_audio_ms"] = round(
            time.time() * 1000 - info["requests"][0]["at"]
        )
        assert info["context"] == "running"

    def live_seek(self):
        self.reset(
            "old",
            cues=[
                [0, 5, "We will begin the stream now."],
                [10, 24, "This is a new part of the video."],
            ],
        )
        self.wait(lambda: self.audio()["rms"] > 0.001)
        before = self.audio()
        self.seek(10)
        self.wait(
            lambda: (
                self.original() == "This is a new part of the video."
                and bool(self.line())
            )
        )
        self.wait(lambda: self.audio()["starts"] > before["starts"])
        assert self.audio()["stops"] > before["stops"]
        assert self.audio()["sources"] == 1

    def live_seek_paused(self):
        self.reset(
            "old",
            cues=[
                [0, 5, "The video will pause."],
                [10, 24, "Playback has resumed here."],
            ],
        )
        self.pause()
        self.seek(10)
        self.wait(self.quiet)
        assert not self.line()
        self.play()
        self.wait(
            lambda: (
                self.original() == "Playback has resumed here." and bool(self.line())
            )
        )

    def live_reload(self):
        self.reset("A video before page reload.")
        self.pause()
        self.page.reload()
        self.page.wait_for_function("document.querySelector('video').readyState>=2")
        self.page.wait_for_selector("#neirotranslate-root", state="attached")
        self.page.evaluate(
            "()=>{track.addCue(new VTTCue(0,24,'Translation works after page reload.'));document.querySelector('video').play();}"
        )
        self.wait(
            lambda: (
                self.original() == "Translation works after page reload."
                and bool(self.line())
            )
        )

    def run_live(self):
        for name, fn in [
            (
                "real free translation decodes and plays real Google voice",
                self.live_start,
            ),
            ("pause silences real Google speech", self.pause_audio),
            (
                "seek stops real speech and translates the destination cue",
                self.live_seek,
            ),
            (
                "seek while paused resumes at the destination with real translation",
                self.live_seek_paused,
            ),
            (
                "Stop destroys real playback and restores original volume",
                self.stop_audio,
            ),
            ("page reload resumes real translation after pausing", self.live_reload),
            ("repeated pause/resume/seek with real services", self.repeat),
            ("speed change cancels real Google speech", self.ratechange),
            ("video end stops real Google speech", self.ended),
        ]:
            self.scenario(name, fn)
        self.scenario("no uncaught page errors", self.assert_no_errors)
        self.sw.evaluate("()=>stop()")

    def assert_no_errors(self):
        assert not self.errors, self.errors


def main():
    REPORT.parent.mkdir(exist_ok=True)
    with (
        tempfile.TemporaryDirectory(
            prefix="nt-playback-", ignore_cleanup_errors=True
        ) as scratch,
        sync_playwright() as p,
    ):
        ext = Path(scratch) / "ext"
        ext.mkdir()
        if "--release" in sys.argv:
            release = Path(sys.argv[sys.argv.index("--release") + 1])
            with zipfile.ZipFile(release) as archive:
                for name in archive.namelist():
                    if name == "manifest.json" or name.startswith(("src/", "assets/")):
                        assert (
                            ".." not in Path(name).parts
                            and not Path(name).is_absolute()
                        )
                        archive.extract(name, ext)
        else:
            for name in ("manifest.json", "src", "assets"):
                src = ROOT / name
                (shutil.copytree if src.is_dir() else shutil.copy)(src, ext / name)
        manifest = json.loads((ext / "manifest.json").read_text(encoding="utf-8"))
        manifest["host_permissions"].append(ORIGIN + "/*")
        (ext / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        shutil.copy(
            ROOT / "tests/fixtures/audio-probe.js", ext / "src/offscreen/audio-probe.js"
        )
        html = ext / "src/offscreen/offscreen.html"
        html.write_text(
            html.read_text().replace(
                "</body>", '<script src="audio-probe.js"></script></body>'
            )
        )
        ctx = p.chromium.launch_persistent_context(
            str(Path(scratch) / "profile"),
            channel="chromium",
            headless=True,
            args=[
                f"--disable-extensions-except={ext}",
                f"--load-extension={ext}",
                "--autoplay-policy=no-user-gesture-required",
            ],
            viewport={"width": 1100, "height": 720},
        )

        def serve(route):
            if route.request.url.endswith("/demo.webm"):
                route.fulfill(
                    content_type="video/webm",
                    body=(ROOT / "tests/fixtures/demo.webm").read_bytes(),
                )
            else:
                route.fulfill(content_type="text/html", body=PAGE)

        try:
            ctx.route(ORIGIN + "/**", serve)
            sw = (
                ctx.service_workers[0]
                if ctx.service_workers
                else ctx.wait_for_event("serviceworker")
            )
            # Install navigation must finish before creating a test video tab.
            end = time.monotonic() + 30
            while not any(
                pg.url.endswith("/src/options/options.html") for pg in ctx.pages
            ):
                assert time.monotonic() < end, "Settings did not open after install"
                ctx.pages[0].wait_for_timeout(25)
            suite = Suite(ctx, sw)
            suite.run()
            report = {
                "extension_version": manifest["version"],
                "browser": ctx.browser.version,
                "provider_mode": "real free translation providers and Google TTS"
                if LIVE_NETWORK
                else "HTTP fixtures; real video, decode and WebAudio",
                "results": suite.results,
                "metrics": suite.metrics,
            }
            REPORT.write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        finally:
            ctx.close()
    passed = sum(row["passed"] for row in report["results"])
    print(f"\n{passed}/{len(report['results'])} checks passed; {REPORT}")
    print(json.dumps(report["metrics"], ensure_ascii=False))
    return 0 if passed == len(report["results"]) else 1


if __name__ == "__main__":
    sys.exit(main())
