// Worker-level tests for real-time voice timing and multi-speaker voices.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness(settingsPatch = {}) {
  const events = [], spoken = [], tabMessages = [];
  const listeners = {onMessage: [], onChanged: [], onUpdated: [], onRemoved: []};
  const event = name => ({addListener: fn => listeners[name].push(fn)});
  const listener = {addListener() {}};
  const settings = Object.assign({source: 'captions', voice: 'browser', targetLang: 'ru', browserRate: 1, dubVolume: 1,
    maxTempo: 1.6, syncMode: 'realtime', multiVoice: true, speakerAudio: true}, settingsPatch);
  const ctx = vm.createContext({console, URL, AbortController, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout, Date,
    importScripts() {}, ntGetSettings: async () => ({...settings}), ntSetLang() {}, ntValidate: () => [],
    ntFindLanguage: () => ({gt: 'ru', tts: 'ru-RU'}),
    ntTranslate: async text => ({ok: true, text: 'RU ' + text, detected: 'en'}),
    chrome: {
      storage: {session: {get: async () => ({}), set: async () => {}}, local: {get() {}, set() {}}, onChanged: event('onChanged')},
      runtime: {onMessage: event('onMessage'), onInstalled: listener, getURL: p => p, getContexts: async () => [],
        sendMessage: async m => { events.push(m); return {ok: true}; }},
      tabs: {get: async () => ({url: 'https://video.test'}), sendMessage: async (id, m) => { tabMessages.push(m); return {ok: true}; },
        onRemoved: event('onRemoved'), onUpdated: event('onUpdated')},
      action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
      tts: {stop() {}, isSpeaking: cb => cb(true),
        getVoices: cb => cb([{voiceName: 'Microsoft Irina', lang: 'ru-RU', remote: false}, {voiceName: 'Microsoft Pavel', lang: 'ru-RU', remote: false}]),
        speak: (text, options) => { spoken.push({text, options}); options.onEvent({type: 'start'}); }},
      commands: {onCommand: listener}
    }
  });
  for (const file of ['src/shared/speech-queue.js', 'src/shared/speech-timing.js', 'src/shared/speakers.js', 'src/background/background.js'])
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  contexts.push(ctx);
  return {ctx, events, spoken, settings, listeners, tabMessages};
}
const contexts = [];
test.after(() => { for (const ctx of contexts) vm.runInContext('voiceQueue.clear();cancelBrowserSpeech()', ctx); });
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const active = "state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'browser',targetLang:'ru',sessionId:'A'};";

test('a roomy sync window keeps the user rate; a tight one speeds the voice up', async () => {
  const h = harness(); await tick();
  vm.runInContext(active + "speak('Короткая фраза.', Date.now()+9000, 'ru', {syncEnd: Date.now()+8000})", h.ctx);
  await settle();
  assert.equal(h.spoken[0].options.rate, 1);
  h.spoken[0].options.onEvent({type: 'end'}); await settle();
  vm.runInContext("speak('Довольно длинная фраза, которую нужно сказать очень быстро, иначе голос отстанет.', Date.now()+9000, 'ru', {syncEnd: Date.now()+3000})", h.ctx);
  await settle();
  const rate = h.spoken[1].options.rate;
  assert.ok(rate > 1.3 && rate <= 1.6, String(rate));
});

test('a phrase whose slot is already over is not spoken in realtime mode but is in complete mode', async () => {
  const h = harness(); await tick();
  vm.runInContext(active + "speak('Опоздавшая фраза', Date.now()+9000, 'ru', {syncEnd: Date.now()-5000})", h.ctx);
  await settle();
  assert.equal(h.spoken.length, 0);
  h.settings.syncMode = 'complete';
  vm.runInContext("speak('Опоздавшая фраза', Date.now()+9000, 'ru', {syncEnd: Date.now()-5000})", h.ctx);
  await settle();
  assert.equal(h.spoken.length, 1);
  assert.equal(h.spoken[0].options.rate, 1.6);
});

test('an overrunning phrase yields to a newer one instead of letting the voice drift', async () => {
  const h = harness(); await tick();
  let stops = 0; h.ctx.chrome.tts.stop = () => { stops++; };
  vm.runInContext(active + "speak('Первая фраза, которая слишком длинная, чтобы успеть закончиться к своему окну.', Date.now()+9000, 'ru', {syncEnd: Date.now()-600})", h.ctx);
  await settle();
  assert.equal(h.spoken.length, 1);
  const before = stops;
  await new Promise(resolve => setTimeout(resolve, 150));
  vm.runInContext("speak('Свежая фраза', Date.now()+9000, 'ru', {syncEnd: Date.now()+3000})", h.ctx);
  await settle();
  assert.ok(stops > before, 'the overrun phrase was stopped');
  assert.equal(h.spoken.at(-1).text, 'Свежая фраза');
});

test('a dialogue caption is translated per speaker and voiced with two different voices', async () => {
  const h = harness(); await tick();
  vm.runInContext(active + "handleCaption('>> Where are you? >> At home.', 'en', {mediaVersion:0, deadline: Date.now()+4000, syncEnd: Date.now()+4000})", h.ctx);
  await settle();
  const subtitle = h.events.find(m => m.type === 'NT_SUBTITLE' && m.text);
  assert.equal(subtitle.text, '— RU Where are you? — RU At home.');
  assert.equal(subtitle.original, '— Where are you? — At home.');
  assert.equal(h.spoken.length, 1);
  assert.equal(h.spoken[0].text, 'RU Where are you?');
  h.spoken[0].options.onEvent({type: 'end'}); await settle();
  assert.equal(h.spoken.length, 2);
  assert.equal(h.spoken[1].text, 'RU At home.');
  assert.notEqual(h.spoken[0].options.voiceName, h.spoken[1].options.voiceName);
});

test('turning multiple voices off keeps one voice for everybody', async () => {
  const h = harness({multiVoice: false}); await tick();
  vm.runInContext(active + "handleCaption('>> One. >> Two.', 'en', {mediaVersion:0, deadline: Date.now()+4000, syncEnd: Date.now()+4000})", h.ctx);
  await settle();
  h.spoken[0].options.onEvent({type: 'end'}); await settle();
  assert.equal(h.spoken[0].options.voiceName, h.spoken[1].options.voiceName);
  assert.equal(h.spoken[1].options.pitch, 1);
});

test('sound tags are shown but not spoken', async () => {
  const h = harness(); await tick();
  h.ctx.ntTranslate = async () => ({ok: true, text: '[Музыка]', detected: 'en'});
  vm.runInContext(active + "handleCaption('[Music]', 'en', {mediaVersion:0, deadline: Date.now()+4000})", h.ctx);
  await settle();
  assert.ok(h.events.some(m => m.type === 'NT_SUBTITLE' && m.text === '[Музыка]'));
  assert.equal(h.spoken.length, 0);
});

test('a low-pitched speaker detected from tab audio gets a lowered Google voice', async () => {
  const h = harness({voice: 'google'}); await tick();
  h.ctx.chrome.runtime.getContexts = async () => [{}];
  h.ctx.chrome.runtime.sendMessage = async m => {
    h.events.push(m);
    if (m.type === 'NT_OFF_SPEAKER') return {ok: true, speaker: {cluster: 3, hz: 110, pitchClass: 'low'}};
    return {ok: true};
  };
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'google',targetLang:'ru',sessionId:'A',capture:true};" +
    "handleCaption('Hello there.', 'en', {mediaVersion:0, deadline: Date.now()+4000, spokenFrom: Date.now()-1500, spokenTo: Date.now()-200, syncEnd: Date.now()+3000})", h.ctx);
  await settle();
  const query = h.events.find(m => m.type === 'NT_OFF_SPEAKER');
  assert.ok(query && query.to > query.from);
  const speech = h.events.find(m => m.type === 'NT_OFF_SPEAK');
  assert.ok(speech.voice.pitch < 0.9, JSON.stringify(speech.voice));
  assert.ok(Number.isFinite(speech.syncEnd));
  assert.equal(speech.maxTempo, 1.6);
});

test('with tab capture active, ducking goes to the audio mixer, not the page', async () => {
  const h = harness(); await tick();
  vm.runInContext(active + 'state.capture=true;setDuck(true)', h.ctx);
  await settle();
  assert.ok(h.events.some(m => m.type === 'NT_OFF_DUCK' && m.on === true));
  assert.equal(h.tabMessages.some(m => m.type === 'NT_C_DUCK'), false);
});

test('a refused tab capture still starts free translation and names the reason', async () => {
  const h = harness(); await tick();
  let created = false;
  h.ctx.chrome.runtime.getContexts = async () => created ? [{}] : [];
  h.ctx.chrome.offscreen = {createDocument: async () => { created = true; }, closeDocument: async () => { created = false; }};
  h.ctx.chrome.tabCapture = {getMediaStreamId: async () => { throw new Error('Extension has not been invoked'); }};
  const result = await vm.runInContext('start(1)', h.ctx);
  assert.equal(result.ok, true);
  assert.equal(vm.runInContext('state.capture', h.ctx), false);
  assert.match(vm.runInContext('state.captureError', h.ctx), /not been invoked/);
  assert.ok(h.tabMessages.some(m => m.type === 'NT_C_START'));
  await vm.runInContext('stop()', h.ctx);
});

test('a granted tab capture is passed to the audio page and recorded in state', async () => {
  const h = harness(); await tick();
  let created = false; const prepares = [];
  h.ctx.chrome.runtime.getContexts = async () => created ? [{}] : [];
  h.ctx.chrome.offscreen = {createDocument: async () => { created = true; }, closeDocument: async () => { created = false; }};
  h.ctx.chrome.tabCapture = {getMediaStreamId: async () => 'stream-1'};
  h.ctx.chrome.runtime.sendMessage = async m => { if (m.type === 'NT_OFF_PREPARE') { prepares.push(m); return {ok: true, capture: true}; } return {ok: true}; };
  const result = await vm.runInContext('start(1)', h.ctx);
  assert.equal(result.ok, true);
  assert.equal(prepares[0].streamId, 'stream-1');
  assert.equal(vm.runInContext('state.capture', h.ctx), true);
  await vm.runInContext('stop()', h.ctx);
});

test('a phrase about to end finishes its last word before yielding, once', async () => {
  const h = harness(); await tick();
  let stops = 0; h.ctx.chrome.tts.stop = () => { stops++; };
  vm.runInContext(active + "speak('Короткая', Date.now()+9000, 'ru', {syncEnd: Date.now()-600})", h.ctx);
  await settle();
  const before = stops;
  await new Promise(resolve => setTimeout(resolve, 150));
  vm.runInContext("speak('Свежая фраза', Date.now()+9000, 'ru', {syncEnd: Date.now()+3000})", h.ctx);
  await settle();
  assert.equal(stops, before, 'not cut while its expected end is near');
  assert.equal(h.spoken.length, 1);
  // The engine never reports the end: after the grace it yields anyway.
  await new Promise(resolve => setTimeout(resolve, 900));
  await settle();
  assert.ok(stops > before);
  assert.equal(h.spoken.at(-1).text, 'Свежая фраза');
});

test('a dialogue whose first part was dropped as late does not speak the reply alone', async () => {
  const h = harness(); await tick();
  // The first part never starts (engine never emits 'start'), as when it is dropped.
  h.ctx.chrome.tts.speak = (text, options) => { h.spoken.push({text, options}); options.onEvent({type: 'end'}); };
  vm.runInContext(active + "voiceQueue.enqueue({text:'x',parts:[{text:'Первый',speaker:null},{text:'Второй',speaker:null}],settings:{voice:'browser',targetLang:'ru'},epoch:sessionEpoch,deadline:Date.now()+9000,startBy:Date.now()+3000})", h.ctx);
  await settle(); await settle();
  assert.deepEqual(h.spoken.map(s => s.text), ['Первый']);
});
