// NeiroTranslate — options page.
const $ = (id) => document.getElementById(id);
const SAMPLE = {
  ru: 'Привет! Это NeiroTranslate, перевод видео в реальном времени.',
  en: 'Hi! This is NeiroTranslate, real-time video translation.',
  uk: 'Привіт! Це NeiroTranslate, переклад відео в реальному часі.',
  de: 'Hallo! Das ist NeiroTranslate, Videoübersetzung in Echtzeit.',
  es: '¡Hola! Esto es NeiroTranslate, traducción de vídeo en tiempo real.',
  fr: 'Bonjour ! Voici NeiroTranslate, la traduction vidéo en temps réel.'
};

let settings = null;
let audioCtx = null;
let player = null;
let toastTimer = 0;
let savedSettings = null;
let settingsRevision = 0;
const pendingSaves = [];
let saveQueue = Promise.resolve();
let elevenPreviewAbort = null;

function toast(text, failed = false) {
  const el = $('toast');
  el.textContent = text;
  el.setAttribute('role', failed ? 'alert' : 'status');
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (!failed) toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

function showSaveError(error) {
  toast(ntT('testFail') + ': ' + ntExplainError(error?.message || String(error)), true);
}

function result(name, cls, text) {
  const el = document.querySelector(`[data-result="${name}"]`);
  if (!el) return;
  el.className = 'result ' + cls;
  el.textContent = text;
}

function getPlayer() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    player = new NtAudioPlayer(audioCtx, audioCtx.destination, () => {});
  }
  return player;
}

function targetLang() { return ntFindLanguage(settings.targetLang); }
function sample(lang) { return SAMPLE[lang.gt.split('-')[0]] || SAMPLE.en; }

function showFieldValue(el) {
  const key = el.dataset.key;
  const out = document.querySelector(`[data-out="${key}"]`);
  if (el.type === 'checkbox') el.checked = !!settings[key];
  else el.value = settings[key] ?? '';
  if (out) out.textContent = el.dataset.unit === 'percent' ? Math.round(Number(el.value) * 100) + '%'
    : key === 'subtitleSize' ? el.value + 'px' : Number(el.value).toFixed(2) + '×';
}

function showElevenControls() {
  const v3 = /^eleven_v3(?:_|$)/.test(settings.elevenModel);
  const expressive = /^eleven_v[34](?:_|$)/.test(settings.elevenModel);
  const dialogue = ['eleven_v4_turbo', 'eleven_v3_conversational'].includes(settings.elevenModel);
  $('elevenSimilarity').disabled = v3 || dialogue;
  $('elevenSpeakerBoost').disabled = expressive;
  $('elevenContinuity').disabled = dialogue;
}

function showSettings(patch = {}) {
  const previous = settings;
  settings = Object.assign({}, savedSettings, ...pendingSaves.map(item => item.patch));
  document.querySelectorAll('[data-key]').forEach(el => {
    if (Object.hasOwn(patch, el.dataset.key) || previous[el.dataset.key] !== settings[el.dataset.key]) showFieldValue(el);
  });
  if (Object.hasOwn(patch, 'elevenVoiceId') || previous.elevenVoiceId !== settings.elevenVoiceId) {
    const sel = $('elevenVoice');
    if (settings.elevenVoiceId && !Array.from(sel.children).some(opt => opt.value === settings.elevenVoiceId)) {
      const opt = document.createElement('option');
      opt.value = settings.elevenVoiceId;
      opt.textContent = settings.elevenVoiceName || settings.elevenVoiceId;
      sel.appendChild(opt);
    }
    sel.value = settings.elevenVoiceId || '';
  }
  if (Object.hasOwn(patch, 'elevenVoiceId2') || previous.elevenVoiceId2 !== settings.elevenVoiceId2) {
    const sel = $('elevenVoice2');
    if (sel && settings.elevenVoiceId2 && !Array.from(sel.children).some(opt => opt.value === settings.elevenVoiceId2)) {
      const opt = document.createElement('option');
      opt.value = settings.elevenVoiceId2;
      opt.textContent = settings.elevenVoiceName2 || settings.elevenVoiceId2;
      sel.appendChild(opt);
    }
    if (sel) sel.value = settings.elevenVoiceId2 || '';
  }
  const previousLang = ntGetLang();
  ntSetLang(settings.uiLang);
  if (previousLang !== ntGetLang()) ntApplyI18n(document);
  showElevenControls();
}

async function refreshSettings() {
  const revision = ++settingsRevision;
  try {
    const fresh = await ntGetSettings();
    if (revision !== settingsRevision) return;
    savedSettings = fresh;
    showSettings();
  } catch (error) {
    if (revision === settingsRevision) showSaveError(error);
  }
}

function savePatch(patch) {
  if (Object.keys(patch).some(key => key.startsWith('eleven') || key === 'targetLang')) {
    stopElevenPreview(); result('elevenlabs', '', '');
  }
  const entry = { patch };
  pendingSaves.push(entry);
  ++settingsRevision;
  showSettings(patch);
  saveQueue = saveQueue.then(async () => {
    try {
      await ntSetSettings(patch);
      Object.assign(savedSettings, patch);
      toast(ntT('optSaved'));
    } catch (error) {
      showSaveError(error);
    }
    ++settingsRevision;
    pendingSaves.splice(pendingSaves.indexOf(entry), 1);
    showSettings(patch);
    if (!pendingSaves.length) await refreshSettings();
  });
  return saveQueue;
}

function save(key, value) {
  return savePatch({ [key]: value });
}

function bindFields() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    const field = el.closest('.field.two > div') || el.closest('.field');
    const label = field?.querySelector(':scope > label');
    if (label) {
      el.id ||= 'setting-' + key;
      label.htmlFor = el.id;
    }
    showFieldValue(el);
    // Delivery sliders apply on release, not on every intermediate drag value:
    // each saved change can cancel and regenerate a paid live utterance.
    const evt = el.type === 'range' && !key.startsWith('eleven') ? 'input' : 'change';
    if (el.type === 'range' && key.startsWith('eleven')) el.addEventListener('input', () => {
      const out = document.querySelector(`[data-out="${key}"]`);
      if (out) out.textContent = Math.round(Number(el.value) * 100) + '%';
    });
    el.addEventListener(evt, async () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.hasAttribute('data-num')) v = Number(v);
      if (typeof v === 'string' && el.type !== 'select-one') v = v.trim();
      await save(key, v);
    });
  });

  document.querySelectorAll('[data-eye]').forEach((btn) => btn.addEventListener('click', () => {
    const input = btn.previousElementSibling;
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(input.type === 'text'));
    btn.dataset.i18nAria = input.type === 'text' ? 'hideApiKey' : 'showApiKey';
    btn.setAttribute('aria-label', ntT(btn.dataset.i18nAria));
  }));
}

async function loadBrowserVoices() {
  const res = await chrome.runtime.sendMessage({ type: 'NT_GET_VOICES' });
  const voices = (res && res.voices) || [];
  const sel = $('browserVoice');
  const prefix = targetLang().tts.split('-')[0];
  voices
    .slice()
    .sort((a, b) => ((b.lang || '').startsWith(prefix) - (a.lang || '').startsWith(prefix)) || a.voiceName.localeCompare(b.voiceName))
    .forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.voiceName;
      opt.textContent = `${v.voiceName} · ${v.lang || '?'}${v.remote ? ' · online' : ''}`;
      sel.appendChild(opt);
    });
  sel.value = settings.browserVoiceName || '';
}

function fillYandexVoices() {
  const sel = $('yandexVoice');
  Object.entries(NT_YANDEX_VOICES).forEach(([lang, list]) => {
    const group = document.createElement('optgroup');
    group.label = lang.toUpperCase();
    list.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  });
  sel.value = settings.yandexVoice;
  if (!sel.value) sel.value = NT_YANDEX_VOICES.ru[0];
}

function fillElevenSelect(sel, voices, empty, id, name) {
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = empty;
  sel.appendChild(none);
  voices.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = [v.name, v.language, v.accent, v.category].filter(Boolean).join(' · ');
    sel.appendChild(opt);
  });
  if (id && !voices.some((v) => v.id === id)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name || id;
    sel.appendChild(opt);
  }
  sel.value = id || '';
}

function fillElevenVoices(voices) {
  fillElevenSelect($('elevenVoice'), voices, '—', settings.elevenVoiceId, settings.elevenVoiceName);
  fillElevenSelect($('elevenVoice2'), voices, ntT('optVoice2None'), settings.elevenVoiceId2, settings.elevenVoiceName2);
}

async function loadElevenVoices() {
  if (!settings.elevenApiKey) return result('elevenlabs', 'bad', ntT('needElevenKey'));
  result('elevenlabs', 'busy', '…');
  try {
    const voices = await ntElevenLabsVoices(settings.elevenApiKey);
    fillElevenVoices(voices);
    result('elevenlabs', 'ok', `${ntT('testOk')}: ${voices.length} ${ntT('voiceCountLabel')}`);
  } catch (e) {
    result('elevenlabs', 'bad', `${ntT('testFail')}: ${e.message}`);
  }
}

function stopElevenPreview() {
  if (!elevenPreviewAbort) return;
  elevenPreviewAbort.abort();
  if (player) player.clear();
}

async function previewElevenVoice(second = false) {
  if (!settings.elevenApiKey) throw new Error(ntT('needElevenKey'));
  const voiceId = second ? settings.elevenVoiceId2 : settings.elevenVoiceId;
  if (!voiceId) throw new Error(ntT(second ? 'needElevenVoice2' : 'needElevenVoice'));
  stopElevenPreview();
  const controller = new AbortController();
  elevenPreviewAbort = controller;
  $('stopEleven').disabled = false;
  const lang = targetLang(), p = getPlayer();
  p.clear();
  try {
    await audioCtx.resume();
    const text = $('elevenSample').value.trim() || sample(lang);
    await ntElevenLabsStream(text, lang, { ...settings, elevenVoiceId: voiceId }, (pcm, rate) => {
      if (!controller.signal.aborted) p.enqueuePcm16(pcm, rate);
    }, controller.signal);
    await p.whenIdle();
    controller.signal.throwIfAborted();
  } catch (error) {
    p.clear(); throw error;
  } finally {
    if (elevenPreviewAbort === controller) { elevenPreviewAbort = null; $('stopEleven').disabled = true; }
  }
}

const TESTS = {
  async browser() {
    const lang = targetLang();
    const response = await chrome.runtime.sendMessage({ type: 'NT_TEST_BROWSER_VOICE', text: sample(lang), lang: lang.tts, voiceName: settings.browserVoiceName, rate: settings.browserRate });
    if (!response?.ok) throw new Error(response?.error || 'browserVoiceUnavailable');
    result('free', 'ok', ntT('testOk'));
  },
  async google() {
    const lang = targetLang();
    const p = getPlayer();
    const buffers = await ntGoogleTts(sample(lang), lang, audioCtx);
    buffers.forEach((b) => p.enqueueBuffer(b));
    result('free', 'ok', ntT('testOk') + ' · Google Translate');
  },
  async gemini() {
    if (!settings.geminiApiKey) throw new Error(ntT('needGeminiKey'));
    return new Promise((resolve, reject) => {
      const g = new NtGeminiLive({ apiKey: settings.geminiApiKey, model: settings.geminiModel,
        targetLang: targetLang().code, targetName: targetLang().name,
        onStatus: code => { if (code === 'ready') { g.close(); resolve(ntT('testOk') + ' · Live API'); } },
        onFatal: detail => { g.close(); reject(new Error(detail)); }
      });
      g.connect();
    });
  },
  async elevenlabs() {
    await previewElevenVoice();
  },
  async elevenlabs2() { await previewElevenVoice(true); },
  async yandex() {
    if (!settings.yandexApiKey) throw new Error(ntT('needYandexKey'));
    const lang = targetLang();
    if (!ntYandexSupports(lang)) throw new Error(ntT('unsupportedYandexLanguage'));
    const pcm = await ntYandexTts(sample(lang), lang, settings);
    getPlayer().enqueuePcm16(pcm, 48000);
  }
};

function bindTests() {
  const slotFor = name => name === 'browser' || name === 'google' ? 'free' : name === 'elevenlabs2' ? 'elevenlabs' : name;
  document.querySelectorAll('[data-test]').forEach((btn) => btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    const name = btn.dataset.test;
    const slot = slotFor(name);
    const buttons = Array.from(document.querySelectorAll('[data-test]')).filter(el => slotFor(el.dataset.test) === slot);
    result(slot, 'busy', '…');
    buttons.forEach(el => { el.disabled = true; });
    try {
      const msg = await TESTS[name]();
      if (name !== 'browser' && name !== 'google') result(slot, 'ok', msg || ntT('testOk'));
    } catch (e) {
      if (e.name === 'AbortError') result(slot, '', ntT('optPreviewStopped'));
      else result(slot, 'bad', `${ntT('testFail')}: ${ntExplainError(e.message)}`);
    } finally {
      buttons.forEach(el => { el.disabled = false; });
    }
  }));
}

async function init() {
  savedSettings = settings = await ntGetSettings();
  ntSetLang(settings.uiLang);
  ntApplyI18n(document);
  $('ver').textContent = chrome.runtime.getManifest().version;

  fillYandexVoices();
  fillElevenVoices([]);
  bindFields();
  bindTests();
  showElevenControls();
  $('stopEleven').addEventListener('click', stopElevenPreview);
  window.addEventListener('pagehide', stopElevenPreview);
  $('elevenBalanced').addEventListener('click', () => savePatch({ elevenModel: 'eleven_v4_turbo',
    elevenStability: 0.5, elevenSimilarity: 0.75, elevenSpeakerBoost: false, elevenContinuity: true }));
  loadBrowserVoices().catch(showSaveError);

  $('elevenVoice').addEventListener('change', async (e) => {
    const opt = e.target.selectedOptions[0];
    await savePatch({ elevenVoiceId: e.target.value, elevenVoiceName: opt ? opt.textContent : '' });
  });
  $('elevenVoice2').addEventListener('change', async (e) => {
    const opt = e.target.selectedOptions[0];
    await savePatch({ elevenVoiceId2: e.target.value, elevenVoiceName2: e.target.value && opt ? opt.textContent : '' });
  });
  $('loadEleven').addEventListener('click', loadElevenVoices);
  $('elevenVoice').setAttribute('aria-label', ntT('optVoice') + ' ElevenLabs');

  $('exportBtn').addEventListener('click', async () => {
    try {
      const { nt_sessions: sessions = [] } = await chrome.storage.local.get('nt_sessions');
      const rows = [['start', 'duration_sec', 'language', 'domain', 'source', 'voice']]
        .concat(sessions.map((s) => [new Date(s.startTime).toISOString(), s.durationSec, s.lang, s.domain, s.source, s.voice]));
      const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'neirotranslate-stats.csv';
      a.click();
    } catch (error) { showSaveError(error); }
  });
  $('clearBtn').addEventListener('click', async () => {
    if (!confirm(ntT('optClear') + '?')) return;
    try {
      await ntSetSettings({ nt_sessions: [] });
      toast(ntT('optSaved'));
    } catch (error) { showSaveError(error); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(key => Object.hasOwn(NT_DEFAULTS, key))) refreshSettings();
  });
  await refreshSettings();
}

init().catch(showSaveError);
