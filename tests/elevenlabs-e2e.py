"""ElevenLabs UI and streaming contract tests in Chromium, using no paid account.

HTTP/WebSocket fixtures supply PCM; rendering, storage, WebAudio and UI are real.
This verifies our integration, not the provider's live output or voice quality.
Run: python tests/elevenlabs-e2e.py [--screens]
"""

import base64
import json
import math
import shutil
import struct
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8")
PCM = b"".join(
    struct.pack("<h", round(math.sin(i * 2 * math.pi * 210 / 24000) * 2400))
    for i in range(14400)
)
VOICES = [
    {"voice_id": "first-english-voice", "name": "First voice", "category": "premade", "labels": {"language": "en"}},
    {"voice_id": "native-narrator", "name": "My narrator", "category": "cloned", "labels": {"language": "ru", "accent": "Russian"}},
    {"voice_id": "native-guest", "name": "My guest", "category": "generated", "labels": {"language": "ru"}},
]


def run(tmp):
    ext = tmp / "ext"
    ext.mkdir()
    for name in ("manifest.json", "src", "assets"):
        source = ROOT / name
        (shutil.copytree if source.is_dir() else shutil.copy)(source, ext / name)
    checks, errors, sockets, requests = [], [], [], []
    mode = {"socket": "ok", "http": "ok"}

    def check(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name + (" — " + detail if detail else ""), flush=True)

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(tmp / "profile"), channel="chromium", headless=True,
            viewport={"width": 1280, "height": 900},
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}",
                  "--autoplay-policy=no-user-gesture-required"],
        )
        try:
            def http(route):
                if route.request.url.endswith("/v1/voices"):
                    return route.fulfill(json={"voices": VOICES})
                body = route.request.post_data_json
                requests.append(body)
                if mode["http"] == "bad":
                    return route.fulfill(status=400, json={"detail": {"status": "voice_not_found", "message": "Voice is unavailable"}})
                return route.fulfill(content_type="audio/pcm", body=PCM)

            def websocket(route):
                record = {"frames": []}
                sockets.append(record)

                def message(raw):
                    frame = json.loads(raw)
                    record["frames"].append(frame)
                    if not frame.get("close_socket"):
                        return
                    if mode["socket"] == "hold":
                        return
                    if mode["socket"] == "bad":
                        route.send(json.dumps({"error": "Fixture quota exceeded"}))
                        return
                    route.send(json.dumps({"audio": base64.b64encode(PCM[:14400]).decode()}))
                    route.send(json.dumps({"is_final_audio_for_turn": True}))
                    route.send(json.dumps({"audio": base64.b64encode(PCM[14400:]).decode()}))
                    route.send(json.dumps({"is_final": True}))

                route.on_message(message)

            ctx.route("https://api.elevenlabs.io/**", http)
            ctx.route_web_socket("wss://api.elevenlabs.io/**", websocket)
            worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
            ext_id = worker.url.split("/")[2]
            worker.evaluate("async () => chrome.storage.local.set({uiLang:'ru',elevenApiKey:'fixture-key'})")
            page = ctx.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"chrome-extension://{ext_id}/src/options/options.html")
            page.wait_for_function("() => settings && settings.uiLang === 'ru'")

            def saved(patch):
                page.wait_for_function("""async expected => {
                  const actual = await chrome.storage.local.get(Object.keys(expected));
                  return Object.entries(expected).every(([key,value]) => actual[key] === value);
                }""", arg=patch)

            page.locator("#loadEleven").click()
            page.wait_for_function("() => document.querySelector('#elevenVoice').options.length === 4")
            check("loading voices does not automatically select the first popular voice", page.locator("#elevenVoice").input_value() == "")
            check("voice options show language and accent metadata", "ru · Russian" in page.locator("#elevenVoice").inner_text())
            page.locator("#elevenVoice").select_option("native-narrator")
            page.locator("#elevenVoice2").select_option("native-guest")
            saved({"elevenVoiceId": "native-narrator", "elevenVoiceId2": "native-guest"})

            page.locator("#elevenBalanced").click()
            saved({"elevenModel": "eleven_v4_turbo", "elevenStability": 0.5, "elevenSimilarity": 0.75, "elevenSpeakerBoost": False})
            check("balanced preset persists and preserves both selected voices", page.locator("#elevenVoice2").input_value() == "native-guest")
            check("delivery sliders show percentages and disable unsupported boost", page.locator('[data-out="elevenStability"]').inner_text() == "50%" and page.locator("#elevenSpeakerBoost").is_disabled())

            text = "Всё хорошо. Давай посмотрим, что происходит!"
            page.locator("#elevenSample").fill(text)
            started = time.monotonic()
            page.locator('[data-test="elevenlabs"]').click()
            page.wait_for_function("() => player && player.sources.size > 0")
            first_audio_ms = round((time.monotonic() - started) * 1000)
            check("v4 Turbo streams into real WebAudio before preview finishes", page.locator("#stopEleven").is_enabled(), f"fixture click to scheduled audio: {first_audio_ms} ms")
            page.wait_for_function("() => document.querySelector('[data-result=elevenlabs]').classList.contains('ok')")
            frames = sockets[-1]["frames"]
            check("short text flushes immediately without changing punctuation", any(f.get("flush") is True and f.get("inputs", [{}])[0].get("text") == text for f in frames))
            check("websocket registers only the selected narrator", frames[0]["voices"] == ["native-narrator"])

            page.locator('[data-test="elevenlabs2"]').click()
            page.wait_for_function("() => document.querySelector('[data-result=elevenlabs]').classList.contains('ok')")
            check("second-voice preview uses the guest voice", sockets[-1]["frames"][0]["voices"] == ["native-guest"])

            mode["socket"] = "hold"
            page.locator('[data-test="elevenlabs"]').click()
            page.wait_for_function("() => elevenPreviewAbort !== null")
            page.locator("#stopEleven").click()
            page.wait_for_function("() => elevenPreviewAbort === null && !document.querySelector('[data-test=elevenlabs]').disabled")
            check("Stop cancels pending generation and releases the preview controls", page.evaluate("player.sources.size === 0") and "остановлено" in page.locator('[data-result="elevenlabs"]').inner_text())

            mode["socket"] = "bad"
            page.locator('[data-test="elevenlabs"]').click()
            page.wait_for_function("() => document.querySelector('[data-result=elevenlabs]').classList.contains('bad')")
            check("dialogue errors remain visible and unlock both preview buttons", "Fixture quota exceeded" in page.locator('[data-result="elevenlabs"]').inner_text() and page.locator('[data-test="elevenlabs2"]').is_enabled())

            page.locator('[data-key="elevenModel"]').select_option("eleven_v3")
            saved({"elevenModel": "eleven_v3"})
            check("v3 disables similarity and speaker boost", page.locator("#elevenSimilarity").is_disabled() and page.locator("#elevenSpeakerBoost").is_disabled())
            page.locator('[data-test="elevenlabs"]').click()
            page.wait_for_function("() => document.querySelector('[data-result=elevenlabs]').classList.contains('ok')")
            check("v3 sends only its supported stability control", requests[-1]["voice_settings"] == {"stability": 0.5})

            page.locator('[data-key="elevenModel"]').select_option("eleven_flash_v2_5")
            page.locator("#elevenStability").fill("0.35")
            saved({"elevenModel": "eleven_flash_v2_5", "elevenStability": 0.35})
            page.locator('[data-test="elevenlabs"]').click()
            page.wait_for_function("() => document.querySelector('[data-result=elevenlabs]').classList.contains('ok')")
            check("Flash respects natural-delivery settings with style and boost off", requests[-1]["voice_settings"] == {"stability": 0.35, "similarity_boost": 0.75, "style": 0, "use_speaker_boost": False})
            before = len(requests)
            mode["http"] = "bad"
            page.locator('[data-test="elevenlabs"]').click()
            page.wait_for_function("() => document.querySelector('[data-result=elevenlabs]').classList.contains('bad')")
            check("an unrelated HTTP400 is not retried on a slower model", len(requests) == before + 1 and requests[-1]["model_id"] == "eleven_flash_v2_5")

            page.locator("#elevenBalanced").click()
            saved({"elevenModel": "eleven_v4_turbo"})
            mode["socket"] = "ok"
            page.locator('[data-test="elevenlabs"]').click()
            page.wait_for_function("() => document.querySelector('[data-result=elevenlabs]').classList.contains('ok')")
            check("new controls have accessible labels and no horizontal overflow", page.get_by_label("Стабильность", exact=True).count() == 1 and page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
            if "--screens" in sys.argv:
                page.locator('#elevenlabs').screenshot(path=str(ROOT / "docs/screenshots/elevenlabs.png"))
            check("no unhandled page errors", not errors, "; ".join(errors))
        finally:
            ctx.close()
    return checks


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="neiro-eleven-") as folder:
        results = run(Path(folder))
    destination = ROOT / "test-results/elevenlabs.json"
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    passed = sum(item["ok"] for item in results)
    print(f"{passed}/{len(results)} checks passed; {destination}")
    sys.exit(0 if passed == len(results) else 1)
