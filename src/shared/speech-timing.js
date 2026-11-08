// NeiroTranslate — speech timing. A translated phrase has to fit into the time
// the original speaker used, otherwise every phrase adds lag and the voice-over
// drifts behind the video. Shared by the content script, worker and audio page.
(function (root) {
  // Tuning constants. All of them are wall-clock milliseconds unless noted.
  const NT_TIMING = {
    // Characters per second at tempo 1.0 for typical TTS voices, by script.
    // Only used until a voice has been measured on real phrases this session.
    DEFAULT_CPS: { latin: 14.5, cyrillic: 13.5, cjk: 5.5, other: 12 },
    CPS_MIN: 4, CPS_MAX: 32,
    // Speaker pace for rolling captions before any measurement (source chars/s).
    SOURCE_CPS: 14,
    // Rolling auto-captions appear after the words were spoken. VOD captions are
    // timed by the player; live ASR captions lag noticeably. Rough YouTube
    // values: if speaker detection picks the neighbouring phrase, tune these.
    CAPTION_LAG_VOD_MS: 200,
    CAPTION_LAG_LIVE_MS: 1300,
    // Time allowed after the original finished, for translation and TTS
    // round trips. Smaller makes speech faster; larger lets the voice trail.
    VTT_SYNC_GRACE_MS: 350,
    DOM_SYNC_GRACE_MS: 650,
    // A started phrase is cut only when it overran its slot by this much AND a
    // newer phrase is waiting. Without a waiting phrase it always finishes.
    OVERRUN_CUT_MS: 300,
    // ...unless it is expected to end within this anyway: then it finishes.
    NEAR_END_MS: 800,
    // A waiting phrase is dropped only if, even at the fastest tempo, it would
    // end more than this after its slot. Looser than OVERRUN_CUT_MS on purpose:
    // dropping loses a whole phrase, a cut loses only its tail.
    LATE_START_MS: 1500,
    // Realtime mode: a phrase that cannot start within this budget is dropped
    // (its subtitle was already shown) instead of being spoken late.
    REALTIME_START_BUDGET_MS: 1300,
    // Below this ratio difference audio is played untouched.
    TEMPO_EPSILON: 0.03
  };

  function scriptOf(text) {
    if (/[぀-ヿ㐀-鿿가-힯]/.test(text)) return 'cjk';
    if (/[Ѐ-ӿ]/.test(text)) return 'cyrillic';
    if (/[A-Za-zÀ-ɏ]/.test(text)) return 'latin';
    return 'other';
  }

  // Pauses at punctuation cost time like a few letters do.
  function speechUnits(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const pauses = (clean.match(/[.!?…,;:—]/g) || []).length;
    return clean.length + pauses * 3;
  }

  function estimateSpeechMs(text, cps) {
    const rate = Number.isFinite(cps) && cps > 0 ? cps : NT_TIMING.DEFAULT_CPS[scriptOf(text)];
    return speechUnits(text) / rate * 1000;
  }

  /**
   * Tempo needed to say `speechMs` (measured at tempo 1) within `availableMs`.
   * Never slower than `base` (the user's chosen rate), never faster than `max`.
   */
  function planTempo({ speechMs, availableMs, base = 1, max = 1.6 }) {
    const floor = Number.isFinite(base) && base > 0 ? base : 1;
    const ceiling = Math.max(floor, Number.isFinite(max) && max > 0 ? max : floor);
    if (!(speechMs > 0)) return floor;
    if (!(availableMs > 0)) return ceiling;
    return Math.max(floor, Math.min(ceiling, speechMs / availableMs));
  }

  /** Measured characters-per-second per voice, so estimates converge on real voices. */
  class NtVoiceCalibration {
    constructor(limit = 32) { this.limit = limit; this.voices = new Map(); }
    cps(key, text) {
      const known = this.voices.get(key);
      return known && known.script === scriptOf(text) ? known.cps : NT_TIMING.DEFAULT_CPS[scriptOf(text)];
    }
    /** `durationMs` was spoken at `tempo`; ignore short or implausible samples. */
    observe(key, text, durationMs, tempo = 1) {
      const units = speechUnits(text);
      if (units < 12 || !(durationMs > 300) || !(tempo > 0)) return;
      const sample = units / (durationMs / 1000) / tempo;
      if (sample < NT_TIMING.CPS_MIN || sample > NT_TIMING.CPS_MAX) return;
      const script = scriptOf(text);
      const known = this.voices.get(key);
      const cps = known && known.script === script ? known.cps * 0.7 + sample * 0.3 : sample;
      this.voices.delete(key);
      this.voices.set(key, { cps, script });
      while (this.voices.size > this.limit) this.voices.delete(this.voices.keys().next().value);
    }
  }

  /** Speaker pace of rolling captions, from how fast finished text arrives. */
  class NtSourcePace {
    constructor() { this.reset(); }
    reset() { this.cps = NT_TIMING.SOURCE_CPS; this.lastAt = 0; }
    observe(text, at) {
      const chars = speechUnits(text);
      const gap = at - this.lastAt;
      // A long gap is silence, not slow speech. Bounded inputs only.
      if (this.lastAt && gap >= 250 && gap <= 5000 && chars > 0) {
        const sample = Math.max(5, Math.min(30, chars / (gap / 1000)));
        this.cps = this.cps * 0.75 + sample * 0.25;
      }
      this.lastAt = at;
    }
    durationMs(text) { return speechUnits(text) / this.cps * 1000; }
  }

  root.NT_TIMING = NT_TIMING;
  root.ntEstimateSpeechMs = estimateSpeechMs;
  root.ntPlanTempo = planTempo;
  root.ntSpeechUnits = speechUnits;
  root.NtVoiceCalibration = NtVoiceCalibration;
  root.NtSourcePace = NtSourcePace;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NT_TIMING, ntEstimateSpeechMs: estimateSpeechMs, ntPlanTempo: planTempo,
      ntSpeechUnits: speechUnits, NtVoiceCalibration, NtSourcePace };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
