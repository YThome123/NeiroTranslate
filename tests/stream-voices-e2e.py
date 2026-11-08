"""Regression for YouTube-style streaming DOM captions and live voice switching.

Uses real extension/video/WebAudio with locally reproduced YouTube caption DOM.
HTTP and chrome.tts are fixtures by default; --live-network uses real free APIs.
Does not test a public broadcast, installed Windows voice or a real Gemini key.
Run: python tests/stream-voices-e2e.py [--live-network]
"""

import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "nt_playback", Path(__file__).with_name("playback-e2e.py")
)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.ORIGIN = "https://www.youtube.com"
base.REPORT = base.ROOT / "test-results" / "stream-voices.json"
base.PAGE = """<!doctype html><html lang="en"><meta charset="utf-8"><title>Streaming captions QA</title>
<body><div id="movie_player" class="html5-video-player">
<video id="v" controls playsinline style="width:800px;height:450px"></video>
<button class="ytp-subtitles-button" aria-pressed="true">CC</button>
<div class="ytp-caption-window-container"><div class="caption-window" lang="en"><span class="caption-visual-line"></span></div></div></div>
<script>window.track=document.querySelector('video').addTextTrack('subtitles','English','en');track.mode='hidden';
track.oncuechange=()=>{document.querySelector('.caption-visual-line').textContent=[...track.activeCues].map(c=>c.text).join(' ');};
fetch('/demo.webm').then(r=>r.blob()).then(b=>{document.querySelector('video').src=URL.createObjectURL(b);});</script></body></html>"""


class StreamSuite(base.Suite):
    audio_duration = 1.4

    def __init__(self, ctx, sw):
        super().__init__(ctx, sw)
        self.sw.evaluate("""() => {
          qa.browserSpeech=[];qa.browserActive=false;qa.browserCurrent=null;qa.interruptions=0;qa.failBrowser=false;
          qa.browserDuration=1400;qa.browserEndedAt=null;
          chrome.tts.getVoices=cb=>cb([{voiceName:'QA Russian',lang:'ru-RU',remote:false}]);voiceCache=null;
          chrome.tts.isSpeaking=cb=>cb(qa.browserActive);
          chrome.tts.stop=()=>{
            if(qa.browserCurrent){clearTimeout(qa.browserCurrent.timer);qa.interruptions++;}
            qa.browserCurrent=null;qa.browserActive=false;
          };
          chrome.tts.speak=(text,options,callback)=>{
            if(qa.failBrowser){options.onEvent({type:'error',errorMessage:'Voice unavailable'});callback?.();return;}
            const job={text,options};qa.browserSpeech.push(text);qa.browserCurrent=job;qa.browserActive=true;
            options.onEvent({type:'start'});callback?.();
            job.timer=setTimeout(()=>{
              if(qa.browserCurrent!==job)return;
              qa.browserCurrent=null;qa.browserActive=false;qa.browserEndedAt=Date.now();options.onEvent({type:'end',charIndex:text.length});
            },qa.browserDuration);
          };
        }""")

    def reset(self, text, voice="google", audio_mode="ok", cues=None, **kwargs):
        self.sw.evaluate("()=>stop()")
        self.sw.evaluate(
            "()=>{qa.browserSpeech=[];qa.interruptions=0;qa.failBrowser=false;}"
        )
        self.page.evaluate("""()=>{
          const v=document.querySelector('video');v.pause();v.currentTime=0;v.playbackRate=0;v.volume=.8;
          for(const cue of [...track.cues])track.removeCue(cue);
          document.querySelector('.caption-visual-line').textContent='';
        }""")
        self.page.wait_for_function("!document.querySelector('video').seeking")
        self.sw.evaluate(
            """async ({voice,live})=>{
          qa.mode=live?'live':'ok';qa.requests=[];qa.events=[];
          await chrome.storage.local.set({source:'captions',voice,targetLang:'ru',uiLang:'ru',originalVolume:.25,dubVolume:1,showOriginal:true});
        }""",
            {"voice": voice, "live": base.LIVE_NETWORK},
        )
        self.page.evaluate("()=>document.querySelector('video').play()")
        result = self.sw.evaluate("id=>start(id)", self.tab)
        assert result.get("ok"), result
        if voice == "google":
            self.audio(
                mode="live" if base.LIVE_NETWORK else audio_mode,
                duration=self.audio_duration,
            )
        phrase = cues[0][2] if cues else text
        self.caption(phrase)
        self.wait(
            lambda: bool(self.line()), timeout=7000 if base.LIVE_NETWORK else 4000
        )

    def popup(self):
        page = self.ctx.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        ext = self.sw.url.split("/")[2]
        page.goto(f"chrome-extension://{ext}/src/popup/popup.html?tabId={self.tab}")
        page.wait_for_function(
            "document.querySelectorAll('#targetLang option').length>10"
        )
        return page

    def hold_clock(self):
        # Drive live DOM caption updates independently of the demo codec. Keep
        # the real player's paused flag false; pause/seek tests use normal video.
        if self.page.evaluate("document.querySelector('video').playbackRate") == 0:
            return
        version = self.state()["mediaVersion"]
        self.page.evaluate("()=>{document.querySelector('video').playbackRate=0;}")
        self.wait(
            lambda: (
                self.state()["mediaVersion"] > version and not self.state()["paused"]
            )
        )

    def caption(self, text):
        self.page.evaluate(
            "text=>{document.querySelector('.caption-visual-line').textContent=text;}",
            text,
        )

    def no_key_escape(self):
        self.sw.evaluate("()=>stop()")
        self.sw.evaluate(
            "()=>chrome.storage.local.set({source:'gemini',voice:'gemini',geminiApiKey:''})"
        )
        popup = self.popup()
        try:
            popup.select_option("#voiceSelect", "google")
            self.wait(
                lambda: self.sw.evaluate(
                    "async()=>{const s=await ntGetSettings();return s.source==='captions'&&s.voice==='google';}"
                )
            )
            popup.wait_for_function("!document.querySelector('#toggleBtn').disabled")
            assert popup.locator("input[name=source][value=captions]").is_checked()
        finally:
            popup.close()

    def active_gemini_escape(self):
        self.sw.evaluate("()=>stop()")
        revision = self.sw.evaluate("()=>settingsRevision")
        self.sw.evaluate(
            "()=>chrome.storage.local.set({source:'gemini',voice:'gemini',geminiApiKey:''})"
        )
        self.wait(lambda: self.sw.evaluate("()=>settingsRevision") > revision)
        self.sw.evaluate(
            "id=>{state={...IDLE_STATE,active:true,tabId:id,source:'gemini',voice:'gemini',sessionId:'qa-gemini'};saveState();}",
            self.tab,
        )
        popup = self.popup()
        try:
            assert popup.locator("input[name=source][value=captions]").is_enabled()
            popup.locator("label.source").nth(0).click()
            self.wait(
                lambda: self.state()["active"] and self.state()["source"] == "captions"
            )
            assert self.state()["voice"] == "browser"
        finally:
            popup.close()

    def rapid_restart_choice(self):
        self.sw.evaluate("()=>stop()")
        revision = self.sw.evaluate("()=>settingsRevision")
        self.sw.evaluate(
            "()=>chrome.storage.local.set({source:'gemini',voice:'gemini',geminiApiKey:''})"
        )
        self.wait(lambda: self.sw.evaluate("()=>settingsRevision") > revision)
        self.sw.evaluate(
            "id=>{state={...IDLE_STATE,active:true,tabId:id,source:'gemini',voice:'gemini',sessionId:'qa-rapid'};saveState();}",
            self.tab,
        )
        popup = self.popup()
        self.sw.evaluate("""()=>{
          self.qaRealGet=ntGetSettings;self.qaHoldOnce=true;
          ntGetSettings=async()=>{
            const snapshot=await qaRealGet();
            if(qaHoldOnce&&!state.active){qaHoldOnce=false;await new Promise(resolve=>{self.qaReleaseSettings=resolve;});}
            return snapshot;
          };
        }""")
        try:
            popup.locator("label.source").nth(0).click()
            self.wait(
                lambda: self.sw.evaluate("()=>typeof qaReleaseSettings==='function'")
            )
            popup.select_option("#voiceSelect", "google")
            popup.wait_for_function(
                "async()=>{const s=await ntGetSettings();return s.voice==='google';}"
            )
            self.sw.evaluate("()=>qaReleaseSettings()")
            self.wait(
                lambda: (
                    self.state()["active"]
                    and self.state()["source"] == "captions"
                    and self.state()["voice"] == "google"
                )
            )
            assert popup.locator("#voiceSelect").input_value() == "google"
        finally:
            self.sw.evaluate(
                "()=>{ntGetSettings=qaRealGet;self.qaReleaseSettings?.();delete self.qaReleaseSettings;}"
            )
            popup.close()

    def google_continuity(self):
        self.reset("First full sentence.")
        self.hold_clock()
        self.wait(lambda: self.audio()["rms"] > 0.01)
        before = self.audio()
        self.caption("Second full sentence.")
        self.wait(lambda: "Second full sentence." in self.line())
        self.page.wait_for_timeout(100)
        after = self.audio()
        assert after["starts"] == before["starts"], after
        assert after["immediateStops"] == before["immediateStops"], after
        assert self.sw.evaluate("()=>voiceQueue.pendingCount") == 1
        self.wait(lambda: self.audio()["starts"] > before["starts"])
        assert self.audio()["sources"] == 1

    def browser_continuity(self):
        self.reset("Browser first sentence.", voice="browser")
        self.hold_clock()
        self.wait(lambda: self.sw.evaluate("()=>qa.browserActive"))
        before = len(self.sw.evaluate("()=>qa.browserSpeech"))
        interruptions = self.sw.evaluate("()=>qa.interruptions")
        self.caption("Browser second sentence.")
        self.wait(lambda: "Browser second sentence." in self.line())
        assert len(self.sw.evaluate("()=>qa.browserSpeech")) == before
        assert self.sw.evaluate("()=>qa.interruptions") == interruptions
        self.wait(lambda: self.sw.evaluate("()=>qa.browserSpeech.length") == before + 1)
        assert self.sw.evaluate("()=>qa.interruptions") == interruptions

    def switch_voices(self):
        self.reset("Switch this current sentence.")
        self.wait(lambda: self.audio()["rms"] > 0.01)
        popup = self.popup()
        try:
            popup.select_option("#voiceSelect", "browser")
            self.wait(
                lambda: (
                    self.state()["voice"] == "browser"
                    and self.sw.evaluate("()=>qa.browserActive")
                )
            )
            before = self.audio()["starts"]
            popup.select_option("#voiceSelect", "google")
            self.wait(
                lambda: (
                    self.state()["voice"] == "google"
                    and self.audio()["starts"] > before
                )
            )
            assert self.sw.evaluate("()=>qa.browserActive") is False
            assert self.state()["source"] == "captions"
            assert popup.locator("#voiceSelect").input_value() == "google"
        finally:
            popup.close()

    def pause_pending(self):
        self.reset(
            "first",
            cues=[
                [0, 0.6, "Speaking before pause."],
                [0.6, 2.5, "Queued before pause."],
                [2.5, 20, "Destination after seek."],
            ],
        )
        self.wait(lambda: self.audio()["rms"] > 0.01)
        self.caption("Queued before pause.")
        self.wait(lambda: self.sw.evaluate("()=>voiceQueue.pendingCount") > 0)
        before = self.audio()["starts"]
        self.pause()
        self.wait(self.quiet)
        assert self.sw.evaluate("()=>voiceQueue.pendingCount") == 0
        self.seek(3)
        self.caption("Destination after seek.")
        self.page.wait_for_timeout(250)
        assert self.audio()["starts"] == before
        self.play()
        self.wait(lambda: "Destination after seek." in self.line())
        self.wait(lambda: self.audio()["starts"] > before)

    def recover_google(self):
        previous = self.sw.evaluate("()=>qa.browserDuration")
        self.sw.evaluate("()=>{qa.browserDuration=700;qa.browserEndedAt=null;}")
        try:
            self.reset("Fallback first sentence.", audio_mode="error")
            self.hold_clock()
            self.wait(lambda: self.sw.evaluate("()=>qa.browserActive"))
            interruptions = self.sw.evaluate("()=>qa.interruptions")
            self.audio(mode="ok")
            self.caption("Recovered Google sentence.")
            self.wait(lambda: "Recovered Google sentence." in self.line())
            assert self.sw.evaluate("()=>qa.interruptions") == interruptions
            self.wait(lambda: self.audio()["rms"] > 0.01)
            assert self.sw.evaluate("()=>qa.browserActive") is False
            assert self.sw.evaluate("()=>qa.interruptions") == interruptions
            ended = self.sw.evaluate("()=>qa.browserEndedAt")
            assert ended is not None
            assert self.audio()["sourceStarts"][0]["startAt"] >= ended
        finally:
            self.sw.evaluate("duration=>qa.browserDuration=duration", previous)

    def real_google_stream(self):
        self.reset("Welcome to our stream.")
        self.wait(lambda: self.audio()["rms"] > 0.001, timeout=7000)
        before = self.audio()
        self.caption("We continue with another sentence.")
        self.wait(
            lambda: (
                self.original() == "We continue with another sentence."
                and bool(self.line())
            )
        )
        self.wait(lambda: self.audio()["starts"] > before["starts"], timeout=8000)
        assert self.audio()["immediateStops"] == before["immediateStops"]
        self.pause()
        self.wait(self.quiet)
        assert self.sw.evaluate("()=>voiceQueue.pendingCount") == 0

    def run(self):
        if base.LIVE_NETWORK:
            self.scenario(
                "real translation and Google audio process successive DOM captions without cutting speech",
                self.real_google_stream,
            )
            self.scenario("no uncaught page errors", self.assert_no_errors)
            self.sw.evaluate("()=>stop()")
            return
        for name, fn in [
            ("Google choice exits keyless Gemini configuration", self.no_key_escape),
            (
                "active Gemini source can switch to actual captions mode",
                self.active_gemini_escape,
            ),
            (
                "rapid voice selection during mode restart keeps the latest choice",
                self.rapid_restart_choice,
            ),
            (
                "Google speech survives the next short YouTube-style cue",
                self.google_continuity,
            ),
            (
                "browser speech finishes phrases across short streaming cues",
                self.browser_continuity,
            ),
            (
                "Google and browser voices switch immediately on the current cue",
                self.switch_voices,
            ),
            (
                "pause clears active and queued speech; seek resumes at fresh text",
                self.pause_pending,
            ),
            (
                "Google recovery waits for browser fallback completion",
                self.recover_google,
            ),
        ]:
            self.scenario(name, fn)
        self.scenario("no uncaught page errors", self.assert_no_errors)
        self.sw.evaluate("()=>stop()")


base.Suite = StreamSuite
if base.LIVE_NETWORK:
    base.REPORT = base.ROOT / "test-results" / "stream-voices-live.json"
if __name__ == "__main__":
    sys.exit(base.main())
