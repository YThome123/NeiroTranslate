// NeiroTranslate — service worker: session lifecycle, translation, voice routing.
importScripts('../shared/languages.js', '../shared/settings.js', '../shared/i18n.js', '../shared/translate.js', '../shared/speech-queue.js',
  '../shared/speech-timing.js', '../shared/speakers.js');

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const CONTENT_FILES = ['src/content/segmenter.js', 'src/shared/speech-timing.js', 'src/shared/speakers.js', 'src/content/content.js'];
const OFFSCREEN_VOICES = ['google', 'elevenlabs', 'yandex'];
const TTS_DONE = ['end', 'interrupted', 'cancelled', 'error'];
// Gemini's transcript of a phrase arrives roughly this long after it was said.
// Measured informally on Live Translate; only affects which speaker is picked.
const GEMINI_TRANSCRIPT_LAG_MS = 600;
const GEMINI_SPEAKER_WINDOW_MS = 4000;

const IDLE_STATE = {
  active: false, tabId: null, source: null, voice: null, targetLang: null,
  status: 'idle', detail: '', startedAt: 0, domain: '', mediaVersion: 0, paused: false, voiceEpoch: 0,
  // Tab audio is captured (Gemini, or free mode speaker detection): ducking then
  // happens in the audio page's mixer instead of on the page's <video>.
  capture: false, captureError: ''
};

let state = Object.assign({}, IDLE_STATE);
let stateReady = false;
let offscreenCreating = null;
const translations = new Set();
const completeTranslations = new Set();
const COMPLETE_BACKLOG_LIMIT = 256;
let captionOrderTail = Promise.resolve();
let duckOperation = 0;
let captionPrefetch = null;
let captionSequence = 0;
let displayedSequence = 0;
let lastOriginal = '';
let lastSubtitle = null;
let subtitleTimer = 0;
let sessionEpoch = 0;
let navigationEpoch = 0;
let browserSpeechEpoch = 0;
let voiceEpoch = 0;
let settingsRevision = 0;
let lifecycle = Promise.resolve();
let lifecycleAbort = new AbortController();
let stopping = Promise.resolve();
const CANCELLED = { ok: true, cancelled: true };
let activeVoiceCompletion = null;
// When the current utterance is expected to finish (wall ms), per voice token:
// the browser path estimates it, the audio page reports scheduled audio exactly.
let expectedSpeechEnd = {token: -1, at: 0};
const voiceQueue = new NtSpeechQueue({play:playVoice, onError:error => setStatus('voice_error',error.message),
  remaining: () => expectedSpeechEnd.token === voiceEpoch ? expectedSpeechEnd.at - Date.now() : null,
  nearEndMs: NT_TIMING.NEAR_END_MS});
// Per-session speaker → voice profiles and per-voice measured speaking speed.
const speakerBook = new NtSpeakerBook();
const voiceCalibration = new NtVoiceCalibration();

function runLifecycle(action) {
  const signal = lifecycleAbort.signal;
  lifecycle = lifecycle.catch(() => {}).then(() => new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); resolve(CANCELLED); };
    if (signal.aborted) return cancel();
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => signal.aborted ? CANCELLED : action(signal)).then(
      result => { signal.removeEventListener('abort', cancel); resolve(result); },
      error => { signal.removeEventListener('abort', cancel); reject(error); }
    );
  }));
  return lifecycle;
}

// ─── State ───────────────────────────────────────────────────
const stateLoaded = chrome.storage.session.get('ntState').then((r) => {
  if (r && r.ntState) {
    state = Object.assign({}, IDLE_STATE, r.ntState);
    voiceEpoch = Math.max(voiceEpoch, state.voiceEpoch || 0);
  }
}).catch(() => {}).then(() => { stateReady = true; });

function saveState() {
  state.voiceEpoch = voiceEpoch;
  chrome.storage.session.set({ ntState: state }).catch(() => {});
  broadcast({ type: 'NT_STATE', state });
}

function setStatus(status, detail = '') {
  if (!state.active && status !== 'idle' && status !== 'error') return;
  state.status = status;
  state.detail = detail || '';
  saveState();
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function sendToTab(msg) {
  if (state.tabId == null) return Promise.resolve();
  return chrome.tabs.sendMessage(state.tabId, msg, { frameId: 0 }).catch(() => {});
}

// ─── Offscreen document ─────────────────────────────────────
async function hasOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  return ctx.length > 0;
}

async function ensureOffscreen(id = state.sessionId) {
  const exists = await hasOffscreen();
  if (!state.active || state.sessionId !== id) return;
  if (exists) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture tab audio for live translation and play the translated voice-over.'
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function closeOffscreen() {
  try { if (await hasOffscreen()) await chrome.offscreen.closeDocument(); } catch (e) { /* already closed */ }
}

async function sendToOffscreen(msg, tries = 30) {
  const id = msg.sessionId || state.sessionId;
  const version = msg.mediaVersion ?? state.mediaVersion;
  const payload = Object.assign({ target: 'offscreen', sessionId: id, mediaVersion: version }, msg);
  const epoch = sessionEpoch;
  const valid = () => (msg.type === 'NT_OFF_STOP' || (state.active && state.sessionId === id && sessionEpoch === epoch)) &&
    (msg.duckOperation == null || msg.duckOperation === duckOperation) &&
    (msg.voiceEpoch == null || msg.voiceEpoch === voiceEpoch) &&
    (msg.settingsRevision == null || msg.settingsRevision === settingsRevision) &&
    (!['NT_OFF_SPEAK', 'NT_OFF_DUCK', 'NT_OFF_PREFETCH'].includes(msg.type) ||
      (!state.paused && state.mediaVersion === version && (!msg.deadline || Date.now() <= msg.deadline) &&
       (!Number.isFinite(msg.startBy) || Date.now() < msg.startBy)));
  for (let i = 0; i < tries; i++) {
    if (!valid()) return CANCELLED;
    let res;
    try {
      res = await chrome.runtime.sendMessage(payload);
    } catch (e) { /* not ready yet */ }
    if (!valid()) return CANCELLED;
    if (res && res.ok) return res;
    if (res && res.error) throw new Error(res.error);
    await new Promise((r) => setTimeout(r, 60));
    if (!valid()) return CANCELLED;
  }
  throw new Error('Offscreen document did not respond');
}

// ─── Content script ─────────────────────────────────────────
async function ensureContent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'NT_PING' }, { frameId: 0 });
    if (res && res.ok) return;
  } catch (e) { /* not injected */ }
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: CONTENT_FILES });
}

// ─── Start / stop ───────────────────────────────────────────
function isTranslatableUrl(url) {
  return /^(https?|file):/i.test(url || '') && !/^https:\/\/chromewebstore\.google\.com/i.test(url) && !/^https:\/\/chrome\.google\.com\/webstore/i.test(url);
}

async function start(tabId, signal = lifecycleAbort.signal) {
  await stateLoaded;
  if (signal.aborted) return CANCELLED;
  await stopping;
  if (signal.aborted) return CANCELLED;
  const revision = settingsRevision;
  const settings = await ntGetSettings();
  if (signal.aborted) return CANCELLED;
  if (revision !== settingsRevision) return start(tabId,signal);
  ntSetLang(settings.uiLang);
  const problems = ntValidate(settings);
  if (problems.length) return { ok: false, error: problems[0] };

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (signal.aborted) return CANCELLED;
  if (revision !== settingsRevision) return start(tabId,signal);
  if (!tab || !isTranslatableUrl(tab.url)) return { ok: false, error: 'badPage' };

  if (state.active) await cleanupSession();
  if (signal.aborted) return CANCELLED;
  if (revision !== settingsRevision) return start(tabId,signal);

  let domain = '';
  try { domain = new URL(tab.url).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ }

  state = Object.assign({}, IDLE_STATE, {
    active: true, tabId, source: settings.source, voice: settings.voice,
    targetLang: settings.targetLang, status: 'starting', startedAt: Date.now(), domain,
    sessionId: crypto.randomUUID()
  });
  sessionEpoch++;
  lastOriginal = '';
  lastSubtitle = null;
  cancelTranslations();
  saveState();
  const id = state.sessionId;
  const current = () => !signal.aborted && state.active && state.sessionId === id;

  try {
    await ensureContent(tabId);
    if (!current()) return CANCELLED;

    let wantsCapture = wantsSpeakerCapture(settings);
    const requiresOffscreen = settings.source === 'gemini' || OFFSCREEN_VOICES.includes(settings.voice);
    if (requiresOffscreen) await ensureOffscreen();
    else if (wantsCapture) {
      // Needed only for optional speaker detection: never fail the session over it.
      try { await ensureOffscreen(); }
      catch (error) { wantsCapture = false; state.captureError = error?.message || String(error); }
    }
    const needsOffscreen = requiresOffscreen || wantsCapture;
    if (!current()) return CANCELLED;

    if (settings.source === 'gemini') {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      if (!current()) return CANCELLED;
      await sendToOffscreen({ type: 'NT_OFF_START', streamId, settings, sessionId: id });
      state.capture = true;
    } else if (needsOffscreen) {
      // Speaker detection is optional: a refused capture leaves free mode working
      // with caption markup only, and says why in state.captureError.
      let streamId = null;
      if (wantsCapture) {
        try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }); }
        catch (error) { state.captureError = error?.message || String(error); }
        if (!current()) return CANCELLED;
      }
      let prepared = null;
      try { prepared = await sendToOffscreen({ type: 'NT_OFF_PREPARE', settings, sessionId: id, streamId }); }
      catch (error) {
        if (requiresOffscreen) throw error;
        state.captureError = error?.message || String(error);
      }
      if (!current()) return CANCELLED;
      state.capture = !!prepared?.capture;
      if (streamId && !state.capture && !state.captureError) state.captureError = prepared?.captureError || 'captureUnavailable';
    }
    saveState();
    if (!current()) return CANCELLED;

    await chrome.tabs.sendMessage(tabId, { type: 'NT_C_START', settings, sessionId: id }, { frameId: 0 });
    if (!current()) return CANCELLED;

    if (settings.source === 'gemini') { if (state.status === 'starting') setStatus('connecting'); }
    else if (!state.paused) setStatus('captions_wait');

    chrome.action.setBadgeText({ text: 'ON', tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#F26522' }).catch(() => {});
    return { ok: true };
  } catch (err) {
    if (!current()) return CANCELLED;
    console.error('[NeiroTranslate] start failed', err);
    const message = err && err.message ? err.message : String(err);
    await cleanupSession(true);
    if (signal.aborted) return CANCELLED;
    state.status = 'error';
    state.detail = message;
    saveState();
    return { ok: false, error: 'raw', detail: message };
  }
}

function wantsSpeakerCapture(settings) {
  return settings.source === 'captions' && settings.multiVoice !== false && settings.speakerAudio !== false && settings.voice !== 'off';
}

function stop(keepError = false) {
  const previous = lifecycleAbort;
  lifecycleAbort = new AbortController();
  previous.abort();
  const cleanup = stateLoaded.then(() => cleanupSession(keepError));
  stopping = Promise.all([stopping, cleanup]).then(() => {});
  return stopping;
}

function cleanupSession(keepError = false) {
  const cleanup = teardownSession(keepError);
  stopping = Promise.all([stopping, cleanup]).then(() => {});
  return cleanup;
}

async function teardownSession(keepError = false) {
  const prev = state;
  sessionEpoch++;
  browserSpeechEpoch++;
  voiceEpoch++;
  clearTimeout(browserSpeechTimer);
  clearTimeout(subtitleTimer);
  cancelTranslations();
  voiceQueue.clear();
  speakerBook.reset();
  state = Object.assign({}, IDLE_STATE);
  ttsQueue.length = 0;
  ttsBusy = false;
  chrome.tts.stop();
  broadcast({ type: 'NT_SUBTITLE', text: '', original: '', final: true });
  if (prev.tabId != null) {
    chrome.tabs.sendMessage(prev.tabId, { type: 'NT_C_STOP' }, { frameId: 0 }).catch(() => {});
    chrome.action.setBadgeText({ text: '', tabId: prev.tabId }).catch(() => {});
  }
  if (offscreenCreating) await offscreenCreating.catch(() => {});
  try { if (await hasOffscreen()) await sendToOffscreen({ type: 'NT_OFF_STOP', sessionId: prev.sessionId }, 3); } catch (e) { /* ignore */ }
  await closeOffscreen();
  if (prev.active && prev.startedAt) recordSession(prev);
  lastSubtitle = null;
  lastOriginal = '';
  if (!keepError) saveState();
}

let historyWrites = Promise.resolve();
let historyRevision = 0;

function recordSession(s) {
  const durationSec = Math.round((Date.now() - s.startedAt) / 1000);
  if (durationSec < 3) return;
  const revision = historyRevision;
  const session = {
    id: crypto.randomUUID(), startTime: s.startedAt, durationSec,
    lang: s.targetLang, domain: s.domain, source: s.source, voice: s.voice
  };
  historyWrites = historyWrites.then(async () => {
    if (revision !== historyRevision) return;
    const res = await new Promise((resolve, reject) => {
      chrome.storage.local.get({ nt_sessions: [] }, (value) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || String(error)));
        else resolve(value);
      });
    });
    if (revision !== historyRevision) return;
    const sessions = Array.isArray(res?.nt_sessions) ? res.nt_sessions : [];
    sessions.unshift(session);
    if (sessions.length > 2000) sessions.length = 2000;
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ nt_sessions: sessions }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || String(error)));
        else resolve();
      });
    });
  }).catch(error => console.warn('[NeiroTranslate] History save failed:', error.message));
}

// ─── Subtitles & voice ──────────────────────────────────────
function emitSubtitle(text, original, final, deadline) {
  clearTimeout(subtitleTimer);
  lastSubtitle = { text, original: original || '', final: !!final, ts: Date.now(), deadline };
  const msg = Object.assign({ type: 'NT_SUBTITLE', sessionId: state.sessionId, mediaVersion: state.mediaVersion }, lastSubtitle);
  broadcast(msg);
  sendToTab(Object.assign({}, msg, { type: 'NT_C_SUBTITLE' }));
  if (deadline && (text || original)) {
    const current = lastSubtitle;
    subtitleTimer = setTimeout(() => {
      if (state.active && lastSubtitle === current) emitSubtitle('', '', true);
    }, Math.max(0, deadline - Date.now()));
  }
}

async function speak(text, deadline = Date.now() + 2500, expectedTarget = state.targetLang, extra = {}) {
  if (!text || !state.active || state.paused) return;
  const epoch = sessionEpoch;
  const revision = settingsRevision;
  let s;
  try {s=await ntGetSettings();}
  catch(error) {if(epoch===sessionEpoch && state.active)setStatus('voice_error',error.message);return;}
  if(revision!==settingsRevision)return;
  if (!state.active || state.paused || epoch !== sessionEpoch || (s.syncMode !== 'complete' && Date.now() > deadline) ||
      (state.source && s.source!==state.source)) return;
  // A failed storage notification must not leave the actual session permanently
  // on an old provider. Reconcile again from a successful read on the next cue.
  if (state.voice!==s.voice || state.targetLang!==s.targetLang) {
    voiceQueue.clear();cancelBrowserSpeech();voiceEpoch++;setDuck(false);
    if(captionPrefetch){captionPrefetch.abort();captionPrefetch=null;}
    state.voice=s.voice;state.targetLang=s.targetLang;saveState();
    try {
      if(await hasOffscreen()) {
        if(revision!==settingsRevision)return;
        await sendToOffscreen({type:'NT_OFF_SETTINGS',settings:s,settingsRevision:revision},3);
      }
    } catch(error) {if(epoch===sessionEpoch)setStatus('voice_error',error.message);}
    if(!state.active || state.paused || epoch!==sessionEpoch)return;
  }
  if(revision!==settingsRevision || (expectedTarget && s.targetLang!==expectedTarget))return;
  if(!['browser',...OFFSCREEN_VOICES].includes(s.voice))return;
  const now = Date.now();
  const realtime = s.syncMode !== 'complete';
  const syncEnd = realtime && Number.isFinite(extra.syncEnd) ? extra.syncEnd : null;
  // Realtime: a phrase whose slot is long over would only be said over the next
  // one; its subtitle was already shown, so skip the voice.
  if (realtime && syncEnd && now > syncEnd + NT_TIMING.LATE_START_MS) return;
  voiceQueue.maxPending = realtime ? 1 : COMPLETE_BACKLOG_LIMIT;
  const accepted = voiceQueue.enqueue({text,parts:extra.parts || null,settings:s,epoch,deadline,syncEnd,retain:!realtime,
    startBy: realtime ? realtimeStartBy(text, syncEnd, deadline, s, now) : Infinity,
    cutAt: realtime && syncEnd ? syncEnd + NT_TIMING.OVERRUN_CUT_MS : Infinity});
  if (!accepted && !realtime) setStatus('voice_error','completeBacklogFull');
  prepareNextVoice();
}

// Latest moment a waiting phrase may still start: it must be able to finish,
// at the fastest allowed tempo, before its slot is overrun. Waiting behind a
// phrase that is still in time is fine; starting hopelessly late is not.
function realtimeStartBy(text, syncEnd, deadline, s, now) {
  if (!syncEnd) return Math.min(now + NT_TIMING.REALTIME_START_BUDGET_MS, deadline + 1500);
  const fastestMs = ntEstimateSpeechMs(text) / Math.max(1, Number(s.maxTempo) || 1.6);
  const latest = syncEnd + NT_TIMING.LATE_START_MS - fastestMs;
  return Math.max(now + 400, Math.min(now + 4000, latest));
}

function completeVoice(token, error = '') {
  if (token !== voiceEpoch) return;
  if (error && state.active && !state.paused) setStatus('voice_error',error);
  if (activeVoiceCompletion?.token === token) activeVoiceCompletion.finish();
}

// One queue item may hold several speakers (dialogue cue). Parts play in order
// under the same owner; each gets a share of the remaining sync window.
async function playVoice(item, signal) {
  const parts = Array.isArray(item.parts) && item.parts.length ? item.parts : [{text:item.text, speaker:item.speaker || null}];
  for (let i = 0; i < parts.length; i++) {
    if (signal.aborted || !state.active || state.paused || item.epoch !== sessionEpoch) return;
    let syncEnd = item.syncEnd;
    if (Number.isFinite(syncEnd) && parts.length > 1) {
      const rest = parts.slice(i).reduce((sum, part) => sum + ntSpeechUnits(part.text), 0) || 1;
      syncEnd = Date.now() + Math.max(0, syncEnd - Date.now()) * ntSpeechUnits(parts[i].text) / rest;
    }
    const before = voiceEpoch;
    await playVoicePart(Object.assign({}, item, {text:parts[i].text, speaker:parts[i].speaker || null, syncEnd,
      startBy: item.retain || i ? Date.now() + 3000 : item.startBy}), signal);
    // Audio start (browser 'start' event / scheduled offscreen audio) sets
    // expectedSpeechEnd for a newer token. A part that never sounded was
    // dropped as late or failed: the reply must not be spoken without it.
    if (expectedSpeechEnd.token <= before) return;
  }
}

// Provider-specific voice for a speaker (pitch, Yandex voice, ElevenLabs voice).
function offscreenVoice(provider, speaker, s) {
  const params = speaker ? ntPickSpeakerVoice(provider, speaker, speakerBook, {settings:s, lang:ntFindLanguage(s.targetLang).gt}) : {pitch:1};
  return Object.assign({}, params, {speakerKey: speaker?.key || null});
}

async function playVoicePart(item, signal) {
  if (!state.active || state.paused || item.epoch !== sessionEpoch || signal.aborted || Date.now() >= item.startBy) return;
  const s = await ntGetSettings();
  if (!state.active || state.paused || item.epoch !== sessionEpoch || signal.aborted ||
      Date.now() >= item.startBy || s.voice!==item.settings.voice || s.targetLang!==item.settings.targetLang) return;
  if ((state.voice && s.voice !== state.voice) || (state.targetLang && s.targetLang !== state.targetLang)) return;
  const token = ++voiceEpoch;
  saveState(); cancelBrowserSpeech(); setDuck(false);
  // Keep current speech intact across short CC updates; never keep it indefinitely.
  const estimatedSpeechMs=Math.max(3000,Math.min(12000,item.text.length*70+2200));
  const deadline = item.retain ? Date.now()+estimatedSpeechMs : Math.min(Date.now()+15000,Math.max(item.deadline+1500,Date.now()+estimatedSpeechMs));
  const current = () => state.active && !state.paused && item.epoch === sessionEpoch && token === voiceEpoch && !signal.aborted;
  return new Promise(resolve => {
    let finished = false;
    let watchdog = 0;
    const owner = {token,startBy:item.startBy,finish:() => {
      if (finished) return;
      finished = true; clearTimeout(watchdog);signal.removeEventListener('abort',cancel);
      if (activeVoiceCompletion === owner) activeVoiceCompletion = null;
      resolve();
    }};
    const cancel = () => {
      if (token === voiceEpoch) {
        voiceEpoch++; cancelBrowserSpeech(); setDuck(false);
        sendToOffscreen({type:'NT_OFF_CLEAR',voiceEpoch},1).catch(() => {});
      }
      owner.finish();
    };
    activeVoiceCompletion = owner;
    signal.addEventListener('abort',cancel,{once:true});
    watchdog = setTimeout(() => {
      if (token === voiceEpoch) {
        cancelBrowserSpeech();setDuck(false);
        sendToOffscreen({type:'NT_OFF_CLEAR',voiceEpoch:token},1).catch(() => {});
        completeVoice(token,'voiceRequestTimeout');
      } else owner.finish();
    },Math.max(1,deadline-Date.now()+250));
    (async () => {
      let offscreen = await hasOffscreen();
      if (!offscreen && OFFSCREEN_VOICES.includes(s.voice)) {
        await ensureOffscreen();
        if (!current()) return owner.finish();
        if (state.source==='captions') await prepareCaptionsAudio({type:'NT_OFF_PREPARE',settings:s,voiceEpoch:token},3);
        offscreen=true;
      }
      if (!current()) return owner.finish();
      if (offscreen) await sendToOffscreen({type:'NT_OFF_CLEAR',voiceEpoch:token,keepElevenContext:true},3);
      if (!current()) return owner.finish();
      if (Date.now() >= item.startBy) return owner.finish();
      if (Date.now() > deadline) return completeVoice(token,'voiceRequestTimeout');
      const lang = ntFindLanguage(s.targetLang);
      const timing = {syncEnd:item.syncEnd, speaker:item.speaker};
      if (s.voice === 'browser') speakBrowser(item.text,lang,s,deadline,true,token,item.startBy,timing);
      else {
        const result=await sendToOffscreen({type:'NT_OFF_SPEAK',text:item.text,lang,settings:s,deadline,startBy:item.startBy,voiceEpoch:token,
          syncEnd:item.syncEnd,maxTempo:s.maxTempo,voice:offscreenVoice(s.voice,item.speaker,s)},5);
        if (result?.cancelled || result?.ignored) completeVoice(token,'voiceRequestTimeout');
      }
      prepareNextVoice();
    })().catch(error => {if (current()) completeVoice(token,error.message); else owner.finish();});
  });
}

async function prepareNextVoice() {
  const next = voiceQueue.peek();
  if (!next || next.retain || next.settings.voice !== 'google' || next.epoch !== sessionEpoch || state.paused || next.startBy < Date.now()) return;
  const s = next.settings;
  try {
    if (!(await hasOffscreen()) || next.epoch !== sessionEpoch || state.paused) return;
    await sendToOffscreen({type:'NT_OFF_PREFETCH',text:next.text,lang:ntFindLanguage(s.targetLang),deadline:next.startBy,
      preparationKey:JSON.stringify([s.voice,s.targetLang,s.sourceLang || ''])},1);
  } catch (ignored) { /* Playback still has its normal fetch path. */ }
}

// With tab capture the page's own volume feeds the capture: duck in the audio page's mixer instead.
function setDuck(on) {
  const operation = ++duckOperation, epoch = sessionEpoch, id = state.sessionId, version = state.mediaVersion;
  const current = () => operation === duckOperation && epoch === sessionEpoch && id === state.sessionId &&
    version === state.mediaVersion && state.active && !state.paused;
  if (state.source === 'gemini') sendToOffscreen({ type: 'NT_OFF_DUCK', on, duckOperation:operation }, 3).catch(() => {});
  else if (state.capture) {
    // The audio page (and its capture) may be gone: fall back to the page's <video>.
    sendToOffscreen({ type: 'NT_OFF_DUCK', on, duckOperation:operation }, 3).catch(() => {
      if (!current() || !state.capture) return;
      state.capture = false; saveState();
      sendToTab({ type: 'NT_C_DUCK', on });
    });
  } else sendToTab({ type: 'NT_C_DUCK', on });
}

// A recreated audio page has no capture: keep state.capture honest so ducking
// and speaker queries go to the right place.
async function prepareCaptionsAudio(message, tries) {
  const result = await sendToOffscreen(message, tries);
  if (state.source === 'captions' && result && !result.ignored && !result.cancelled && state.capture !== !!result.capture) {
    state.capture = !!result.capture; saveState();
  }
  return result;
}

// Browser voices via chrome.tts (works in Chrome, Edge, Yandex Browser, Opera, Brave).
const ttsQueue = [];
let ttsBusy = false;
let browserSpeechTimer = 0;
let browserStartTimer = 0;
let voiceCache = null;
let voiceLoading = null;

function getVoices() {
  if (voiceCache) return Promise.resolve(voiceCache);
  if (voiceLoading) return voiceLoading;
  voiceLoading = new Promise(resolve => {
    let settled = false;
    const finish = voices => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(voices);
    };
    const timer = setTimeout(() => finish([]),1500);
    try {
      chrome.tts.getVoices(voices => {
        if (chrome.runtime.lastError) return finish([]);
        voiceCache = voices?.length ? voices : null;
        finish(voices || []);
      });
    } catch (error) {finish([]);}
  }).finally(() => {voiceLoading = null;});
  return voiceLoading;
}

function voicesFor(voices, lang) {
  const prefix = lang.tts.split('-')[0].toLowerCase();
  return voices.filter((v) => (v.lang || '').toLowerCase().startsWith(prefix));
}

function pickVoice(voices, lang, preferredName) {
  const matches = voicesFor(voices, lang);
  const preferred = matches.find((v) => v.voiceName === preferredName);
  if (preferred) return preferred.voiceName;
  const score = (v) => (v.remote === false ? 8 : 0) + (/natural|neural/i.test(v.voiceName) ? 3 : 0) + (/online|google/i.test(v.voiceName) ? 2 : 0) + (v.remote ? 1 : 0);
  matches.sort((a, b) => score(b) - score(a));
  return matches.length ? matches[0].voiceName : undefined;
}

function cancelBrowserSpeech() {
  browserSpeechEpoch++;
  clearTimeout(browserSpeechTimer);
  clearTimeout(browserStartTimer);
  ttsQueue.length = 0; ttsBusy = false;
  chrome.tts.stop();
}

async function speakBrowser(text, lang, s, deadline = Date.now() + 2500, allowFallback = true, token = voiceEpoch, startBy = deadline, timing = {}) {
  if (token !== voiceEpoch || !state.active || state.paused) return;
  if (ttsBusy) { cancelBrowserSpeech(); setDuck(false); }
  ttsQueue.push({ text, lang, s, deadline, allowFallback, token, startBy, timing: timing || {} });
  while (ttsQueue.length > 1) ttsQueue.shift();
  pumpBrowserTts();
}

async function pumpBrowserTts() {
  if (!state.active || state.paused || ttsBusy || !ttsQueue.length) return;
  ttsBusy = true;
  const epoch = browserSpeechEpoch;
  const { text, lang, s, deadline, allowFallback, token, startBy, timing } = ttsQueue.shift();
  if (Date.now() > deadline) { ttsBusy = false;completeVoice(token,'voiceRequestTimeout');return pumpBrowserTts(); }
  const voices = await getVoices();
  if (!state.active || state.paused || epoch !== browserSpeechEpoch || token !== voiceEpoch) return;
  if (Date.now() >= startBy) { ttsBusy = false;completeVoice(token);return pumpBrowserTts(); }
  if (Date.now() > deadline) { ttsBusy = false;completeVoice(token,'voiceRequestTimeout');return pumpBrowserTts(); }
  const primary = pickVoice(voices, lang, s.browserVoiceName);
  let voiceName = primary, pitch = 1;
  if (timing.speaker && primary) {
    const choice = ntPickSpeakerVoice('browser', timing.speaker, speakerBook, {voices: voicesFor(voices, lang), primary});
    voiceName = choice.voiceName || primary; pitch = choice.pitch || 1;
  }
  // Fit the phrase into its sync window: measured speed of this voice, never
  // slower than the user's rate, never faster than the configured ceiling.
  const base = Number(s.browserRate) || 1;
  const calibrationKey = 'browser:' + voiceName;
  const speechMs = ntEstimateSpeechMs(text, voiceCalibration.cps(calibrationKey, text));
  const rate = Number.isFinite(timing.syncEnd)
    ? ntPlanTempo({speechMs, availableMs: timing.syncEnd - Date.now(), base, max: Number(s.maxTempo) || 1.6}) : base;
  let finished = false;
  let started = false, startedAt = 0, lastChar = 0;
  const finish = (error, remaining = text) => {
    if (finished || epoch !== browserSpeechEpoch || !state.active) return;
    finished = true;
    clearTimeout(browserSpeechTimer);
    clearTimeout(browserStartTimer);
    ttsBusy = false;
    if (!ttsQueue.length) setDuck(false);
    pumpBrowserTts();
    if (error) {
      voiceCache = null;
      // First-start freshness was satisfied by the audible prefix. A known
      // remainder may recover until completion, without replaying that prefix.
      const fallbackStartBy = started && lastChar > 0 ? deadline : startBy;
      if (allowFallback && remaining.trim()) googleVoiceFallback(remaining, lang, s, deadline, token, timing, fallbackStartBy).catch(e => {if (token === voiceEpoch) completeVoice(token,e.message);});
      else {setStatus('voice_error', error); completeVoice(token);}
    } else completeVoice(token);
  };
  if (!voiceName) return finish('browserVoiceUnavailable');
  const options = {
    lang: lang.tts, voiceName, rate: Math.min(10, rate), pitch: Math.max(0.1, Math.min(2, pitch)), volume: Math.min(1, s.dubVolume), enqueue: false,
    onEvent: (e) => {
      if (finished || epoch !== browserSpeechEpoch || !state.active) return;
      if (e.type === 'start') {
        if (Date.now() >= startBy) { finish('');chrome.tts.stop();return; }
        started=true;startedAt=Date.now();clearTimeout(browserStartTimer);setDuck(true);
        expectedSpeechEnd = {token, at: startedAt + speechMs / rate};
      }
      if (Number.isInteger(e.charIndex) && e.charIndex >= 0) lastChar=Math.min(text.length,Math.max(lastChar,e.charIndex));
      if (e.type === 'end' && started) voiceCalibration.observe(calibrationKey, text, Date.now() - startedAt, rate);
      if (TTS_DONE.includes(e.type)) {
        const error=e.type==='end'?'':e.errorMessage || 'browserVoiceUnavailable';
        const remainder=started && !lastChar && e.charIndex==null ? '' : text.slice(lastChar);
        finish(error,remainder);
      }
    }
  };
  browserSpeechTimer = setTimeout(() => {
    if (epoch !== browserSpeechEpoch || finished) return;
    finish('');
    chrome.tts.stop();
  }, Math.max(1, deadline - Date.now()));
  browserStartTimer = setTimeout(() => {
    const check = speaking => {
      if (finished || epoch !== browserSpeechEpoch) return;
      if (!started && Date.now() >= startBy) {finish('');chrome.tts.stop();return;}
      if (speaking && started) return setDuck(true);
      finish('browserVoiceUnavailable');chrome.tts.stop();
    };
    if (typeof chrome.tts.isSpeaking === 'function') chrome.tts.isSpeaking(check);
    else check(false);
  },Math.min(1500,Math.max(1,Math.min(startBy,deadline)-Date.now())));
  try {
    chrome.tts.speak(text, options, () => {
      if (chrome.runtime.lastError) finish(chrome.runtime.lastError.message || 'browserVoiceUnavailable');
    });
  } catch (error) { finish(error.message || 'browserVoiceUnavailable'); }
}

async function googleVoiceFallback(text, lang, settings, deadline, token = voiceEpoch, timing = {}, startBy = deadline) {
  const epoch = sessionEpoch;
  const current = () => state.active && !state.paused && epoch === sessionEpoch && token === voiceEpoch && Date.now() <= deadline && Date.now() < startBy;
  const expired = () => {if (token===voiceEpoch && (Date.now()>deadline || Date.now()>=startBy)) completeVoice(token,'voiceRequestTimeout');};
  if (!current()) return expired();
  await ensureOffscreen();
  if (!current()) return expired();
  if (state.source === 'captions') {
    await prepareCaptionsAudio({type:'NT_OFF_PREPARE',settings,sessionId:state.sessionId,voiceEpoch:token});
    if (!current()) return expired();
    await sendToOffscreen({type:'NT_OFF_MEDIA',paused:state.paused,voiceEpoch:token});
  }
  if (!current()) return expired();
  setStatus('voice_fallback', 'usingGoogleVoice');
  await sendToOffscreen({type:'NT_OFF_SPEAK',text,lang,settings:{...settings,voice:'google'},deadline,startBy,fallback:true,voiceEpoch:token,
    syncEnd:timing?.syncEnd,maxTempo:settings.maxTempo,voice:offscreenVoice('google',timing?.speaker || null,settings)});
}

// Each speaker part is translated separately so voices stay with their words.
async function translateParts(parts, target, source, signal) {
  const results = await Promise.all(parts.map(part => ntTranslate(part.text, target, source, signal)));
  const failed = results.find(result => !result.ok);
  if (failed) return failed;
  const texts = results.map(result => result.text);
  return {ok:true, texts, detected:results[0].detected, detectedParts:results.map(result => result.detected),
    text: texts.length > 1 ? texts.map(text => '— ' + text).join(' ') : texts[0]};
}

// Pitch of the original audio during [from, to] → speaker cluster, or null.
async function querySpeaker(from, to, s) {
  if (!state.capture || s.multiVoice === false || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  let timer = 0;
  try {
    // Never let speaker detection delay a voice by more than a frame or two.
    const result = await Promise.race([
      sendToOffscreen({type:'NT_OFF_SPEAKER', from, to, previous: speakerBook.lastCluster}, 1),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); })
    ]);
    return result?.speaker || null;
  } catch (ignored) { return null; }
  finally { clearTimeout(timer); }
}

function cancelTranslations() {
  if (captionPrefetch) {captionPrefetch.abort(); captionPrefetch = null;}
  for (const request of translations) request.abort();
  translations.clear();
  completeTranslations.clear();
  captionOrderTail = Promise.resolve();
  captionSequence = displayedSequence = 0;
}

async function handleCaptionPrefetch(text, sourceLang, timing) {
  const ahead = timing.startAt - Date.now();
  if (!state.active || state.paused || state.source !== 'captions' || timing.mediaVersion !== state.mediaVersion ||
      !(ahead > 0 && ahead <= 4000) || typeof text !== 'string' || text.length > 600) return;
  if (captionPrefetch) captionPrefetch.abort();
  const abort = new AbortController(); captionPrefetch = abort;
  const epoch = sessionEpoch, target = state.targetLang;
  const current = () => !abort.signal.aborted && state.active && !state.paused && epoch === sessionEpoch && target === state.targetLang;
  try {
    // Prepare exactly what handleCaption will speak, so both caches hit. Dialogue
    // cues are translated per speaker and are not worth preparing.
    const parts = ntParseSpeakerTurns(text);
    if (parts.length !== 1) return;
    const s = await ntGetSettings();
    if (!current()) return;
    const lang = ntFindLanguage(s.targetLang);
    const result = await ntTranslate(parts[0].text, lang.gt, s.sourceLang || sourceLang, abort.signal);
    if (!current() || !result.ok || s.voice !== 'google' || !(await hasOffscreen()) || !current()) return;
    if (result.detected?.split('-')[0] === lang.gt.split('-')[0]) return;
    const spoken = ntSpeakableText(result.text);
    if (!spoken) return;
    await sendToOffscreen({type:'NT_OFF_PREFETCH',text:spoken,lang,deadline:timing.startAt+2500,
      preparationKey:JSON.stringify([s.voice,s.targetLang,s.sourceLang || ''])},1);
  } catch (error) { /* Preparation is optional; the current cue still has its normal path. */ }
  finally {if (captionPrefetch === abort) captionPrefetch = null;}
}

function handleMediaState(message) {
  if (!state.active || !Number.isInteger(message.version) || message.version <= state.mediaVersion) return;
  state.mediaVersion = message.version;
  state.paused = !!message.paused;
  sessionEpoch++;
  browserSpeechEpoch++;
  voiceEpoch++;
  clearTimeout(browserSpeechTimer);
  cancelTranslations();
  voiceQueue.clear();
  ttsQueue.length = 0; ttsBusy = false; chrome.tts.stop();
  setDuck(false);
  lastOriginal = ''; lastSubtitle = null;
  emitSubtitle('', '', true);
  sendToOffscreen({type:'NT_OFF_MEDIA',paused:state.paused}, 1).catch(() => {});
  setStatus(state.paused ? 'paused' : state.source === 'captions' ? 'captions_wait' : 'connecting');
}

// A stalled earlier request must not hold fresh captions in a promise chain.
function handleCaption(text, sourceLang, timing = {}) {
  if (!state.active || state.paused || state.source !== 'captions') return;
  if (timing.mediaVersion != null && timing.mediaVersion !== state.mediaVersion) return;
  const epoch = sessionEpoch;
  const target = state.targetLang;
  const receivedAt = Date.now();
  let deadline = timing.deadline || receivedAt + 2500;
  let requestDeadline = Math.min(deadline, receivedAt + 2500);
  if (deadline <= receivedAt) return;
  // Speaker markup (">>", dialogue dashes, <v Name>) splits one caption into
  // parts; display and speech never contain the markers themselves.
  const parts = ntParseSpeakerTurns(text);
  if (!parts.length) return;
  const original = parts.length > 1 ? parts.map(part => '— ' + part.text).join(' ') : parts[0].text;
  const sequence = ++captionSequence;
  const abort = new AbortController();
  const previousCaption = captionOrderTail;
  let releaseCaption;
  const captionReservation = new Promise(resolve => {releaseCaption = resolve;});
  captionOrderTail = captionReservation;
  translations.add(abort);
  if (state.status !== 'translating') setStatus('translating');
  ntGetSettings().then(async (s) => {
    if (abort.signal.aborted || epoch !== sessionEpoch) return;
    const complete = s.syncMode === 'complete';
    if (complete) {
      if (completeTranslations.size + voiceQueue.pendingCount + Number(voiceQueue.active) >= COMPLETE_BACKLOG_LIMIT) {
        if (captionOrderTail === captionReservation) captionOrderTail = previousCaption;
        setStatus('voice_error','completeBacklogFull');return;
      }
      completeTranslations.add(abort);
    } else {
      while (translations.size > 3) {
        const oldest = translations.values().next().value; oldest.abort();translations.delete(oldest);
      }
    }
    if(abort.signal.aborted)return;
    if (complete) {
      // Preserve accepted source order while retaining bounded upstream work.
      await Promise.race([previousCaption,new Promise(resolve => {
        if(abort.signal.aborted)resolve();else abort.signal.addEventListener('abort',resolve,{once:true});
      })]);
      if(abort.signal.aborted || epoch!==sessionEpoch)return;
    }
    const lang = ntFindLanguage(s.targetLang);
    let r = await translateParts(parts, lang.gt, s.sourceLang || sourceLang, abort.signal);
    let retried=false;
    if(!r.ok && !r.cancelled && !abort.signal.aborted && epoch===sessionEpoch && sequence===captionSequence &&
       state.active && !state.paused && !/429|quota|limit|target language/i.test(r.detail || '')) {
      const still=await sendToTab({type:'NT_C_CHECK_CAPTION',text,sessionId:state.sessionId,mediaVersion:state.mediaVersion});
      if(still?.current && still.deadline>Date.now() && !abort.signal.aborted && epoch===sessionEpoch && sequence===captionSequence) {
        retried=true;deadline=still.deadline;requestDeadline=Math.min(deadline,Date.now()+2500);
        r=await translateParts(parts,lang.gt,s.sourceLang || sourceLang,abort.signal);
      }
    }
    if(retried && !complete && sequence!==captionSequence)return;
    if (abort.signal.aborted || r.cancelled || !state.active || state.paused || epoch !== sessionEpoch || target !== state.targetLang ||
        (!complete && (sequence < displayedSequence || Date.now() > requestDeadline))) return;
    if (!r.ok) { setStatus('translation_error', r.error || 'translationUnavailable'); return; }
    displayedSequence = sequence;
    setStatus('translating');
    emitSubtitle(r.text, original, true, deadline);
    // Asked after translation on purpose: by then more of the phrase has been
    // heard, which matters for cues that are read before they are spoken.
    const acoustic = await querySpeaker(timing.spokenFrom, timing.spokenTo, s);
    if (abort.signal.aborted || epoch !== sessionEpoch || !state.active || state.paused) return;
    const voiced = parts.map((part, i) => ({text: ntSpeakableText(r.texts ? r.texts[i] : r.text),
      detected:r.detectedParts?.[i],speaker: s.multiVoice !== false ? speakerBook.resolve(part, acoustic, i) : null}))
      .filter(part => part.text && (!part.detected || part.detected.split('-')[0] !== lang.gt.split('-')[0]));
    if (voiced.length) await speak(voiced.map(part => part.text).join(' '), deadline, s.targetLang, {parts: voiced, syncEnd: timing.syncEnd});
  }).catch((e) => { if (!abort.signal.aborted && epoch === sessionEpoch) setStatus('translation_error', e.message); })
    .finally(() => {
      translations.delete(abort);completeTranslations.delete(abort);
      // Rejected/error exits may finish before their predecessor. Adopt its
      // completion so later accepted work cannot bypass the retained order.
      releaseCaption(previousCaption);
    });
}

// Gemini source: transcripts arrive already translated.
function handleTranscript(msg) {
  if (!state.active || state.paused) return;
  if (msg.kind === 'input') {
    lastOriginal = msg.text;
    if (lastSubtitle) emitSubtitle(lastSubtitle.text, lastOriginal, lastSubtitle.final);
    return;
  }
  if (state.status !== 'translating') setStatus('translating');
  emitSubtitle(msg.text, lastOriginal, msg.final);
  if (msg.final && state.voice !== 'gemini' && state.voice !== 'off') speakTranscript(msg.text);
}

// Gemini text arrives a moment after the speech it translates: give it its own
// natural length plus grace, and identify the speaker from the last seconds.
async function speakTranscript(text) {
  const epoch = sessionEpoch, now = Date.now();
  const spoken = ntSpeakableText(text);
  if (!spoken) return;
  let s;
  try { s = await ntGetSettings(); } catch (error) { return speak(spoken); }
  const acoustic = await querySpeaker(now - GEMINI_SPEAKER_WINDOW_MS, now - GEMINI_TRANSCRIPT_LAG_MS, s);
  if (epoch !== sessionEpoch) return;
  const speaker = s.multiVoice !== false ? speakerBook.resolve({}, acoustic, 0) : null;
  const syncEnd = now + ntEstimateSpeechMs(spoken) + NT_TIMING.DOM_SYNC_GRACE_MS;
  return speak(spoken, undefined, undefined, {parts:[{text:spoken, speaker}], syncEnd});
}

// ─── Messaging ──────────────────────────────────────────────
function handleMessage(msg, sender, sendResponse) {
  if (!msg || !msg.type || msg.target === 'offscreen') return false;
  if (msg.type.startsWith('NT_OFF_') && (!state.active || msg.sessionId !== state.sessionId)) return false;
  if (msg.type.startsWith('NT_OFF_') && msg.mediaVersion != null && msg.mediaVersion !== state.mediaVersion) return false;
  if (msg.type.startsWith('NT_OFF_') && msg.voiceEpoch != null && msg.voiceEpoch !== voiceEpoch) return false;

  switch (msg.type) {
    case 'NT_GET_STATE':
      stateLoaded.then(() => sendResponse({ state, subtitle: lastSubtitle }));
      return true;
    case 'NT_START':
      runLifecycle(signal => start(msg.tabId, signal)).then(sendResponse).catch(e => sendResponse({ ok: false, error: 'raw', detail: e.message }));
      return true;
    case 'NT_STOP':
      stop().then(() => sendResponse({ ok: true }));
      return true;
    case 'NT_OPEN_OVERLAY':
      chrome.windows.create({ url: chrome.runtime.getURL('src/overlay/overlay.html'), type: 'popup', width: 960, height: 260 });
      return false;
    case 'NT_GET_VOICES':
      voiceCache = null;
      getVoices().then((voices) => sendResponse({ voices }));
      return true;
    case 'NT_TEST_BROWSER_VOICE': {
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        sendResponse(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'voiceRequestTimeout' }), 15000);
      try {
        chrome.tts.speak(msg.text, {
          voiceName: msg.voiceName || undefined, lang: msg.lang, rate: msg.rate || 1,
          onEvent: event => {
            if (event.type === 'end') finish({ ok: true });
            else if (event.type === 'error') finish({ ok: false, error: 'browserVoiceUnavailable' });
            else if (['interrupted', 'cancelled'].includes(event.type)) finish({ ok: false, error: 'voiceTestCancelled' });
          }
        }, () => {
          if (chrome.runtime.lastError) finish({ ok: false, error: 'browserVoiceUnavailable' });
        });
      } catch (error) { finish({ ok: false, error: 'browserVoiceUnavailable' }); }
      return true;
    }

    // from content script
    case 'NT_MEDIA_STATE':
      if (sender.tab?.id === state.tabId && msg.sessionId === state.sessionId) handleMediaState(msg);
      return false;
    case 'NT_CAPTION':
      if (sender.tab && sender.tab.id === state.tabId && msg.sessionId === state.sessionId) handleCaption(msg.text, msg.sourceLang, msg);
      return false;
    case 'NT_CAPTION_PREFETCH':
      if (sender.tab?.id === state.tabId && msg.sessionId === state.sessionId) handleCaptionPrefetch(msg.text,msg.sourceLang,msg);
      return false;
    case 'NT_CONTENT_STATUS':
      if (sender.tab && sender.tab.id === state.tabId && msg.sessionId === state.sessionId && state.source === 'captions' && !state.paused) {
        if (msg.code === 'captions_none' || msg.code === 'captions_wait' || state.status !== 'translating') setStatus(msg.code);
      }
      return false;

    // from offscreen document
    case 'NT_OFF_STATUS':
      if (!state.paused) setStatus(msg.code, msg.detail);
      return false;
    case 'NT_OFF_SPEECH_END':
      if (msg.voiceEpoch === voiceEpoch && Number.isFinite(msg.at)) expectedSpeechEnd = {token: voiceEpoch, at: msg.at};
      return false;
    case 'NT_OFF_VOICE_DONE':
      completeVoice(msg.voiceEpoch);
      return false;
    case 'NT_OFF_VOICE_ERROR':
      if (msg.voiceEpoch != null && msg.voiceEpoch !== voiceEpoch) return false;
      if (!state.paused && !msg.fallback && state.voice === 'google') {
        const epoch = sessionEpoch;
        const token = voiceEpoch;
        ntGetSettings().then(s => {
          if (epoch !== sessionEpoch || token !== voiceEpoch || state.paused || !state.active) return;
          setStatus('voice_fallback', 'usingBrowserVoice');
          return speakBrowser(msg.text, msg.lang, s, msg.deadline, false, token, msg.startBy ?? activeVoiceCompletion?.startBy ?? msg.deadline,
            {syncEnd: msg.syncEnd, speaker: msg.speakerKey ? speakerBook.profiles.get(msg.speakerKey) || null : null});
        }).catch(e => completeVoice(token,e.message));
      } else if (!state.paused) {setStatus('voice_error', msg.detail);completeVoice(msg.voiceEpoch);}
      return false;
    case 'NT_OFF_TRANSCRIPT':
      handleTranscript(msg);
      return false;
    case 'NT_OFF_SPEAKING':
      if (state.source === 'captions') setDuck(msg.on);
      return false;
    case 'NT_OFF_FATAL':
      runLifecycle(async () => {
        if (!state.active || state.sessionId !== msg.sessionId) return;
        const detail = msg.detail;
        const cleanup = stop();
        const controller = lifecycleAbort;
        await cleanup;
        if (controller !== lifecycleAbort || state.active) return;
        state.status = 'error'; state.detail = detail; saveState();
      });
      return false;
    default:
      return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.target === 'offscreen') return false;
  if (stateReady) return handleMessage(msg, sender, sendResponse);
  // Content resumes independently while a sleeping worker restores session state.
  // Keep the message channel open so its first media event is not lost.
  stateLoaded.then(() => {
    let replied = false;
    const reply = result => { replied = true; sendResponse(result); };
    if (!handleMessage(msg, sender, reply) && !replied) reply({ok:true});
  }).catch(error => sendResponse({ok:false,error:'raw',detail:error.message}));
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-translation') return;
  await stateLoaded;
  if (state.active) return stop();
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target) {
    const res = await runLifecycle(signal => start(target.id, signal));
    if (!res.ok) {
      state.status = 'error';
      state.detail = res.error === 'raw' ? res.detail : ntT(res.error);
      saveState();
    }
  }
});

// Forward live setting changes (volume, target language, voice) to the running pipeline.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (Object.hasOwn(changes, 'nt_sessions')) {
    const value = changes.nt_sessions.newValue;
    if (!Array.isArray(value) || value.length === 0) historyRevision++;
  }
  if (keys.every((k) => k === 'nt_sessions')) return;
  settingsRevision++;
  const lifecycleOwner = lifecycleAbort;
  await stateLoaded;
  if (lifecycleOwner !== lifecycleAbort || !state.active) return;
  // Capture can only be (un)installed at session start.
  if (changes.source || (state.source === 'captions' && (changes.speakerAudio || changes.multiVoice))) {
    const tabId = state.tabId;
    const cleanup = stop();
    const controller = lifecycleAbort;
    await cleanup;
    if (controller !== lifecycleAbort || state.active) return;
    return runLifecycle(async signal => {
      const result = await start(tabId,signal);
      if (!result.ok && controller === lifecycleAbort) {
        state.status='error';state.detail=result.error==='raw'?'raw|'+result.detail:result.error;saveState();
      }
    }).catch(error=>{
      if(controller===lifecycleAbort){state.status='error';state.detail='raw|'+error.message;saveState();}
    });
  }
  const id = state.sessionId;
  const current = () => state.active && state.sessionId === id;
  return runLifecycle(async () => {
    if (!current()) return;
    const s = await ntGetSettings();
    if (!current()) return;
    const elevenChanged = state.voice === 'elevenlabs' && ['elevenApiKey', 'elevenVoiceId', 'elevenVoiceId2',
      'elevenModel', 'elevenStability', 'elevenSimilarity', 'elevenSpeakerBoost', 'elevenContinuity'].some(key => changes[key]);
    const resetVoice=(changes.voice && state.voice!==s.voice)||(changes.targetLang && state.targetLang!==s.targetLang)||changes.sourceLang||changes.syncMode||elevenChanged;
    if (resetVoice) {
      cancelTranslations();
      voiceQueue.clear();
      if (captionPrefetch) {captionPrefetch.abort(); captionPrefetch = null;}
      browserSpeechEpoch++;
      voiceEpoch++;
      clearTimeout(browserSpeechTimer);
      ttsQueue.length = 0; ttsBusy = false; chrome.tts.stop(); setDuck(false);
    }
    if (changes.voice) {
      state.voice = s.voice;
      if (OFFSCREEN_VOICES.includes(s.voice)) {
        await ensureOffscreen();
        if (!current()) return;
        if (state.source === 'captions') await prepareCaptionsAudio({ type: 'NT_OFF_PREPARE', settings: s, sessionId: id });
      }
    }
    if (!current()) return;
    if (changes.targetLang) state.targetLang = s.targetLang;
    saveState();
    if (await hasOffscreen() && current()) await sendToOffscreen({ type: 'NT_OFF_SETTINGS', settings: s }, 3);
    if (current()) await sendToTab({type:'NT_C_SETTINGS',settings:s,sessionId:id});
    if (current() && resetVoice) await sendToTab({type:'NT_C_REFRESH'});
  }).catch(e => { if (current()) setStatus('voice_error', e.message); });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await stateLoaded;
  if (state.active && tabId === state.tabId) await stop();
});

// Full page navigations destroy the content script: re-inject and resume.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  await stateLoaded;
  if (!state.active || tabId !== state.tabId || !['loading','complete'].includes(info.status)) return;
  const navigation = ++navigationEpoch;
  // Navigation may destroy the old content script before it can report pause.
  // Invalidate speech at loading, and also at completion if that event was missed.
  handleMediaState({version:state.mediaVersion+1,paused:true});
  if (info.status === 'loading') return;
  const id = state.sessionId;
  const current = () => state.active && state.sessionId === id && state.tabId === tabId && navigation === navigationEpoch;
  return runLifecycle(async () => {
    if (!current()) return;
    sessionEpoch++;
    await ensureContent(tabId);
    if (!current()) return;
    const settings = await ntGetSettings();
    if (!current()) return;
    await chrome.tabs.sendMessage(tabId, { type: 'NT_C_START', settings, resume: true, sessionId: id, mediaVersion: state.mediaVersion }, { frameId: 0 });
  }).catch(async error => {
    if (!current()) return;
    const controller = lifecycleAbort;
    await cleanupSession(true);
    if (controller !== lifecycleAbort || state.active) return;
    state.status = 'error';
    state.detail = 'raw|' + error.message;
    saveState();
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

// If the worker restarted while the offscreen document vanished, reset to idle.
stateLoaded.then(async () => {
  const restored = state;
  if (!restored.active || state !== restored) return;
  const offscreen = await hasOffscreen();
  if (state !== restored) return;
  if (restored.source === 'gemini' && !offscreen) {
    state = Object.assign({}, IDLE_STATE);
    saveState();
  } else if (restored.capture && !offscreen) {
    // The audio page (and the capture with it) is gone: duck on the page again.
    state.capture = false;
    saveState();
  }
});
