# Changes

## 3.4.1 — 2026-11-07

Audit fixes and more responsive audio cancellation.

- Separate the first audible start deadline from the completion deadline across browser/Google fallbacks and all offscreen providers. Cancel expired pending synthesis without replaying a stale phrase; preserve the valid tail of speech that started on time.
- Move long-buffer pitch-preserving WSOLA to a cancellable local worker, with a cooperative fallback. Await asynchronous provider deliveries, protect cached audio from transfer/detachment, and invalidate late results on pause, seek, settings changes and Stop.
- Preserve accepted complete-mode captions and translations in source order beyond their original cue expiry. Bound the outstanding backlog at 256 phrases and report overload explicitly. Keep realtime's freshness policy.
- Shorten realtime's overrun allowance from 700ms to 300ms while a fresh phrase waits; preserve the one-time near-end word grace and complete-mode retention.
- Bound Gemini's browser transport buffer, discard source packets older than three seconds, guard stale socket opens and recover from send failures. Reconnect attempts reset only after sustained successful audio, not a slow handshake or idle connection.
- Share simultaneous identical translation requests with independent cancellation. Temporarily skip Google text hosts returning HTTP429 according to bounded Retry-After, so the next caption can immediately use the healthy fallback.
- Treat blank rolling-caption snapshots as utterance boundaries, preserving genuine repeated answers. Determine target-language suppression per speaker part. Reject stale or superseded ducking operations across session changes.
- Keep an open OBS overlay synchronized with local preferences, clear hidden originals immediately, and reject delayed initial state/preferences that would overwrite newer content.
- Add behavioral regressions and a real Chromium shaping/worker/cancellation test. Use isolated clocks for previously load-sensitive deadline tests.

## 3.4.0 — 2026-10-29

ElevenLabs: balanced delivery, model-aware controls and voice preview.

- GitHub preparation: redesigned RU/EN README, contributor/security guides, clean source archive, credential checks for public files, archive inputs and Git history. Check content and filenames; use UTF-8 for Windows paths and reject missing archive inputs. No personal keys or generated reports are included.
- Add Eleven v4 Turbo using the documented Text to Dialogue WebSocket. Flush short captions immediately; wait for the final connection flush, not a turn marker, before completing playback. Abort, timeout and malformed/error replies close the socket.
- Add v4 and v3 to the model picker. Send only supported controls: v4 stability/similarity, v3 discrete stability, v2 stability/similarity with style fixed at zero and optional speaker boost. Keep explicit existing model selections.
- Add a balanced preset (v4 Turbo, 50% stability / 75% similarity, boost off), sliders, custom preview text, separate primary/secondary voice preview and Stop. Loading account voices displays language/accent metadata and requires a deliberate voice selection.
- Condition HTTP synthesis on the previous completed line from the same voice, speaker, model and language. Keep only 100 characters in memory for at most eight seconds; pause, seek, Stop, errors and voice/config changes invalidate it. This context is not sent to the v4 Turbo WebSocket.
- Preserve synchronization when a model has no speed control; apply the remaining tempo correction locally instead of multiplying two full speed-ups.
- Coalesce locally accelerated PCM into fixed 120ms stretching blocks, independent of network fragmentation; preserve pitch in the final short tail. Pause/Stop discard pending bytes. Documented dialogue WebSocket settings differ from HTTP: send stability only and disable similarity there.
- Smooth block joins with compensated overlap and 40ms analysis context, cropped after shaping; the initial analysis buffer is 160ms, not a whole phrase. Mark a dialogue part spoken only after audio is actually scheduled, so a failed buffered prefix cannot advance to a reply.
- Changing ElevenLabs model, voice or delivery releases the current queue owner and refreshes the cue. Delivery sliders save once on release to avoid regenerating paid speech for intermediate drag positions.
- Fix an unrelated HTTP400 silently switching to Multilingual v2. Retry only an explicitly rejected language parameter, once, with the chosen model and voice. Reject empty responses and ignore PCM received after cancellation.
- Identify followed regional-access redirects rather than parsing the provider's HTML as JSON/PCM. Connection failures do not label an unverified key as invalid.
- Document voice selection, delivery settings and the limits of captions-only emotion. New Chromium fixtures verify UI, HTTP/WebSocket contracts and real WebAudio; paid output quality remains unverified without an account key.

## 3.3.0 — 2026-10-29

Real-time voice-over and multiple speakers.

- **Voice fits the original's timing.** Every phrase carries a sync window: for timed cues the cue end, for rolling YouTube/DOM captions the time the speaker actually took (measured pace). The voice speeds up as needed — never slower than the user's rate, never faster than the new *Maximum voice speed-up* (default 1.6x).
- **Pitch-preserving speed-up.** Google and Yandex speech is time-stretched with WSOLA instead of raising playback rate, so faster speech does not sound like a chipmunk. Browser voices use their native rate; ElevenLabs receives `voice_settings.speed`; Yandex is asked for the speed and corrected exactly after synthesis.
- **Measured voice speed.** Browser voices are calibrated on finished phrases (characters per second per voice), Google from the decoded length of its first chunk.
- **Real-time queue.** New mode setting: *Real time* (default) or *Complete*. In real time one phrase waits at most; a phrase that overran its slot yields to a newer waiting one; a phrase that could not finish in time even at full speed is skipped (its subtitle was shown). *Complete* speaks every phrase.
- **Gemini voice catch-up.** A backlog of streamed Gemini audio is played faster and finally dropped, keeping the live voice near the picture.
- **Speaker detection from captions.** WebVTT `<v Name>`, `>>` turn markers, dialogue dashes and `NAME:` labels split a caption into speakers; each part is translated separately and voiced in order.
- **Speaker detection from audio (free mode).** With *Detect speakers from the video audio*, the tab is captured and analysed locally (YIN pitch in an AudioWorklet, online clustering). Nothing is sent anywhere. Low and high voices get matching voices.
- **A voice per speaker.** Browser: a different installed voice per speaker, matched to pitch class, otherwise pitch variation. Google: pitch-shifted per speaker at constant duration. Yandex: gender-matched voices. ElevenLabs: optional second voice.
- Sound descriptions (`[Music]`, `(laughs)`, `♪ lyrics ♪`) are shown but no longer spoken.
- Tab capture for speaker detection is optional: if Chrome refuses it, translation starts anyway and `state.captureError` names the reason; ducking switches between page and audio mixer accordingly.

## 3.2.0 — 2026-10-29

- Recheck queued-caption freshness before playback and after asynchronous settings/audio initialization; never extend an expired waiting phrase into a new speech budget.
- Cancel speech, translation and preparation at navigation start; resume on page completion or end the session with an actionable access error.
- Tag voice ducking/error signals with their utterance epoch so delayed messages cannot affect replacement speech.
- Keep media messages while worker state is restoring and recheck freshness after native voice discovery.
- Reconcile changes made during startup into page settings; synchronize the Options page with other extension windows without discarding pending edits.
- Coordinate provider test buttons, reject unsupported Yandex test languages and validate whitespace-only credentials.
- Refresh an open Stats page after history changes, retain its selected filter and report storage/export errors.
- Serialize history writes and discard work invalidated by a confirmed reset, so old callbacks cannot repopulate cleared history.
- Preserve Stop and navigation ownership across delayed restoration, settings notifications and injection failures.
- Reject malformed Google translation segments rather than converting objects into spoken/cached text.
- Keep Unicode surrogate pairs intact when splitting speech, including long words with emoji.
- Skip decoding cancelled Google response bodies and always cancel/release ElevenLabs response readers after playback failure.
- Ignore malformed Gemini frames and discard pending text/audio/timers on terminal connection errors.
- Build release archives atomically, verify their integrity, include this changelog and generate a SHA256 file alongside each ZIP.

## 3.1.4 — 2026-10-29

- Allow changing the active source; Gemini cleanup and captions startup follow the latest saved voice, without requiring a manual Stop first.
- Free voice selection exits keyless Gemini configuration; preserve deliberate Gemini input + free TTS and reflect external settings changes.
- Replace cancellation on every short caption with a shared bounded speech queue that waits for actual playback completion.
- Estimate a bounded phrase budget from text length and network startup, instead of cutting every voice at the subtitle boundary; pause/seek/Stop still cancel immediately.
- Bound native voice discovery/startup, refresh empty/failed voice lists, and release queue ownership on failed/expired fallback.
- Use known character progress for a browser interruption's fallback; keep fallback provider settings separate from the user's configured provider.
- Reject stale settings snapshots, recover from transient storage reads, and surface/roll back failed settings saves.
- Retry a transient translation once only if the content script confirms the same caption is still visible; skip quota errors and obsolete captions.
- Add YouTube-style DOM streaming, live provider switching, rapid restart selection and queue cancellation regressions; include streaming fixtures in CI.

## 3.1.3 — 2026-10-25

- Start the second Google voice host after 250 ms when the first is slow; cancel the losing request after valid audio decodes.
- Start the first decoded speech chunk immediately while loading later chunks, preserving their order.
- Prepare one available native subtitle cue up to four seconds ahead; cache its translation and Google audio without playing early or generating paid speech.
- Bound decoded speech caching to 24 chunks / 12 MiB / two minutes, isolate languages and audio contexts, and cancel preparation on pause/seek/settings changes.
- Prefer an available local browser voice for automatic selection while respecting an explicitly selected voice.
- Recover from buffering when the actual media clock advances even if a player omits the next `playing` event.
- Bound a voice chunk's complete wait to 2050 ms, including stalled transports; cancellation also rejects pending decode results.
- Cancel a failed multi-part phrase promptly and avoid replaying an already spoken prefix through a fallback voice.
- Add a reproducible five-phrase real-network latency comparison and browser regressions for hedged/partial audio cancellation.

## 3.1.2 — 2026-10-24

- Pause, seek, buffering, playback speed changes and video end cancel stale translations and speech.
- Finalized WebVTT cues translate immediately; rolling captions use a shorter stable window.
- New captions replace stalled synthesis; voice playback is bounded by the caption deadline on the WebAudio clock.
- Browser speech expires even when its engine never reports completion; late events cannot duck the original again.
- Subtitles expire with their cue instead of remaining on screen; page reload preserves the media version.
- Free translation hedges slow requests after 600 ms using the second Google host and MyMemory, with an overall deadline and cancellation of losing requests.
- Reject blank/quota/error fallback responses and missing target languages; keep cancellation and cache isolation.
- Google voice retries the other permitted host; browser/Google voice failures can use the other engine.
- Added deterministic pause/seek/audio regressions, real-network playback checks, timing reports and CI playback coverage.

## 3.1.1 — 2026-10-23

- Stop cancels pending startup and navigation immediately; a new session waits for all old audio cleanup.
- Fixed cold-worker state restoration on Stop/tab close and stale offscreen speech retries.
- Cancelled delayed YouTube caption activation after Stop.
- Browser voice tests report actual synthesis errors, and browser API failures release the speech queue.
- Fixed accessible names for paired settings and localized timeout/unavailable errors.
- Added regressions through actual message handlers and popup controls; stabilized install navigation in browser tests.
- Removed internal planning files, temporary preview helper, unused icon size, unused setting and redundant GIF recording.

## 3.1.0 — 2026-10-22

- White/orange interface, orbital vector identity and extension icons.
- Clear separation of caption translation, Gemini tab-audio translation and voice providers.
- Fixed stale translations and browser speech after stopping/restarting sessions.
- Fixed volume restoration during ducking and live caption visibility settings.
- Added request timeouts and visible translation errors; repaired MyMemory source-language fallback.
- Fixed Gemini close/reconnect cancellation and startup error reporting.
- Fixed SpeechKit API-key authentication, folder handling and v1 voice compatibility.
- Added regression/browser tests, provider fixtures, actual UI screenshots, privacy docs, CI and reproducible ZIP packaging.
