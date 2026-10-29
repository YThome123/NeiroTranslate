const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function providers(fetch, extra = {}) {
  const ctx = vm.createContext({ self: {}, AbortSignal, AbortController, DOMException,
    Uint8Array, URLSearchParams, atob, fetch, ...extra });
  vm.runInContext(fs.readFileSync('src/offscreen/tts-providers.js', 'utf8'), ctx);
  return ctx.self;
}
const speechSettings = { elevenApiKey: 'fixture-key', elevenVoiceId: 'my-native-voice', elevenModel: 'eleven_flash_v2_5' };
const pcmResponse = () => new Response(new Uint8Array([1, 2, 3, 4]));
const ru = { gt: 'ru' };

test('ElevenLabs regional redirects report access restrictions instead of JSON or audio errors', async () => {
  const api = providers(async () => {
    const response = new Response('<html>Access restricted</html>');
    Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://geo-restriction.elevenlabs.io/' } });
    return response;
  });
  await assert.rejects(api.ntElevenLabsVoices('fixture-key'), /elevenRegionUnavailable/);
  await assert.rejects(api.ntElevenLabsStream('Привет.', ru, speechSettings, () => {}), /elevenRegionUnavailable/);
});

test('ElevenLabs sends the chosen delivery settings without style exaggeration', async () => {
  let body;
  const api = providers(async (url, options) => { body = JSON.parse(options.body); return pcmResponse(); });
  await api.ntElevenLabsStream('Привет! Как дела?', ru, { ...speechSettings,
    elevenStability: 0.35, elevenSimilarity: 0.65, elevenSpeakerBoost: false, elevenSpeed: 1.1 }, () => {});
  assert.deepEqual(body.voice_settings, { stability: 0.35, similarity_boost: 0.65,
    style: 0, use_speaker_boost: false, speed: 1.1 });
  assert.equal(body.text, 'Привет! Как дела?');
});

test('ElevenLabs preserves punctuation and ё without inventing emotions or repeating context', async () => {
  let body;
  const api = providers(async (url, options) => { body = JSON.parse(options.body); return pcmResponse(); });
  await api.ntElevenLabsStream('Всё ещё ждёшь?.. Да!', ru,
    { ...speechSettings, elevenPreviousText: 'Я уже пришёл.' }, () => {});
  assert.equal(body.text, 'Всё ещё ждёшь?.. Да!');
  assert.equal(body.previous_text, 'Я уже пришёл.');
  assert.equal(body.voice_settings.stability, 0.5);
  assert.equal(body.voice_settings.style, 0);
  assert.equal(body.voice_settings.use_speaker_boost, false);
});

test('Eleven v4 HTTP synthesis omits unsupported speed, style and speaker boost', async () => {
  let body;
  const api = providers(async (url, options) => { body = JSON.parse(options.body); return pcmResponse(); });
  await api.ntElevenLabsStream('Живая речь.', ru, { ...speechSettings, elevenModel: 'eleven_v4',
    elevenStability: 0.5, elevenSimilarity: 0.7, elevenSpeakerBoost: true, elevenSpeed: 1.2 }, () => {});
  assert.deepEqual(body.voice_settings, { stability: 0.5, similarity_boost: 0.7 });
  assert.equal(body.model_id, 'eleven_v4');
});

test('Eleven v3 uses a supported stability level without unsupported voice controls', async () => {
  let body;
  const api = providers(async (url, options) => { body = JSON.parse(options.body); return pcmResponse(); });
  await api.ntElevenLabsStream('Проверяем.', ru, { ...speechSettings, elevenModel: 'eleven_v3',
    elevenStability: 0.41, elevenSimilarity: 0.9, elevenSpeed: 1.2 }, () => {});
  assert.deepEqual(body.voice_settings, { stability: 0.5 });
});

test('a rejected language parameter is retried once on the same model and voice', async () => {
  const calls = [];
  const api = providers(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return calls.length === 1
      ? Response.json({ detail: { status: 'invalid_language_code', message: 'language_code is not supported' } }, { status: 400 })
      : pcmResponse();
  });
  await api.ntElevenLabsStream('Привет.', ru, speechSettings, () => {});
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.body.model_id === 'eleven_flash_v2_5'));
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[0].body.language_code, 'ru');
  assert.equal(Object.hasOwn(calls[1].body, 'language_code'), false);
});

test('an unrelated ElevenLabs 400 is surfaced without changing models or billing another attempt', async () => {
  let calls = 0;
  const api = providers(async () => {
    calls++;
    return Response.json({ detail: { status: 'voice_not_found', message: 'Voice is unavailable' } }, { status: 400 });
  });
  await assert.rejects(api.ntElevenLabsStream('Привет.', ru, speechSettings, () => {}), /Voice is unavailable/);
  assert.equal(calls, 1);
});

test('ElevenLabs never delivers a response received after cancellation', async () => {
  const controller = new AbortController(), played = [];
  const api = providers(async () => { controller.abort(); return pcmResponse(); });
  await assert.rejects(api.ntElevenLabsStream('Поздний ответ.', ru, speechSettings,
    pcm => played.push(pcm), controller.signal), error => error.name === 'AbortError');
  assert.equal(played.length, 0);
});

test('an empty successful ElevenLabs response is a voice error rather than silent success', async () => {
  const api = providers(async () => new Response(new Uint8Array()));
  await assert.rejects(api.ntElevenLabsStream('Привет.', ru, speechSettings, () => {}), /empty|no audio/i);
});

function dialogue() {
  const sockets = [], fetches = [];
  class Socket {
    constructor(url) { this.url = url; this.sent = []; this.closed = 0; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed++; }
    open() { this.onopen?.({}); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    end(code) { this.onclose?.({ code }); }
  }
  const api = providers(async (...args) => { fetches.push(args); return pcmResponse(); }, { WebSocket: Socket });
  return { api, sockets, fetches, settings: { ...speechSettings, elevenModel: 'eleven_v4_turbo' } };
}

test('v4 Turbo authenticates in the WebSocket body and flushes a short phrase immediately', async () => {
  const h = dialogue(), played = [];
  let complete = false;
  const pending = h.api.ntElevenLabsStream('Да!', ru, { ...h.settings, elevenStability: 0.5, elevenSimilarity: 0.75 },
    (pcm, rate) => played.push({ bytes: [...new Uint8Array(pcm)], rate })).then(() => { complete = true; });
  assert.equal(h.sockets.length, 1, 'Turbo must use the documented dialogue transport');
  const socket = h.sockets[0];
  assert.equal(new URL(socket.url).pathname, '/v1/text-to-dialogue/stream-input');
  assert.equal(new URL(socket.url).searchParams.get('output_format'), 'pcm_24000');
  assert.ok(!socket.url.includes('fixture-key'), 'credentials must not appear in URLs');
  socket.open();
  assert.deepEqual(socket.sent[0], { voices: ['my-native-voice'], xi_api_key: 'fixture-key',
    voice_settings: { stability: 0.5 } });
  assert.ok(socket.sent.some(frame => frame.inputs?.[0]?.text === 'Да!' && frame.flush === true));
  assert.ok(socket.sent.some(frame => frame.close_socket === true));
  socket.message({ audio: 'AQIDBA==' });
  socket.message({ is_final_audio_for_turn: true });
  await new Promise(setImmediate);
  assert.deepEqual(played, [{ bytes: [1, 2, 3, 4], rate: 24000 }]);
  assert.equal(complete, false, 'a turn marker is not the final connection flush');
  socket.message({ is_final: true });
  await pending;
  assert.equal(socket.closed, 1);
  assert.equal(h.fetches.length, 0);
});

test('cancelling v4 Turbo closes the socket and ignores queued late audio', async () => {
  const h = dialogue(), controller = new AbortController(), played = [];
  const pending = h.api.ntElevenLabsStream('Стоп.', ru, h.settings, pcm => played.push(pcm), controller.signal);
  assert.equal(h.sockets.length, 1);
  const socket = h.sockets[0], lateOpen = socket.onopen, lateMessage = socket.onmessage;
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  lateOpen?.({});
  lateMessage?.({ data: JSON.stringify({ audio: 'AQI=' }) });
  assert.equal(socket.closed, 1);
  assert.equal(socket.sent.length, 0);
  assert.equal(played.length, 0);
});

test('v4 Turbo reports premature close after partial audio without regenerating speech', async () => {
  const h = dialogue(), played = [];
  const pending = h.api.ntElevenLabsStream('Часть фразы.', ru, h.settings, pcm => played.push(pcm));
  assert.equal(h.sockets.length, 1);
  const socket = h.sockets[0];
  socket.open(); socket.message({ audio: 'AQI=' }); socket.end(1006);
  await assert.rejects(pending, /1006|incomplete|closed/i);
  assert.equal(played.length, 1);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.fetches.length, 0);
});

test('v4 Turbo closes its transport if the audio consumer fails', async () => {
  const h = dialogue(), error = new Error('Player stopped');
  const pending = h.api.ntElevenLabsStream('Привет.', ru, h.settings, () => { throw error; });
  assert.equal(h.sockets.length, 1);
  h.sockets[0].open(); h.sockets[0].message({ audio: 'AQI=' });
  await assert.rejects(pending, value => value === error);
  assert.equal(h.sockets[0].closed, 1);
});
