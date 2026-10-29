// NeiroTranslate — voice-over providers that produce audio for NtAudioPlayer.
//   google     — free Google Translate voice (MP3, decoded with WebAudio)
//   elevenlabs — paid, streaming PCM 24 kHz
//   yandex     — Yandex SpeechKit v1, raw LPCM 48 kHz

const NT_YANDEX_VOICES = {
  ru: ['marina', 'filipp', 'ermil', 'jane', 'omazh', 'zahar', 'madi_ru'],
  en: ['john'],
  de: ['lea'],
  kk: ['amira', 'madi'],
  uz: ['nigora']
};
const NT_YANDEX_LOCALES = { ru: 'ru-RU', en: 'en-US', de: 'de-DE', kk: 'kk-KK', uz: 'uz-UZ' };

// Prepared speech lives only in this audio document, never in storage. Limit
// decoded PCM as well as entry count so long streams cannot grow memory forever.
const ntGoogleAudioCaches = new WeakMap();
function ntGoogleAudioCache(ctx) {
  if (!ntGoogleAudioCaches.has(ctx)) ntGoogleAudioCaches.set(ctx, {items:new Map(), bytes:0});
  return ntGoogleAudioCaches.get(ctx);
}
function ntGoogleCachedAudio(ctx, key) {
  const cache = ntGoogleAudioCache(ctx), item = cache.items.get(key);
  if (!item) return null;
  cache.items.delete(key); cache.bytes -= item.bytes;
  if (Date.now() > item.expires) return null;
  cache.items.set(key, item); cache.bytes += item.bytes;
  return item.buffer;
}
function ntGoogleRememberAudio(ctx, key, buffer) {
  const bytes = (buffer.length || 0) * (buffer.numberOfChannels || 1) * 4;
  if (bytes > 12 * 1024 * 1024) return;
  const cache = ntGoogleAudioCache(ctx), old = cache.items.get(key);
  if (old) {cache.items.delete(key); cache.bytes -= old.bytes;}
  cache.items.set(key, {buffer, bytes, expires:Date.now()+120000}); cache.bytes += bytes;
  while (cache.items.size > 24 || cache.bytes > 12 * 1024 * 1024) {
    const first = cache.items.keys().next().value;
    cache.bytes -= cache.items.get(first).bytes; cache.items.delete(first);
  }
}

/** Split text into chunks <= max chars on sentence / word boundaries. */
function ntSplitText(text, max) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('. ', max), rest.lastIndexOf('! ', max), rest.lastIndexOf('? ', max), rest.lastIndexOf(', ', max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    let end = cut <= 0 ? max : Math.min(max, cut + 1);
    if (/[\uD800-\uDBFF]/.test(rest[end - 1]) && /[\uDC00-\uDFFF]/.test(rest[end])) end--;
    out.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function ntGoogleTtsChunk(chunk, tl, ctx, signal) {
  if (signal?.aborted) throw signal.reason;
  const requests = new AbortController();
  const combined = signal ? AbortSignal.any([signal, requests.signal]) : requests.signal;
  let hedgeTimer, deadlineTimer, onAbort;
  try {
    return await new Promise((resolve, reject) => {
      let remaining = 1, fallbackStarted = false;
      onAbort = () => reject(combined.reason);
      combined.addEventListener('abort', onAbort, {once:true});
      async function decode(origin) {
        const url = origin + '/translate_tts?ie=UTF-8&client=tw-ob&tl=' + encodeURIComponent(tl) + '&q=' + encodeURIComponent(chunk);
        const resp = await fetch(url, {credentials:'omit', signal:AbortSignal.any([combined, AbortSignal.timeout(1800)])});
        if (combined.aborted) throw combined.reason;
        if (!resp.ok) throw new Error('Google TTS HTTP ' + resp.status);
        const encoded = await resp.arrayBuffer();
        if (combined.aborted) throw combined.reason;
        const buffer = await ctx.decodeAudioData(encoded);
        if (combined.aborted) throw combined.reason;
        return buffer;
      }
      function run(origin, primary = false) {
        decode(origin).then(resolve, error => {
          if (primary) fallback();
          if (--remaining === 0) reject(error);
        });
      }
      function fallback() {
        if (fallbackStarted || combined.aborted) return;
        fallbackStarted = true; remaining++;
        clearTimeout(hedgeTimer);
        run('https://translate.googleapis.com');
      }
      // A slow first host must not consume its full timeout before the other
      // permitted host gets a chance. Fast responses still use one request.
      hedgeTimer = setTimeout(fallback, 250);
      deadlineTimer = setTimeout(() => requests.abort(new DOMException('Voice request timed out', 'TimeoutError')), 2050);
      run('https://translate.google.com', true);
    });
  } finally {
    clearTimeout(hedgeTimer); clearTimeout(deadlineTimer);
    combined.removeEventListener('abort', onAbort);
    requests.abort();
  }
}

async function ntGoogleTts(text, lang, ctx, signal, onBuffer) {
  if (signal?.aborted) throw signal.reason;
  const requests = new AbortController();
  const combined = signal ? AbortSignal.any([signal, requests.signal]) : requests.signal;
  // Load concurrently, but deliver in caption order. Attach error handlers now
  // so a later chunk cannot cause an unhandled rejection while the first loads.
  const chunks = ntSplitText(text, 190);
  const pending = chunks.map(chunk => {
    const key = lang.gt + '\u0000' + chunk;
    const cached = ntGoogleCachedAudio(ctx, key);
    return (cached ? Promise.resolve(cached) : ntGoogleTtsChunk(chunk, lang.gt, ctx, combined)).then(buffer => {
      if (combined.aborted) throw combined.reason;
      ntGoogleRememberAudio(ctx, key, buffer);
      return {buffer};
    }).catch(error => {
      // A known terminal failure must not wait behind an earlier stalled chunk.
      requests.abort(error);
      return {error};
    });
  });
  const buffers = [];
  let restChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  try {
    for (let i = 0; i < pending.length; i++) {
      const {buffer, error} = await pending[i];
      if (combined.aborted) throw combined.reason;
      if (error) throw error;
      buffers.push(buffer);
      restChars -= chunks[i].length;
      // Chunk sizes let the caller time the whole phrase from the first chunk.
      if (onBuffer) onBuffer(buffer, {chars: chunks[i].length, restChars});
    }
    return buffers;
  } finally {
    requests.abort();
  }
}

function ntElevenVoiceSettings(s, model) {
  const unit = (value, fallback) => {
    const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
  };
  const stability = unit(s.elevenStability, 0.5);
  if (/^eleven_v3(?:_|$)/.test(model)) return { stability: Math.round(stability * 2) / 2 };
  const voice = { stability, similarity_boost: unit(s.elevenSimilarity, 0.75) };
  // v3/v4 do not accept the v2 style, speed or speaker-boost controls.
  if (/^eleven_v4(?:_|$)/.test(model)) return voice;
  voice.style = 0;
  voice.use_speaker_boost = s.elevenSpeakerBoost === true;
  const speed = Number(s.elevenSpeed);
  if (Number.isFinite(speed) && speed > 0) voice.speed = Math.max(0.7, Math.min(1.2, speed));
  return voice;
}

function ntCheckElevenRegion(response) {
  if (response.redirected && /^https:\/\/geo-restriction\.elevenlabs\.io(?:\/|$)/i.test(response.url || '')) {
    throw new Error('elevenRegionUnavailable');
  }
}

function ntElevenDialogueStream(text, lang, s, voiceSettings, onPcm, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const query = new URLSearchParams({ model_id: s.elevenModel, output_format: 'pcm_24000' });
    if (lang.gt) query.set('language_code', lang.gt.split('-')[0]);
    const socket = new WebSocket('wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?' + query);
    let settled = false, audioBytes = 0;
    const finish = error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(1000, 'Request finished'); } catch (e) { /* the server may already have closed */ }
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    socket.onopen = () => {
      if (settled || signal.aborted) return;
      try {
        // Browser WebSockets cannot set HTTP auth headers. Keep the key out of
        // URLs and authenticate in the documented first JSON frame instead.
        socket.send(JSON.stringify({ voices: [s.elevenVoiceId], xi_api_key: s.elevenApiKey,
          // The dialogue socket's documented settings differ from HTTP TTS.
          // Its schema has stability and optional clone_strength, not similarity_boost.
          voice_settings: { stability: voiceSettings.stability } }));
        // Without flush the service waits for ~40 characters / 8 words, making
        // short live captions stall. close_socket flushes the encoder's tail.
        socket.send(JSON.stringify({ inputs: [{ text, voice_id: s.elevenVoiceId }], flush: true }));
        socket.send(JSON.stringify({ close_socket: true }));
      } catch (error) { finish(error); }
    };
    socket.onmessage = event => {
      if (settled || signal.aborted) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.error || frame.type === 'error') {
          const detail = frame.error?.message || frame.error || frame.message || frame.detail || 'Dialogue generation failed';
          throw new Error('ElevenLabs: ' + String(detail).slice(0, 240));
        }
        if (frame.audio) {
          const binary = atob(frame.audio);
          const pcm = Uint8Array.from(binary, char => char.charCodeAt(0));
          if (pcm.byteLength) { onPcm(pcm.buffer, 24000); audioBytes += pcm.byteLength; }
        }
        // is_final_audio_for_turn can precede the final encoder bytes. Wait for
        // the connection's final flush so the end of a word is never lost.
        if (frame.is_final === true) finish(audioBytes ? null : new Error('ElevenLabs returned no audio'));
      } catch (error) { finish(error); }
    };
    socket.onerror = () => finish(new Error('elevenConnectionFailed'));
    socket.onclose = event => finish(new Error('ElevenLabs stream closed before completion (' + event.code + ')'));
    if (signal.aborted) onAbort();
  });
}

async function ntElevenLabsStream(text, lang, s, onPcm, signal) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  signal.throwIfAborted();
  const model = s.elevenModel || 'eleven_flash_v2_5';
  const voiceSettings = ntElevenVoiceSettings(s, model);
  if (model === 'eleven_v4_turbo' || model === 'eleven_v3_conversational') {
    return ntElevenDialogueStream(text, lang, s, voiceSettings, onPcm, signal);
  }
  const body = {
    text,
    model_id: model,
    voice_settings: voiceSettings
  };
  if (/v2_5|^eleven_v[34](?:_|$)/.test(model) && lang.gt) body.language_code = lang.gt.split('-')[0];
  if (s.elevenContinuity !== false && typeof s.elevenPreviousText === 'string' && s.elevenPreviousText.trim()) {
    body.previous_text = [...s.elevenPreviousText].slice(-100).join('');
  }
  const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(s.elevenVoiceId) + '/stream?output_format=pcm_24000';
  let resp;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': s.elevenApiKey, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
      body: JSON.stringify(body), signal
    });
    signal.throwIfAborted();
    ntCheckElevenRegion(resp);
    if (resp.ok) break;
    let detail = '';
    try { const j = await resp.json(); detail = (j.detail && (j.detail.message || j.detail.status)) || JSON.stringify(j); } catch (e) { /* ignore */ }
    signal.throwIfAborted();
    if (!attempt && [400, 422].includes(resp.status) && body.language_code && /language_code/i.test(detail)) {
      // Retry only this unsupported parameter, on the user's selected model.
      delete body.language_code; continue;
    }
    throw new Error('ElevenLabs ' + resp.status + (detail ? ': ' + String(detail).slice(0, 240) : ''));
  }
  if (!resp.body) throw new Error('ElevenLabs returned no audio');
  const reader = resp.body.getReader();
  let audioBytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value && value.byteLength) {
        onPcm(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength), 24000);
        audioBytes += value.byteLength;
      }
    }
    if (!audioBytes) throw new Error('ElevenLabs returned no audio');
  } finally {
    try { await reader.cancel(); } catch (e) { /* the transport may already be aborted */ }
    reader.releaseLock();
  }
}

async function ntElevenLabsVoices(apiKey) {
  const resp = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(12000) });
  ntCheckElevenRegion(resp);
  if (!resp.ok) throw new Error('ElevenLabs ' + resp.status);
  const data = await resp.json();
  return (data.voices || []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category || '',
    language: v.labels?.language || v.verified_languages?.[0]?.language || '', accent: v.labels?.accent || '' }));
}

function ntYandexSupports(lang) {
  return !!NT_YANDEX_LOCALES[lang.gt.split('-')[0]];
}

async function ntYandexTts(text, lang, s, signal) {
  const base = lang.gt.split('-')[0];
  const locale = NT_YANDEX_LOCALES[base] || 'ru-RU';
  const allowed = NT_YANDEX_VOICES[base] || NT_YANDEX_VOICES.ru;
  const voice = allowed.includes(s.yandexVoice) ? s.yandexVoice : allowed[0];
  const form = new URLSearchParams({
    text: text.slice(0, 4900), lang: locale, voice, speed: String(s.yandexSpeed || 1),
    format: 'lpcm', sampleRateHertz: '48000'
  });
  const key = s.yandexApiKey.trim();
  if (/^t1\./.test(key) && s.yandexFolderId) form.set('folderId', s.yandexFolderId.trim());
  const auth = /^t1\./.test(key) ? 'Bearer ' + key : 'Api-Key ' + key;
  const resp = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
    method: 'POST', headers: { Authorization: auth }, body: form, signal: signal || AbortSignal.timeout(15000)
  });
  if (!resp.ok) {
    let detail = '';
    try { const j = await resp.json(); detail = j.error_message || j.message || ''; } catch (e) { /* ignore */ }
    throw new Error('Yandex SpeechKit ' + resp.status + (detail ? ': ' + detail : ''));
  }
  return resp.arrayBuffer();
}

self.ntGoogleTts = ntGoogleTts;
self.ntElevenLabsStream = ntElevenLabsStream;
self.ntElevenLabsVoices = ntElevenLabsVoices;
self.ntYandexTts = ntYandexTts;
self.ntYandexSupports = ntYandexSupports;
self.NT_YANDEX_VOICES = NT_YANDEX_VOICES;
