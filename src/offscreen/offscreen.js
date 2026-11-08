// NeiroTranslate — offscreen document: tab audio capture → Gemini Live, voice-over playback, ducking.

let settings = null;
let source = 'captions';
let sessionId = null;
let mediaVersion = 0;
let mediaPaused = false;
let voiceEpoch = 0;

// Playback graph (default sample rate): tab monitor + voice-over
let playCtx = null;
let monitorGain = null;
let dubGain = null;
let player = null;

// Capture graph (16 kHz) for Gemini
let stream = null;
let capCtx = null;
let worklet = null;
let monitorSrc = null;
let gemini = null;
let analyser = null;

// Speaker detection: pitch frames of the original audio with wall-clock times.
// Bounded to the last SPEAKER_HISTORY_MS; phrases older than that are not asked about.
const SPEAKER_HISTORY_MS = 30000;
const speakerFrames = [];
const speakerClusters = typeof NtSpeakerClusters === 'function' ? new NtSpeakerClusters() : null;

let playerSpeaking = false;
let externalDuck = false;

const speech = { queue: [], busy: false, abort: null, generation: 0, expiryTimer: 0, pendingTimer: 0 };
let preparing = null;
// Only the last completed line, held in memory. Cancelled, cut or failed speech
// must never condition the next generation as if the listener had heard it.
let elevenContext = null;

function clearPreparation() {
  if (preparing) {preparing.abort(); preparing = null;}
}
async function prepareGoogleVoice(msg) {
  if (source !== 'captions' || settings?.voice !== 'google' || mediaPaused) return;
  if (msg.preparationKey !== JSON.stringify([settings.voice,settings.targetLang,settings.sourceLang || ''])) return;
  const key = msg.lang.gt+'\u0000'+msg.text;
  if (preparing?.textKey === key) return;
  clearPreparation();
  const controller = new AbortController(); preparing = controller;
  controller.textKey = key;
  try {
    ensurePlayback();
    await ntGoogleTts(msg.text,msg.lang,playCtx,controller.signal);
  } catch (error) { /* The actual cue may retry; never interrupt current speech. */ }
  finally {if (preparing === controller) preparing = null;}
}

function send(msg) {
  chrome.runtime.sendMessage(Object.assign({ sessionId, mediaVersion }, msg)).catch(() => {});
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ─── Playback ───────────────────────────────────────────────
function ensurePlayback() {
  if (playCtx) return;
  playCtx = new AudioContext({ latencyHint: 'interactive' });
  monitorGain = playCtx.createGain();
  dubGain = playCtx.createGain();
  monitorGain.connect(playCtx.destination);
  dubGain.connect(playCtx.destination);
  player = new NtAudioPlayer(playCtx, dubGain, (on) => { playerSpeaking = on; updateDuck(); });
  applyVolumes();
}

function applyVolumes() {
  if (!playCtx || !settings) return;
  dubGain.gain.setTargetAtTime(Number(settings.dubVolume), playCtx.currentTime, 0.05);
  updateDuck();
}

function updateDuck() {
  const speaking = playerSpeaking || externalDuck;
  if (source === 'gemini' || monitorSrc) {
    if (!monitorGain || !settings) return;
    const target = speaking && settings.voice !== 'off' ? Number(settings.originalVolume) : 1;
    monitorGain.gain.setTargetAtTime(target, playCtx.currentTime, 0.12);
  } else if (!externalDuck) {
    // Captions mode: the page's <video> element is ducked by the content script.
    send({ type: 'NT_OFF_SPEAKING', on: playerSpeaking, voiceEpoch });
  }
}

// ─── Tab capture ────────────────────────────────────────────
// Captures the tab, keeps it audible through monitorGain, and feeds a 16 kHz
// analysis context. Returns the capture source/sink for extra consumers.
async function startCapture(streamId) {
  ensurePlayback();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    });
  } catch (e) {
    throw new Error('Tab capture: ' + e.message);
  }

  // Keep the original audio audible (tab capture mutes the tab by default).
  monitorSrc = playCtx.createMediaStreamSource(stream);
  monitorSrc.connect(monitorGain);
  if (playCtx.state === 'suspended') await playCtx.resume();

  let capSrc;
  try {
    capCtx = new AudioContext({ sampleRate: 16000 });
    capSrc = capCtx.createMediaStreamSource(stream);
  } catch (e) {
    if (capCtx) capCtx.close();
    capCtx = new AudioContext();
    capSrc = capCtx.createMediaStreamSource(stream);
  }
  const silent = capCtx.createGain();
  silent.gain.value = 0;
  silent.connect(capCtx.destination);
  return { capSrc, silent };
}

// Pitch analysis is an optional extra: failure leaves speaker markup working.
async function startSpeakerAnalysis(capSrc, silent) {
  try {
    // Same worklet scope: speakers.js must be evaluated before the processor.
    await capCtx.audioWorklet.addModule('../shared/speakers.js');
    await capCtx.audioWorklet.addModule('speaker-worklet.js');
    analyser = new AudioWorkletNode(capCtx, 'nt-speaker-analyser');
    analyser.port.onmessage = (e) => recordSpeakerFrames(e.data);
    capSrc.connect(analyser);
    analyser.connect(silent);
    return true;
  } catch (e) {
    console.warn('[NeiroTranslate] speaker analysis unavailable', e);
    analyser = null;
    return false;
  }
}

function recordSpeakerFrames(batch) {
  if (!capCtx || !(batch instanceof Float32Array) || mediaPaused) return;
  const wallNow = Date.now(), audioNow = capCtx.currentTime;
  for (let i = 0; i + 2 < batch.length; i += 3) {
    const wall = wallNow - Math.max(0, audioNow - batch[i]) * 1000;
    speakerFrames.push({ wall, f0: batch[i + 1], rms: batch[i + 2] });
  }
  const oldest = wallNow - SPEAKER_HISTORY_MS;
  let drop = 0;
  while (drop < speakerFrames.length && speakerFrames[drop].wall < oldest) drop++;
  if (drop) speakerFrames.splice(0, drop);
  if (speakerFrames.length > 4000) speakerFrames.splice(0, speakerFrames.length - 4000);
}

function speakerAt(from, to, previous) {
  if (!speakerClusters || !analyser) return null;
  const summary = ntSummarizePitch(speakerFrames, from, Math.min(to, Date.now()));
  if (!summary) return null;
  return speakerClusters.assign(summary.log2, summary.voiced, previous);
}

async function startGemini(streamId) {
  const { capSrc, silent } = await startCapture(streamId);
  try {
    await capCtx.audioWorklet.addModule('pcm-worklet.js');
    worklet = new AudioWorkletNode(capCtx, 'nt-pcm-chunker', { processorOptions: { targetRate: 16000, chunkMs: 100 } });
    worklet.port.onmessage = (e) => { if (gemini && !mediaPaused) gemini.sendAudio(toBase64(e.data)); };
    capSrc.connect(worklet);
    worklet.connect(silent);
    if (capCtx.state === 'suspended') await capCtx.resume();
  } catch (e) {
    throw new Error('Audio pipeline: ' + e.message);
  }
  await startSpeakerAnalysis(capSrc, silent);
  connectGemini();
}

// Free mode: capture only to tell speakers apart. Any failure releases the
// capture so the tab is never left muted.
async function startCaptionsCapture(streamId) {
  try {
    const { capSrc, silent } = await startCapture(streamId);
    if (capCtx.state === 'suspended') await capCtx.resume();
    if (!(await startSpeakerAnalysis(capSrc, silent))) throw new Error('speakerAnalysisUnavailable');
    updateDuck();
    return { capture: true };
  } catch (e) {
    releaseCapture();
    return { capture: false, captureError: e.message };
  }
}

function releaseCapture() {
  if (analyser) { try { analyser.port.onmessage = null; analyser.disconnect(); } catch (e) { /* ignore */ } analyser = null; }
  if (worklet) { try { worklet.port.onmessage = null; worklet.disconnect(); } catch (e) { /* ignore */ } worklet = null; }
  if (monitorSrc) { try { monitorSrc.disconnect(); } catch (e) { /* ignore */ } monitorSrc = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (capCtx) { capCtx.close().catch(() => {}); capCtx = null; }
  speakerFrames.length = 0;
}

function connectGemini() {
  if (gemini) gemini.close();
  if (mediaPaused) { gemini = null; return; }
  const lang = ntFindLanguage(settings.targetLang);
  gemini = new NtGeminiLive({
    apiKey: settings.geminiApiKey,
    model: settings.geminiModel,
    targetLang: lang.code,
    targetName: lang.name,
    echo: settings.geminiEcho,
    onAudio: (b64, rate) => {
      if (settings.voice !== 'gemini') return;
      // A continuous stream cannot be re-timed per phrase; catch-up keeps it live.
      player.catchUp = settings.syncMode !== 'complete';
      player.enqueuePcm16(fromBase64(b64), rate);
    },
    onTranscript: (t) => send(Object.assign({ type: 'NT_OFF_TRANSCRIPT' }, t)),
    onStatus: (code) => send({ type: 'NT_OFF_STATUS', code }),
    onFatal: (detail) => send({ type: 'NT_OFF_FATAL', detail })
  });
  gemini.connect();
}

// ─── Voice-over queue (Google / ElevenLabs / Yandex) ────────
function speakEnqueue(text, lang, s, deadline = Date.now() + 2500, fallback = false, token = voiceEpoch, timing = {}) {
  const startBy = Number.isFinite(timing?.startBy) ? timing.startBy : deadline;
  if (mediaPaused || Date.now() > deadline || Date.now() > startBy) return false;
  // A new caption owns playback immediately, including when the old fetch is hung.
  clearSpeech(true);
  speech.queue.push({ text, lang, s, deadline, fallback, token, timing: timing || {} });
  while (speech.queue.length > 1) speech.queue.shift();
  pumpSpeech();
  return true;
}

async function pumpSpeech() {
  if (speech.busy || mediaPaused) return;
  const item = speech.queue.shift();
  if (!item) return;
  if (Date.now() > item.deadline) return pumpSpeech();
  speech.busy = true;
  const gen = speech.generation;
  ensurePlayback();
  player.catchUp = false;
  const { text, lang, deadline, fallback, token } = item;
  const timing = item.timing || {};
  const startBy = Number.isFinite(timing.startBy) ? timing.startBy : deadline;
  const voice = timing.voice || {};
  // Speaker-specific provider voice (second Yandex/ElevenLabs voice).
  const s = Object.assign({}, item.s, voice.yandexVoice ? { yandexVoice: voice.yandexVoice } : {},
    voice.elevenVoiceId ? { elevenVoiceId: voice.elevenVoiceId } : {});
  const elevenKey = JSON.stringify([sessionId, mediaVersion, lang.gt, voice.speakerKey || '', s.elevenVoiceId,
    s.elevenModel, s.elevenStability, s.elevenSimilarity, s.elevenSpeakerBoost]);
  const pitch = Number(voice.pitch) > 0 ? Number(voice.pitch) : 1;
  const maxTempo = Number(timing.maxTempo) || 1.6;
  const syncEnd = Number.isFinite(timing.syncEnd) ? timing.syncEnd : null;
  // Tempo for audio of known length: fit it between its start and syncEnd.
  const tempoFor = (durationMs, base = 1, max = maxTempo) => syncEnd
    ? ntPlanTempo({ speechMs: durationMs, availableMs: syncEnd - player.nextStartWall, base, max }) : base;
  player.deadline = playCtx.currentTime + Math.max(0, deadline - Date.now()) / 1000;
  player.startBy = startBy;
  speech.abort = new AbortController();
  const controller = speech.abort;
  const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  speech.expiryTimer = setTimeout(() => {
    if (gen === speech.generation) {clearSpeech();send({type:'NT_OFF_VOICE_DONE',voiceEpoch:token});}
  }, Math.max(1, deadline - Date.now()));
  let emittedAudio = false;
  const canSchedule = () => gen === speech.generation && !mediaPaused && Date.now() <= deadline &&
    (emittedAudio || player.started || (player.nextStartWall || Date.now() + 60) <= startBy);
  speech.pendingTimer = setTimeout(() => {
    if (gen === speech.generation && !emittedAudio && !player.started) {
      clearSpeech(); send({type:'NT_OFF_VOICE_DONE',voiceEpoch:token});
    }
  }, Math.max(1, startBy - Date.now()));
  let fallbackPending = false;
  let elevenCompleted = false;
  // Tell the worker when the scheduled audio ends, so a phrase about to finish
  // is not cut for the next one. Throttled: one message per scheduled chunk.
  const reportEnd = () => { if (gen === speech.generation && player) send({ type: 'NT_OFF_SPEECH_END', at: player.endWall, voiceEpoch: token }); };
  try {
    if (s.voice === 'elevenlabs') {
      const tempo = tempoFor(ntEstimateSpeechMs(text));
      const expressive = /^eleven_v[34](?:_|$)/.test(s.elevenModel || '');
      // v2 supports speed up to 1.2; v3/v4 have no API speed control. Apply
      // only the remaining correction locally, never multiply two full speeds.
      const elevenSpeed = expressive ? 1 : Math.max(0.7, Math.min(1.2, tempo));
      const correction = tempo / elevenSpeed;
      const previous = s.elevenContinuity !== false && elevenContext?.key === elevenKey && Date.now() - elevenContext.at < 8000
        ? elevenContext.text : '';
      await ntElevenLabsStream(text, lang, Object.assign({}, s, { elevenSpeed, elevenPreviousText: previous }), async (pcm, rate) => {
        if (canSchedule()) {
          const scheduled = await (player.enqueuePcm16Async || player.enqueuePcm16).call(player, pcm, rate,
            { tempo: correction, stream: Math.abs(correction - 1) > 0.015, preservePitch: true });
          if (gen === speech.generation && scheduled) { emittedAudio = true; reportEnd(); }
        }
      }, speech.abort.signal);
      if (canSchedule() && player.flushPcm16?.()) {
        emittedAudio = true; reportEnd();
      }
      elevenCompleted = emittedAudio;
    } else if (s.voice === 'yandex') {
      if (!ntYandexSupports(lang)) throw new Error('unsupportedYandexLanguage');
      // Ask SpeechKit for roughly the right speed, then correct the remainder exactly.
      const base = Number(s.yandexSpeed) || 1;
      const requested = Math.min(3, tempoFor(ntEstimateSpeechMs(text), base));
      const pcm = await ntYandexTts(text, lang, Object.assign({}, s, { yandexSpeed: requested }), speech.abort.signal);
      if (canSchedule()) {
        const durationMs = pcm.byteLength / 2 / 48000 * 1000;
        // Already synthesized at `requested`; the correction keeps the product <= maxTempo.
        const resolveTempo = () => tempoFor(durationMs, 1, Math.max(1, maxTempo / requested));
        const scheduled = await (player.enqueuePcm16Async || player.enqueuePcm16).call(player, pcm, 48000,
          { tempo: resolveTempo(), pitch, resolveTempo });
        if (gen === speech.generation && scheduled !== false) { emittedAudio = true; reportEnd(); }
      }
    } else {
      // Google Translate voice (unofficial web endpoint). The first chunk's
      // measured speed predicts the rest of a long phrase.
      let charsPerMs = 0;
      await ntGoogleTts(text, lang, playCtx, speech.abort.signal, async (buffer, info = {}) => {
        if (!canSchedule()) return;
        const durationMs = buffer.duration * 1000;
        if (info.chars > 0 && durationMs > 0) charsPerMs = info.chars / durationMs;
        const restMs = charsPerMs > 0 ? (info.restChars || 0) / charsPerMs : 0;
        const resolveTempo = () => tempoFor(durationMs + restMs, 1);
        const scheduled = await (player.enqueueBufferAsync || player.enqueueBuffer).call(player, buffer,
          { tempo: resolveTempo(), pitch, resolveTempo });
        if (gen === speech.generation && scheduled !== false) { emittedAudio = true; reportEnd(); }
      });
    }
  } catch (e) {
    if (canSchedule()) {
      console.warn('[NeiroTranslate] voice error', e);
      const detail = e.name === 'AbortError' ? 'voiceRequestTimeout' : e.message;
      if (s.voice === 'google' && !emittedAudio && !player.started) {fallbackPending=true;send({type:'NT_OFF_VOICE_ERROR',text,lang,deadline,startBy,fallback,detail,voiceEpoch:token,
        syncEnd,speakerKey:voice.speakerKey || null});}
      else send({ type: 'NT_OFF_STATUS', code: 'voice_error', detail, voiceEpoch:token });
    }
  }
  clearTimeout(timeout);
  if (gen !== speech.generation) return;
  if (!fallbackPending) {
    await player.whenIdle();
    if (gen !== speech.generation) return;
    if (s.voice === 'elevenlabs') {
      elevenContext = elevenCompleted && s.elevenContinuity !== false && !controller.signal.aborted && Date.now() < deadline
        ? { key: elevenKey, text: [...text].slice(-100).join(''), at: Date.now() } : null;
    }
    send({type:'NT_OFF_VOICE_DONE',voiceEpoch:token});
  }
  clearTimeout(speech.expiryTimer);
  clearTimeout(speech.pendingTimer);
  speech.abort = null;
  speech.busy = false;
  pumpSpeech();
}

function clearSpeech(keepElevenContext = false) {
  if (!keepElevenContext || speech.busy) elevenContext = null;
  clearTimeout(speech.expiryTimer);
  clearTimeout(speech.pendingTimer);
  speech.generation++;
  speech.queue = [];
  if (speech.abort) { try { speech.abort.abort(); } catch (e) { /* ignore */ } }
  speech.busy = false;
  speech.abort = null;
  if (player) player.clear();
}

// ─── Lifecycle ──────────────────────────────────────────────
function applySettings(next) {
  const prev = settings;
  settings = next;
  applyVolumes();
  if (!prev) return;
  const deliveryChanged = next.voice === 'elevenlabs' && ['elevenApiKey', 'elevenVoiceId', 'elevenVoiceId2',
    'elevenModel', 'elevenStability', 'elevenSimilarity', 'elevenSpeakerBoost', 'elevenContinuity'].some(key => prev[key] !== next[key]);
  if (prev.voice !== next.voice || prev.targetLang !== next.targetLang || prev.sourceLang !== next.sourceLang || deliveryChanged) {clearSpeech(); clearPreparation();}
  const geminiChanged = ['targetLang', 'geminiModel', 'geminiApiKey', 'geminiEcho'].some((k) => prev[k] !== next[k]);
  if (gemini && geminiChanged) connectGemini();
}

function stopAll() {
  clearPreparation();
  clearSpeech();
  if (gemini) { gemini.close(); gemini = null; }
  releaseCapture();
  if (speakerClusters) speakerClusters.reset();
  if (player) { player.destroy(); player = null; }
  if (playCtx) { playCtx.close().catch(() => {}); playCtx = null; }
  monitorSrc = monitorGain = dubGain = null;
  playerSpeaking = externalDuck = false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (!['NT_PING', 'NT_OFF_START', 'NT_OFF_PREPARE'].includes(msg.type) && msg.sessionId !== sessionId) {
    sendResponse({ ok: true, ignored: true });
    return false;
  }
  if (['NT_OFF_SPEAK','NT_OFF_DUCK','NT_OFF_CLEAR','NT_OFF_PREFETCH'].includes(msg.type) &&
      (((['NT_OFF_SPEAK','NT_OFF_PREFETCH'].includes(msg.type) || msg.on) && mediaPaused) || (msg.mediaVersion ?? 0) !== mediaVersion)) {
    sendResponse({ok:true,ignored:true}); return false;
  }
  if (msg.voiceEpoch != null && msg.voiceEpoch < voiceEpoch) {sendResponse({ok:true,ignored:true}); return false;}
  if (msg.voiceEpoch != null) voiceEpoch = msg.voiceEpoch;
  switch (msg.type) {
    case 'NT_PING':
      sendResponse({ ok: true });
      return false;
    case 'NT_OFF_START':
      sessionId = msg.sessionId;
      mediaVersion = msg.mediaVersion ?? 0; mediaPaused = false;
      source = 'gemini';
      applySettings(msg.settings);
      startGemini(msg.streamId).then(() => sendResponse({ ok: true })).catch(e => {
        stopAll(); sendResponse({ ok: false, error: e.message });
      });
      return true;
    case 'NT_OFF_PREPARE':
      sessionId = msg.sessionId;
      mediaVersion = msg.mediaVersion ?? 0;
      source = 'captions';
      applySettings(msg.settings);
      ensurePlayback();
      if (msg.streamId && !stream) {
        startCaptionsCapture(msg.streamId).then(result => sendResponse(Object.assign({ ok: true }, result)));
        return true;
      }
      sendResponse({ ok: true, capture: !!(stream && analyser) });
      return false;
    case 'NT_OFF_SPEAK': {
      const accepted = speakEnqueue(msg.text, msg.lang, msg.settings, msg.deadline, msg.fallback, msg.voiceEpoch,
        { syncEnd: msg.syncEnd, maxTempo: msg.maxTempo, voice: msg.voice, startBy: msg.startBy });
      sendResponse(accepted === false ? { ok: true, ignored: true } : { ok: true });
      return false;
    }
    case 'NT_OFF_SPEAKER':
      sendResponse({ ok: true, speaker: speakerAt(msg.from, msg.to, msg.previous) });
      return false;
    case 'NT_OFF_CLEAR':
      clearSpeech(msg.keepElevenContext === true); externalDuck = false; updateDuck();
      sendResponse({ok:true});
      return false;
    case 'NT_OFF_PREFETCH':
      prepareGoogleVoice(msg);
      sendResponse({ok:true});
      return false;
    case 'NT_OFF_DUCK':
      externalDuck = !!msg.on;
      updateDuck();
      sendResponse({ ok: true });
      return false;
    case 'NT_OFF_SETTINGS':
      applySettings(msg.settings);
      sendResponse({ ok: true });
      return false;
    case 'NT_OFF_MEDIA':
      if (msg.mediaVersion < mediaVersion) { sendResponse({ok:true,ignored:true}); return false; }
      // Frames before a seek/pause describe audio no longer near the playhead;
      // a same-version resync (voice fallback) keeps the speaker history.
      if (msg.mediaVersion !== mediaVersion || msg.paused) speakerFrames.length = 0;
      mediaVersion = msg.mediaVersion;
      mediaPaused = !!msg.paused;
      clearPreparation();
      clearSpeech();
      externalDuck = false;
      updateDuck();
      if (source === 'gemini') connectGemini();
      sendResponse({ok:true});
      return false;
    case 'NT_OFF_STOP':
      stopAll();
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});
