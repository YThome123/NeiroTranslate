// NeiroTranslate — settings schema and storage helpers (chrome.storage.local).
// API keys live only in chrome.storage.local on this device and are never synced.
(function (root) {
  const DEFAULTS = {
    // Pipeline
    source: 'captions',          // 'captions' (free, page subtitles) | 'gemini' (AI listens to tab audio)
    voice: 'browser',            // 'off' | 'browser' | 'google' | 'gemini' | 'elevenlabs' | 'yandex'
    targetLang: 'ru',

    // Sync: 'realtime' keeps the voice at the picture (speeds up, skips phrases
    // that can no longer be said in time); 'complete' speaks every phrase.
    syncMode: 'realtime',
    maxTempo: 1.6,               // 1..2 — fastest voice-over speed-up for catching up

    // Speakers
    multiVoice: true,            // different voices for different speakers
    speakerAudio: true,          // free mode: analyse tab audio pitch to tell speakers apart

    // Mixer
    originalVolume: 0.25,        // 0..1 — original audio while voice-over is playing
    dubVolume: 1.0,              // 0..1.5 — voice-over volume

    // Subtitles
    showSubtitles: true,
    showOriginal: true,
    hideNativeCaptions: true,
    subtitleSize: 26,
    subtitlePosition: 'bottom',  // 'bottom' | 'top'

    // Browser voice (free)
    browserVoiceName: '',
    browserRate: 1.1,

    // Gemini Live (paid / free tier with AI Studio key)
    geminiApiKey: '',
    geminiModel: 'gemini-3.5-live-translate-preview',
    geminiEcho: false,

    // ElevenLabs (paid)
    elevenApiKey: '',
    elevenVoiceId: '',
    elevenVoiceName: '',
    elevenVoiceId2: '',          // optional voice for other speakers
    elevenVoiceName2: '',
    elevenModel: 'eleven_flash_v2_5',
    elevenStability: 0.5,        // 0..1 — expression versus consistency
    elevenSimilarity: 0.75,      // 0..1 — resemblance to the selected voice
    elevenSpeakerBoost: false,   // v2 only; adds generation latency
    elevenContinuity: true,      // previous completed line conditions the next one

    // Yandex SpeechKit (paid, trial grant available)
    yandexApiKey: '',
    yandexFolderId: '',
    yandexVoice: 'marina',
    yandexSpeed: 1.1,

    // UI
    uiLang: ''                   // '' = auto from browser
  };

  const FREE_VOICES = ['off', 'browser', 'google'];

  function normalize(patch) {
    const result = Object.assign({}, patch);
    if ('source' in result && !['captions', 'gemini'].includes(result.source)) result.source = DEFAULTS.source;
    if ('voice' in result && ![...FREE_VOICES, 'gemini', 'elevenlabs', 'yandex'].includes(result.voice)) result.voice = DEFAULTS.voice;
    if ('syncMode' in result && !['realtime', 'complete'].includes(result.syncMode)) result.syncMode = DEFAULTS.syncMode;
    for (const [key, min, max] of [['originalVolume', 0, 1], ['dubVolume', 0, 1.5], ['maxTempo', 1, 2],
      ['elevenStability', 0, 1], ['elevenSimilarity', 0, 1]]) {
      if (!(key in result)) continue;
      const raw = result[key];
      const value = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
      result[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : DEFAULTS[key];
    }
    for (const key of ['multiVoice', 'speakerAudio']) if (key in result) result[key] = result[key] !== false;
    if ('elevenSpeakerBoost' in result) result.elevenSpeakerBoost = result.elevenSpeakerBoost === true;
    if ('elevenContinuity' in result) result.elevenContinuity = result.elevenContinuity !== false;
    if ('source' in result && result.source !== 'gemini' && result.voice === 'gemini') result.voice = 'browser';
    return result;
  }

  function getSettings() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(DEFAULTS, (res) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || String(error)));
        else resolve(normalize(Object.assign({}, DEFAULTS, res || {})));
      });
    });
  }

  function setSettings(patch) {
    return new Promise((resolve, reject) => chrome.storage.local.set(normalize(patch), () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message || String(error)));
      else resolve();
    }));
  }

  /** Returns a list of problems that prevent starting with the given settings. */
  function validate(s) {
    const problems = [];
    const hasText = (value) => typeof value === 'string' && !!value.trim();
    if (s.source === 'gemini' && !hasText(s.geminiApiKey)) problems.push('needGeminiKey');
    if (s.voice === 'gemini' && s.source !== 'gemini') problems.push('geminiVoiceNeedsGeminiSource');
    if (s.voice === 'elevenlabs' && !hasText(s.elevenApiKey)) problems.push('needElevenKey');
    if (s.voice === 'elevenlabs' && hasText(s.elevenApiKey) && !hasText(s.elevenVoiceId)) problems.push('needElevenVoice');
    if (s.voice === 'yandex' && !hasText(s.yandexApiKey)) problems.push('needYandexKey');
    if (s.voice === 'yandex' && !['ru', 'en', 'de', 'kk', 'uz'].includes(s.targetLang)) problems.push('unsupportedYandexLanguage');
    return problems;
  }

  root.NT_DEFAULTS = DEFAULTS;
  root.NT_FREE_VOICES = FREE_VOICES;
  root.ntGetSettings = getSettings;
  root.ntSetSettings = setSettings;
  root.ntValidate = validate;
})(typeof self !== 'undefined' ? self : this);
