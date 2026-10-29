# Code review

## ElevenLabs delivery — 2026-10-29, v3.4.0

The review compared this turn's changes against pre-turn file snapshots / the v3.3.0 archive, rather than attributing the entire dirty working tree to this task. A read-only reviewer checked transport parameters, cancellation, live settings, continuity and streamed tempo.

| Finding | Resolution and regression evidence |
| --- | --- |
| Delivery changes aborted the audio page but left the worker's queue owner active | Include ElevenLabs model/voice/delivery changes in worker cancellation and refresh; model and secondary-voice tests failed before the fix |
| Dialogue WebSocket settings did not match the published schema | Send only documented stability there and disable similarity in the UI; this is a schema discrepancy, not a proven live-provider rejection |
| Local tempo correction changed pitch with network fragment size | Process fixed blocks with a natural-pitch final tail; identical output for 100ms, 200ms and 137-byte fragments |
| Independently shaped blocks introduced sample discontinuities | Add compensated crossfades and analysis context; real OfflineAudioContext click regression failed before the fix and passed after it |
| A buffered prefix that never sounded still advanced a multi-speaker dialogue | Audio scheduling returns a boolean; report speech timing only after scheduling, while still completing a failed queue owner |

Additional fixes cover unrelated HTTP400 downgrades, bounded language-parameter retry, empty/cancelled output, short-cue flushing and provider regional redirects. Paid previews have Stop; sliders persist on release to avoid intermediate paid regenerations. New contract fixtures use synthetic PCM and cannot establish subjective quality of actual ElevenLabs voices. Real Gemini Live translation succeeded with a supplied key; ElevenLabs live access was region-restricted. No key is included in the report.

The final targeted re-review reported no new actionable finding: 126 focused Node tests and additional cancellation/tail/failed-prefix fixtures passed. The main verification also confirmed the rendered joins in a real OfflineAudioContext (15/15 browser audio checks), with a maximum sample jump of 0.03576 against the unchanged 0.06 regression threshold. This scoped result does not establish live ElevenLabs output quality.

## Release stabilization — 2026-10-29, v3.2.0

Focused audits covered provider parsing/cancellation, Options and Stats synchronization, and runtime session/voice/navigation ownership. A separate runtime reviewer reproduced races through deferred promises; another reviewer checked Options/Stats save and refresh behavior. Each runtime finding received a failing regression before its fix. The working tree contains earlier unreleased changes as well; no clean-baseline claim is made.

| Finding | Resolution |
| --- | --- |
| Waiting captions could expire during playback initialization or native voice discovery, then receive a new speech budget | Carry and recheck the original start deadline across each wait |
| A cold worker discarded the first media resume event before session restoration | Keep the message channel open and dispatch after restoration |
| A source notification waiting for restoration could restart after Stop | Capture lifecycle ownership before waiting and reject superseded updates |
| Navigation retained speech until completion; a failed older injection could tear down a newer page | Cancel at loading and guard completion/error handling with navigation ownership |
| Startup's old settings snapshot overwrote a page's earlier storage update | Explicitly reconcile settings into the current content session |
| Delayed speaking/error messages affected a replacement utterance | Tag and validate voice epochs |
| Options ignored external updates or overwrote pending edits with delayed reads | Serialize saves, track pending patches and reject stale refresh results |
| Test buttons sharing a result slot raced; unsupported Yandex targets were silently tested as Russian | Coordinate buttons and reject unsupported test languages |
| Stats reloaded stale history after reset, changed its filter or hid storage errors | Track history revisions, retain filter selection and show recoverable errors |

Additional provider regressions cover malformed Google segments/detected-language values, emoji at chunk boundaries, cancellation before decode, ElevenLabs reader cleanup, malformed Gemini frames and terminal buffer/timer cleanup. History regressions cover concurrent writes, confirmed reset/removal, failed storage callbacks, retention cap and Stop while persistence is pending. Release packaging verifies ZIP integrity and creates a separate SHA256 file.

The final focused runtime re-review found no remaining findings in the corrected Stop/restoration and navigation ownership paths: 44 pipeline tests and five additional in-memory race checks passed. The separate read-only Options/Stats re-review reported no high/medium finding in its reviewed scope. These are scoped reviews, not a guarantee against every possible defect.

Validation evidence and limits are recorded in [VERIFICATION.md](VERIFICATION.md). Native speech is modeled in browser automation; paid-provider success and a public YouTube livestream are not part of that evidence.

## Streaming voices — 2026-10-29, v3.1.4

Focused independent review covered live source/provider changes, completion-owned speech queuing, browser/Google fallback, cancellation and settings synchronization. Findings reproduced and fixed: settings saved during an inactive source restart were lost; a failed settings read stranded the session on an old voice; a delayed speech settings snapshot could undo a newer selection; the old-language guard prevented Gemini settings recovery. Focused re-review found no remaining substantial issue in those fixes. Additional regressions cover separate selected-vs-fallback configuration, failed/expired fallback release, interrupted speech progress, bounded current-caption retry and mocked YouTube DOM streaming. Full evidence and verification limits are in [VERIFICATION.md](VERIFICATION.md).

## Latency follow-up — v3.1.3

Focused review covered the 250 ms TTS hedge, first-chunk playback, caller cancellation, native-track lookahead, preparation without playback, settings/media guards, bounded decoded-audio cache and local browser-voice preference. A terminal failure in a later chunk originally waited behind a stalled first chunk; a failing regression reproduced it and immediate group cancellation fixed it. Focused re-review found no remaining substantial issue in that fix or the preparation guards. Network timing comparisons explicitly retain failed samples and distinguish controlled HTTP delays from real services; see [VERIFICATION.md](VERIFICATION.md).

## Playback follow-up — 2026-10-24, v3.1.2

Reviewed the timing, cancellation, free-provider and voice-fallback changes in the working tree. New browser tests use real Chromium video, audio decoding and WebAudio; controlled responses reproduce slow and out-of-order providers. Live-network runs exercise actual Google translation and voice.

The independent playback review found these issues; each received a focused fix and regression coverage:

| Finding | Resolution |
| --- | --- |
| A 2.5-second request budget incorrectly expired still-active long cues | Separate translation response freshness from actual cue display/audio expiry |
| The page/OBS overlay independently hid long subtitles after 6.5/7 seconds | Propagate the cue deadline to overlay visibility timers; browser check crosses seven seconds |
| Recovering Google audio could overlap the previous browser fallback | Cancel the previous engine before starting the next utterance |
| A delayed fallback could dispatch after a replacement caption | Utterance-specific epochs checked across awaits, offscreen messages, retries and error responses |
| Worker suspension reset that epoch while the audio document survived | Save it in session state before speech dispatch and restore it with the worker |
| Buffering was cleared by the next media poll | Latch waiting/emptied until playing or a new video |
| Pausing externally ducked Gemini audio did not restore its monitor | Reapply mixer gain after clearing the external duck state |

Additional failures reproduced by the new suite: stale audio continued after a cue ended, old subtitle text lingered, a stalled synthesis held up a fresh phrase, and reload after previous media events desynchronized version counters. Expiry now runs both on the audio clock and through cancellation; reloaded content continues the current media version. Late browser-engine events cannot duck audio after expiry.

Network probes also exposed overly short provider timeouts under load. The current provider implementation and fresh outcomes are recorded in [VERIFICATION.md](VERIFICATION.md). Successful remote services on this machine do not guarantee regional availability elsewhere.

The sections below describe the preceding v3.1.1 review, retained as history.

Base: `60b32e3be46eff1188026e532c620550dcf6052b`; reviewed the working-tree changes, including new files. Two independent reviewers checked project standards and the original feature requirements. Fixes were followed by regression tests and focused re-review.

## Standards

Standards source: `CONTRIBUTING.md`. Four findings, all resolved:

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | Stop waited behind pending startup/navigation; existing tests called the internal stop function | Stop cancels queued work immediately; tests now enter through runtime messages and popup controls |
| P2 | Offscreen retries could submit an old session's speech to its replacement | Requests carry a session identifier; both retry loop and receiver validate it |
| P2 | Paired settings were announced using the other field's label | Each control is associated with its own label and id; verified through browser label queries |
| P2 | Authored error messages bypassed RU/EN translations | Timeout/unavailable codes resolve through shared translations in popup and Settings |

No additional code-smell heuristic justified a structural refactor. The label finding was a correctness issue rather than a documented-standard breach.

## Spec

Six findings against the requirement to cancel stale work and clean up sessions, all resolved:

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | Stop could not cancel pending startup | Startup observes cancellation after each asynchronous boundary; Stop does not wait behind page injection/capture |
| P1 | Initial worker-state restoration could resurrect a stopped session | Stop waits for restored state before cleanup |
| P2 | Retried voice requests crossed session boundaries | Session-bound retry and offscreen validation |
| P2 | YouTube CC could reactivate after Stop | Navigation timer is cancelled; callback also checks active state |
| P1 | A cancelled replacement's delayed cleanup could close the next offscreen document | Every teardown joins the cleanup barrier before fresh startup |
| P2 | A tab-close event could be lost during worker restoration | Tab, navigation and settings handlers wait for initial state |

Some findings occur in both axes; the counts must not be added as distinct bugs. Focused re-review found no remaining issue in these fixes.

Additional fixes: browser-voice testing reports actual synthesis failure, API rejection releases the speech queue, and browser tests wait for install-time Settings navigation before opening the video.

## Cleanup

Removed internal planning documents, the temporary CDP preview helper, unused 512 px icon/render job, unused Google rate setting, redundant GIF recording and generated cache/media files. Retained extension assets, editable SVGs, actual UI screenshots, regression tests, media generator, package builder and CI.

## Verification limits

See [verification results](VERIFICATION.md). Paid-provider success with actual account keys and every browser/site combination remain outside the verified coverage. GitHub Actions is configured; its remote run occurs after upload.
