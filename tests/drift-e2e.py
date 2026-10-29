"""Voice drift on continuous speech: does the voice-over fall behind a fast talker?

Plays ten back-to-back YouTube-style DOM captions (~2.6 s each, ~20 chars/s, no
future cues to prepare) through the real extension with REAL Google Translate and
Google voice, and measures:
  start_lag_ms   — caption shown on the page -> its translated phrase sent to the voice
  tail_lag_ms    — last caption ended -> voice actually silent (accumulated drift)
  voiced         — phrases voiced out of ten
Network timing varies; compare runs made back to back on the same connection.

Run:  python tests/drift-e2e.py                       (current source)
      python tests/drift-e2e.py --baseline --release dist/neirotranslate-3.2.0.zip
Results: test-results/drift-after.json / drift-before.json
"""

import importlib.util
import json
import statistics
import sys
import time
from pathlib import Path

if "--live-network" not in sys.argv:
    sys.argv.append("--live-network")
spec = importlib.util.spec_from_file_location(
    "nt_stream", Path(__file__).with_name("stream-voices-e2e.py")
)
stream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stream)
base = stream.base
BASELINE = "--baseline" in sys.argv
base.REPORT = base.ROOT / "test-results" / ("drift-before.json" if BASELINE else "drift-after.json")

SENTENCES = [
    "Okay so today we are going to look at the new update.",
    "There are a lot of changes to the ranked system.",
    "First of all the matchmaking is finally a bit faster.",
    "They also reworked how the rewards work at the end.",
    "Honestly I think this is the best patch in a long time.",
    "Let me show you what happens when I queue up right now.",
    "You can see the waiting time is already much shorter.",
    "And the new maps look really good on high settings.",
    "Let me know in the chat what you think about it.",
    "Alright let's jump into the first game together.",
]
LINE_SECONDS = 2.6


class Drift(stream.StreamSuite):
    def run(self):
        self.scenario("voice keeps up with a fast continuous talker", self.drift)
        self.sw.evaluate("()=>stop()")

    def sample(self, timeline):
        info = self.audio()
        if info:
            timeline.append((time.time() * 1000, info["rms"] > 0.003))

    def drift(self):
        self.reset(SENTENCES[0])
        shown = [time.time() * 1000]
        timeline = []
        for sentence in SENTENCES[1:]:
            end = time.monotonic() + LINE_SECONDS
            while time.monotonic() < end:
                self.sample(timeline)
                self.page.wait_for_timeout(40)
            self.caption(sentence)
            shown.append(time.time() * 1000)
        end = time.monotonic() + LINE_SECONDS
        while time.monotonic() < end:
            self.sample(timeline)
            self.page.wait_for_timeout(40)
        last_end = time.time() * 1000
        self.caption("")
        quiet_since = None
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            self.sample(timeline)
            now = time.time() * 1000
            if timeline and timeline[-1][1]:
                quiet_since = None
            elif quiet_since is None:
                quiet_since = now
            elif now - quiet_since > 1200:
                break
            self.page.wait_for_timeout(40)
        events = self.sw.evaluate("()=>qa.events")
        subtitles = [e for e in events if e["type"] == "NT_SUBTITLE" and e.get("text")]
        speaks = [e for e in events if e["type"] == "NT_OFF_SPEAK"]
        # Subtitle i belongs to caption i (one finished sentence per line).
        order = {}
        for e in subtitles:
            order.setdefault(e["text"], len(order))
        lags = []
        for e in speaks:
            index = order.get(e["text"])
            if index is not None and index < len(shown):
                lags.append(round(e["at"] - shown[index]))
        audible = [t for t, on in timeline if on]
        tail = round(audible[-1] - last_end) if audible else None
        result = {
            "voiced": len({e["text"] for e in speaks}),
            "start_lag_ms": lags,
            "start_lag_median_ms": statistics.median(lags) if lags else None,
            "start_lag_last_ms": lags[-1] if lags else None,
            "tail_lag_ms": tail,
            "subtitles": len(order),
        }
        self.metrics.update(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        assert len(order) >= 8, result


base.Suite = Drift
if __name__ == "__main__":
    sys.exit(base.main())
