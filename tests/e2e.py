"""End-to-end test: loads the unpacked extension into Playwright Chromium, plays a demo video with
English WebVTT captions, runs the FREE pipeline (page subtitles -> Google Translate -> Google voice)
and checks the translated overlay, ducking of the original audio, stop/cleanup and stats recording.
It also opens a Gemini Live socket with a fake key to verify the endpoint/setup handshake path.

Run: python tools/make-demo-media.py, then python tests/e2e.py [--screens] [--live-network]
Provider fixtures are used by default. --live-network uses actual free endpoints.
Screenshots go to docs/screenshots/ with --screens.
"""

import json
import shutil
import sys
import tempfile
import time
import io
import math
import struct
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
SHOTS = ROOT / "docs" / "screenshots"
SCREENS = "--screens" in sys.argv
LIVE_NETWORK = "--live-network" in sys.argv
sys.stdout.reconfigure(encoding="utf-8")
DEMO = "https://demo.neirotranslate.test"

TRANSLATIONS = {
    "Welcome back to the stream, everyone.": "С возвращением на стрим!",
    "Today we are building a neural network from scratch.": "Сегодня мы создаём нейросеть с нуля.",
    "First, let's look at how a single neuron works.": "Сначала разберёмся, как работает один нейрон.",
    "It takes inputs, multiplies them by weights, and adds a bias.": "Он умножает входные данные на веса и добавляет смещение.",
    "Then we apply an activation function to the result.": "Затем применяем к результату функцию активации.",
    "Stack enough of these layers and the model starts to learn.": "Несколько таких слоёв — и модель начинает учиться.",
    "Don't forget to drop your questions in the chat.": "Задавайте вопросы в чате.",
    "Alright, let's write some code together.": "Давайте вместе напишем код.",
}


def fixture_audio():
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(
            b"".join(
                struct.pack("<h", int(math.sin(i * 2 * math.pi * 330 / 24000) * 1600))
                for i in range(24000)
            )
        )
    return out.getvalue()


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Dev stream #42</title>
<style>body{margin:0;background:#0b0b10;font-family:Segoe UI,sans-serif;color:#fff}
.wrap{max-width:1120px;margin:24px auto;padding:0 24px}video{width:100%;border-radius:14px;display:block;background:#000}
h1{font-size:22px;margin:16px 0 4px}p{color:#9a9ab0;margin:0}</style></head>
<body><div class="wrap"><video id="v" src="/demo.webm" autoplay loop playsinline crossorigin="anonymous">
<track kind="subtitles" srclang="en" label="English" src="/demo.vtt" default></video>
<h1>Building a neural network from scratch — live</h1><p>Dev stream · Episode 42 · 12 480 watching</p></div></body></html>"""


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))
    return ok


def run(tmp):
    ext = tmp / "ext"
    ext.mkdir(parents=True)
    for item in ("manifest.json", "src", "assets"):
        src = ROOT / item
        (shutil.copytree if src.is_dir() else shutil.copy)(src, ext / item)
    # Automation cannot click the toolbar button (activeTab), so grant host access in the test copy only.
    manifest = json.loads((ext / "manifest.json").read_text(encoding="utf-8"))
    manifest["host_permissions"].append("<all_urls>")
    (ext / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    results = []
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(tmp / "profile"),
            channel="chromium",
            headless=True,
            viewport={"width": 1280, "height": 860},
            args=[
                f"--disable-extensions-except={ext}",
                f"--load-extension={ext}",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )

        def serve(route):
            path = route.request.url.split(DEMO, 1)[1].split("?")[0]
            if path in ("/", "/index.html"):
                return route.fulfill(status=200, content_type="text/html", body=PAGE)
            if path == "/demo.webm":
                return route.fulfill(
                    status=200,
                    content_type="video/webm",
                    body=(FIX / "demo.webm").read_bytes(),
                    headers={"Access-Control-Allow-Origin": "*"},
                )
            if path == "/demo.vtt":
                return route.fulfill(
                    status=200,
                    content_type="text/vtt",
                    body=(FIX / "demo.vtt").read_text(encoding="utf-8"),
                    headers={"Access-Control-Allow-Origin": "*"},
                )
            return route.fulfill(status=404, body="")

        ctx.route(DEMO + "/**", serve)

        if not LIVE_NETWORK:
            ctx.route(
                "https://translate.google.com/translate_tts**",
                lambda route: route.fulfill(
                    status=200, content_type="audio/wav", body=fixture_audio()
                ),
            )

            def gemini_fixture(socket):
                def receive(message):
                    data = json.loads(message)
                    if "setup" in data:
                        setup = data["setup"]
                        assert setup["model"].startswith("models/")
                        assert (
                            setup["generationConfig"]["translationConfig"][
                                "targetLanguageCode"
                            ]
                            == "ru"
                        )
                        socket.send(
                            json.dumps({"error": {"message": "API key not valid"}})
                        )

                socket.on_message(receive)

            ctx.route_web_socket(
                "wss://generativelanguage.googleapis.com/**", gemini_fixture
            )

        sw = (
            ctx.service_workers[0]
            if ctx.service_workers
            else ctx.wait_for_event("serviceworker", timeout=15000)
        )
        ext_id = sw.url.split("/")[2]
        errors = []
        if not LIVE_NETWORK:
            sw.evaluate(
                """(translations) => {
              const realFetch = globalThis.fetch;
              globalThis.fetch = async (url, options) => {
                if (String(url).startsWith('https://translate.googleapis.com/')) {
                  const q = new URL(url).searchParams.get('q');
                  return new Response(JSON.stringify([[[translations[q] || ('Перевод: ' + q)]], null, 'en']), {status:200});
                }
                return realFetch(url, options);
              };
            }""",
                TRANSLATIONS,
            )

        # Wait for install's Settings navigation before taking ownership of a tab.
        # openOptionsPage can reuse any active blank tab, including a new test page.
        install_deadline = time.monotonic() + 10
        while not any(pg.url.endswith("/src/options/options.html") for pg in ctx.pages):
            if time.monotonic() >= install_deadline:
                raise RuntimeError("Extension did not open Settings after installation")
            ctx.pages[0].wait_for_timeout(50)
        for pg in ctx.pages:
            if pg.url.startswith("chrome-extension://"):
                pg.close()  # options page opened on install
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append("page: " + str(e)))
        page.goto(DEMO + "/")
        page.wait_for_function(
            "document.getElementById('v').readyState >= 2", timeout=15000
        )
        page.evaluate("""() => { const v = document.getElementById('v'); v.volume = 0.8; v.currentTime = 0; v.play();
            window.__vol = []; setInterval(() => window.__vol.push(v.volume), 100); }""")

        sw.evaluate("""() => chrome.storage.local.set({ source: 'captions', voice: 'google', targetLang: 'ru',
            uiLang: 'ru', originalVolume: 0.25, showOriginal: true })""")
        tab_id = sw.evaluate(
            f"async () => (await chrome.tabs.query({{ url: '{DEMO}/*' }}))[0].id"
        )
        res = sw.evaluate("(id) => start(id)", tab_id)
        results.append(
            check(
                "start() in free captions mode",
                bool(res and res.get("ok")),
                json.dumps(res),
            )
        )

        lines = []
        deadline = time.time() + 16
        while time.time() < deadline:
            txt = page.evaluate("""() => { const r = document.getElementById('neirotranslate-root');
                return r && r.shadowRoot ? r.shadowRoot.querySelector('.line').textContent : null; }""")
            if txt and txt not in lines:
                lines.append(txt)
            time.sleep(0.3)
        cyrillic = [t for t in lines if any("а" <= ch.lower() <= "я" for ch in t)]
        results.append(
            check(
                "overlay shows Russian translation of the captions",
                len(cyrillic) >= 2,
                " | ".join(lines[:5]),
            )
        )

        st = sw.evaluate("() => state")
        results.append(
            check(
                "status is 'translating'", st["status"] == "translating", st["status"]
            )
        )

        vols = page.evaluate("() => window.__vol")
        results.append(
            check(
                "original audio is ducked while the voice-over speaks",
                min(vols) < 0.5 and max(vols) > 0.7,
                f"min={min(vols):.2f} max={max(vols):.2f}",
            )
        )
        native_hidden = page.evaluate(
            "() => getComputedStyle(document.getElementById('v')).display !== 'none' && document.getElementById('v').textTracks[0].mode"
        )
        results.append(
            check(
                "native <track> captions hidden (mode=hidden)",
                native_hidden == "hidden",
                str(native_hidden),
            )
        )

        if SCREENS:
            SHOTS.mkdir(parents=True, exist_ok=True)
            page.wait_for_function(
                """() => { const r = document.getElementById('neirotranslate-root');
                return r && r.shadowRoot.querySelector('.line').textContent.length > 20 &&
                       !r.shadowRoot.querySelector('.subs').classList.contains('hidden'); }""",
                timeout=10000,
            )
            page.screenshot(path=str(SHOTS / "player-overlay.png"))

            popup = ctx.new_page()
            popup.on("pageerror", lambda e: errors.append("popup: " + str(e)))
            popup.set_viewport_size({"width": 400, "height": 660})
            popup.goto(
                f"chrome-extension://{ext_id}/src/popup/popup.html?tabId={tab_id}"
            )
            popup.wait_for_timeout(2500)
            popup.locator(".app").screenshot(path=str(SHOTS / "popup-live.png"))
            popup.close()

        # Live settings must affect the actual player, including native track restoration.
        sw.evaluate(
            "() => chrome.storage.local.set({ hideNativeCaptions: false, showOriginal: false })"
        )
        page.wait_for_timeout(650)
        original_hidden = page.evaluate(
            "() => document.getElementById('neirotranslate-root').shadowRoot.querySelector('.orig').textContent === ''"
        )
        native_restored = page.evaluate(
            "() => document.getElementById('v').textTracks[0].mode === 'showing'"
        )
        results.append(
            check(
                "live settings hide original text and restore native captions",
                original_hidden and native_restored,
            )
        )
        sw.evaluate(
            "() => chrome.storage.local.set({ hideNativeCaptions: true, showOriginal: true })"
        )

        sw.evaluate("() => stop()")
        time.sleep(1.0)
        gone = page.evaluate("() => !document.getElementById('neirotranslate-root')")
        restored = page.evaluate("() => document.getElementById('v').volume")
        results.append(
            check(
                "stop() removes overlay and restores volume",
                gone and abs(restored - 0.8) < 0.05,
                f"volume={restored:.2f}",
            )
        )
        sessions = sw.evaluate(
            "async () => (await chrome.storage.local.get('nt_sessions')).nt_sessions || []"
        )
        results.append(
            check(
                "session recorded in stats",
                len(sessions) >= 1 and sessions[0]["source"] == "captions",
                json.dumps(sessions[:1], ensure_ascii=False),
            )
        )

        # Repeat start and stop in the middle of a ducking ramp.
        sw.evaluate("() => chrome.storage.local.set({voice:'off'})")
        sw.evaluate("(id) => start(id)", tab_id)
        page.wait_for_timeout(200)
        sw.evaluate(
            "(id) => chrome.tabs.sendMessage(id, {type:'NT_C_DUCK', on:true})", tab_id
        )
        page.wait_for_timeout(50)
        sw.evaluate("() => stop()")
        page.wait_for_timeout(500)
        results.append(
            check(
                "stop during volume ramp restores the original level",
                abs(page.evaluate("() => document.getElementById('v').volume") - 0.8)
                < 0.01,
            )
        )

        # Check popup controls and persistence through user interactions.
        controls = ctx.new_page()
        controls.on("pageerror", lambda e: errors.append("popup: " + str(e)))
        controls.set_viewport_size({"width": 400, "height": 660})
        controls.goto(
            f"chrome-extension://{ext_id}/src/popup/popup.html?tabId={tab_id}"
        )
        controls.wait_for_function(
            "document.querySelectorAll('#targetLang option').length > 10"
        )
        controls.select_option("#voiceSelect", "off")
        controls.select_option("#targetLang", "de")
        controls.wait_for_timeout(250)
        saved = sw.evaluate(
            "async () => await chrome.storage.local.get(['voice','targetLang'])"
        )
        results.append(
            check(
                "voice and language controls persist settings",
                saved == {"voice": "off", "targetLang": "de"},
            )
        )
        controls.locator("label.source").nth(1).click()
        controls.wait_for_timeout(250)
        results.append(
            check(
                "Gemini without a key shows an actionable message",
                controls.locator("#problem").is_visible()
                and controls.locator("#toggleBtn").is_disabled(),
            )
        )
        controls.locator("label.source").nth(0).click()
        controls.select_option("#targetLang", "ru")
        controls.locator(".mixer summary").click()
        controls.locator("#origVol").fill("35")
        controls.wait_for_timeout(250)
        results.append(
            check(
                "mixer expands and saves volume",
                sw.evaluate(
                    "async () => (await chrome.storage.local.get('originalVolume')).originalVolume"
                )
                == 0.35,
            )
        )

        # Exercise Stop through the popup while the worker is awaiting a page reply.
        sw.evaluate("""() => {
          const nativeSend = chrome.tabs.sendMessage.bind(chrome.tabs);
          self.__restoreTabs = () => {chrome.tabs.sendMessage = nativeSend;};
          chrome.tabs.sendMessage = (id, message, ...args) => message.type === 'NT_PING'
            ? new Promise(resolve => {self.__releasePing = resolve;}) : nativeSend(id, message, ...args);
        }""")
        controls.locator("#toggleBtn").click()
        controls.wait_for_function(
            "async () => (await chrome.runtime.sendMessage({type:'NT_GET_STATE'})).state.status === 'starting'"
        )
        held = sw.evaluate("() => typeof self.__releasePing === 'function'")
        controls.locator("#toggleBtn").click()
        controls.wait_for_function(
            "async () => !(await chrome.runtime.sendMessage({type:'NT_GET_STATE'})).state.active"
        )
        results.append(
            check(
                "popup Stop cancels startup before the page replies",
                held and page.locator("#neirotranslate-root").count() == 0,
            )
        )
        sw.evaluate(
            "() => {self.__restoreTabs(); self.__releasePing({ok:true}); delete self.__restoreTabs; delete self.__releasePing;}"
        )
        controls.locator("#toggleBtn").click()
        page.wait_for_selector("#neirotranslate-root", state="attached")
        results.append(
            check(
                "popup can start a fresh session after cancellation",
                sw.evaluate("() => state.active"),
            )
        )
        controls.locator("#toggleBtn").click()
        controls.wait_for_function(
            "async () => !(await chrome.runtime.sendMessage({type:'NT_GET_STATE'})).state.active"
        )
        controls.close()

        # A fake key or unavailable network must surface an actionable error.
        # A timeout verifies failure handling, not that the server validated the key.
        opt = ctx.new_page()
        opt.on("pageerror", lambda e: errors.append("options: " + str(e)))
        opt.goto(f"chrome-extension://{ext_id}/src/options/options.html")
        opt.wait_for_timeout(800)
        results.append(
            check(
                "paired settings have their own accessible labels",
                opt.get_by_label("Положение", exact=True).count() == 1
                and opt.get_by_label("ID каталога (для IAM-токена)", exact=True).count()
                == 1,
            )
        )
        gem = opt.evaluate("""() => new Promise(async (resolve) => {
            if (!self.NtGeminiLive) await new Promise((ok) => { const s = document.createElement('script'); s.src = '../offscreen/gemini-live.js'; s.onload = ok; document.head.appendChild(s); });
            const events = [];
            const g = new NtGeminiLive({ apiKey: 'invalid-test-key', targetLang: 'ru', targetName: 'Russian',
              onStatus: (c) => events.push('status:' + c), onFatal: (d) => { events.push('fatal:' + d); g.close(); resolve(events); },
              onAudio: () => {}, onTranscript: () => {} });
            g.connect();
            setTimeout(() => { g.close(); resolve(events.concat('timeout')); }, 20000);
        })""")
        fatal = [e for e in gem if e.startswith("fatal:")]
        results.append(
            check(
                "Gemini Live: key/connection failure ends in a clear error",
                bool(fatal) and "timeout" not in gem,
                " ".join(gem),
            )
        )

        if SCREENS:
            opt.set_viewport_size({"width": 1280, "height": 960})
            opt.reload()
            opt.wait_for_timeout(1200)
            opt.screenshot(path=str(SHOTS / "options.png"), full_page=True)
            # Fake history only for the stats screenshot.
            sw.evaluate("""() => { const now = Date.now(); const langs = ['ru','ru','ru','en','uk','de']; const doms = ['youtube.com','twitch.tv','kick.com','vimeo.com','netflix.com'];
                const list = []; let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
                for (let i = 0; i < 160; i++) { const day = Math.floor(rnd() * 300); const t = now - day * 864e5 - Math.floor(rnd() * 864e5);
                  list.push({ id: 'x' + i, startTime: t, durationSec: 300 + Math.floor(rnd() * 4200), lang: langs[i % langs.length],
                    domain: doms[Math.floor(rnd() * doms.length)], source: rnd() > .45 ? 'gemini' : 'captions', voice: ['gemini','google','browser','elevenlabs','off'][i % 5] }); }
                return chrome.storage.local.set({ nt_sessions: list }); }""")
            stats = ctx.new_page()
            stats.on("pageerror", lambda e: errors.append("stats: " + str(e)))
            stats.set_viewport_size({"width": 1180, "height": 900})
            stats.goto(f"chrome-extension://{ext_id}/src/stats/stats.html")
            stats.wait_for_timeout(1200)
            stats.screenshot(path=str(SHOTS / "stats.png"), full_page=True)
            sw.evaluate("() => chrome.storage.local.set({ nt_sessions: [] })")

            # Idle popup (English UI) for the README.
            sw.evaluate(
                "() => chrome.storage.local.set({ uiLang: 'en', source: 'gemini', voice: 'gemini', geminiApiKey: 'demo' })"
            )
            pop2 = ctx.new_page()
            pop2.set_viewport_size({"width": 400, "height": 660})
            pop2.goto(
                f"chrome-extension://{ext_id}/src/popup/popup.html?tabId={tab_id}"
            )
            pop2.wait_for_timeout(1500)
            pop2.locator(".app").screenshot(path=str(SHOTS / "popup-idle-en.png"))
            sw.evaluate("() => chrome.storage.local.set({ geminiApiKey: '' })")

        results.append(
            check(
                "no uncaught errors in extension pages", not errors, "; ".join(errors)
            )
        )
        ctx.close()

    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


def main():
    with tempfile.TemporaryDirectory(
        prefix="nt-e2e-", ignore_cleanup_errors=True
    ) as scratch:
        return run(Path(scratch))


if __name__ == "__main__":
    sys.exit(main())
