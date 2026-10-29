const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness(restored = Promise.resolve({})) {
  const events = [], spoken = [];
  const listeners = { onMessage: [], onChanged: [], onUpdated: [], onRemoved: [] };
  const event = name => ({ addListener: fn => listeners[name].push(fn) });
  let resolveTranslation, resolveVoices;
  const listener = { addListener() {} };
  const settings = { source: 'captions', voice: 'off', targetLang: 'ru', browserRate: 1, dubVolume: 1 };
  const ctx = vm.createContext({ console, URL, AbortController, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout,
    importScripts() {}, ntGetSettings: async () => ({ ...settings }), ntSetLang() {}, ntValidate: () => [],
    ntFindLanguage: () => ({ gt: 'ru', tts: 'ru-RU' }),
    ntTranslate: () => new Promise(r => { resolveTranslation = r; }),
    chrome: {
      storage: { session: { get: () => typeof restored === 'function' ? restored(ctx) : restored, set: async () => {} }, local: { get() {}, set() {} }, onChanged: event('onChanged') },
      runtime: { onMessage: event('onMessage'), onInstalled: listener, getURL: p => p, getContexts: async () => [], sendMessage: async m => { events.push(m); } },
      tabs: { get: async () => ({url:'https://video.test'}), sendMessage: async () => ({ ok: true }), onRemoved: event('onRemoved'), onUpdated: event('onUpdated') },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tts: { stop() {}, getVoices: r => { resolveVoices = r; }, speak: (...a) => spoken.push(a) },
      commands: { onCommand: listener }
    }
  });
  for (const file of ['src/shared/speech-queue.js', 'src/shared/speech-timing.js', 'src/shared/speakers.js'])
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('src/background/background.js', 'utf8'), ctx);
  harnessContexts.push(ctx);
  return { ctx, events, spoken, settings, listeners, resolveTranslation: r => resolveTranslation(r), resolveVoices: r => resolveVoices(r) };
}
const harnessContexts=[];
test.after(()=>{for(const ctx of harnessContexts)vm.runInContext('voiceQueue.clear();cancelBrowserSpeech()',ctx);});
const tick = () => new Promise(r => setImmediate(r));
const request = (h, message) => new Promise(resolve => h.listeners.onMessage[0](message, {}, resolve));

for (const [key, value] of [['elevenModel', 'eleven_v4_turbo'], ['elevenVoiceId2', 'new-guest']]) {
  test(`changing ${key} during ElevenLabs playback releases the active queue immediately`, async () => {
    const h = harness(); await tick();
    Object.assign(h.settings, { voice: 'elevenlabs', elevenModel: 'eleven_flash_v2_5', elevenVoiceId: 'narrator' });
    h.ctx.chrome.runtime.getContexts = async () => [{}];
    h.ctx.chrome.runtime.sendMessage = async msg => { h.events.push(msg); return { ok: true }; };
    const tabMessages = [];
    h.ctx.chrome.tabs.sendMessage = async (id, msg) => { tabMessages.push(msg); return { ok: true }; };
    vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'elevenlabs',sessionId:'A'};speak('Сейчас говорит диктор.')", h.ctx);
    await tick(); await tick();
    assert.equal(vm.runInContext('voiceQueue.active', h.ctx), true);
    h.settings[key] = value;
    await h.listeners.onChanged[0]({ [key]: { newValue: value } }, 'local');
    await tick();
    assert.equal(vm.runInContext('voiceQueue.active', h.ctx), false, 'do not wait for a cancelled phrase watchdog');
    assert.ok(tabMessages.some(msg => msg.type === 'NT_C_REFRESH'), 're-read the current cue with the selected voice/model');
  });
}

test('a translation from a stopped session cannot appear in a new session', async () => {
  const h = harness(); await tick();
  vm.runInContext("state = {...IDLE_STATE, active:true, tabId:1, source:'captions'}; handleCaption('old')", h.ctx);
  await tick();
  await vm.runInContext('stop()', h.ctx);
  vm.runInContext("state = {...IDLE_STATE, active:true, tabId:2, source:'captions'}", h.ctx);
  h.resolveTranslation({ text: 'old translation', ok: true }); await tick();
  assert.equal(h.events.filter(e => e.type === 'NT_SUBTITLE' && e.text).length, 0);
});

test('translation outage reports an error instead of speaking the original as a translation', async () => {
  const h = harness(); await tick();
  vm.runInContext("state = {...IDLE_STATE, active:true, tabId:1, source:'captions'}; handleCaption('hello')", h.ctx);
  await tick(); h.resolveTranslation({ text: 'hello', ok: false, error: 'HTTP 429' }); await tick();
  assert.equal(h.events.filter(e => e.type === 'NT_SUBTITLE').length, 0);
  assert.equal(vm.runInContext('state.status', h.ctx), 'translation_error');
});

test('stopping while loading browser voices prevents later speech', async () => {
  const h = harness(); await tick();
  vm.runInContext("state = {...IDLE_STATE, active:true, tabId:1, source:'captions', voice:'browser'}; speakBrowser('late', {tts:'ru-RU'}, {browserRate:1,dubVolume:1})", h.ctx);
  await tick(); await vm.runInContext('stop()', h.ctx);
  h.resolveVoices([]); await tick();
  assert.equal(h.spoken.length, 0);
});

test('navigation pending during stop cannot remount the content overlay', async () => {
  const h = harness(); await tick();
  const messages = []; let resolvePing;
  h.ctx.chrome.tabs.sendMessage = async (id, message) => {
    messages.push(message.type);
    if (message.type === 'NT_PING') return new Promise(r => {resolvePing = r;});
    return {ok:true};
  };
  vm.runInContext("state = {...IDLE_STATE, active:true, tabId:1, source:'captions',sessionId:'A'}", h.ctx);
  const navigation = h.listeners.onUpdated[0](1, {status:'complete'});
  await tick(); await vm.runInContext('stop()', h.ctx);
  resolvePing({ok:true}); await navigation; await tick();
  assert.equal(messages.includes('NT_C_START'), false);
});

test('settings loaded after stop cannot recreate the offscreen document', async () => {
  const h = harness(); await tick(); let resolveSettings, created = 0;
  h.ctx.ntGetSettings = () => new Promise(r => {resolveSettings = r;});
  h.ctx.chrome.offscreen = {createDocument: async () => {created++;}};
  vm.runInContext("state = {...IDLE_STATE, active:true, tabId:1, source:'captions',sessionId:'A'}", h.ctx);
  const change = h.listeners.onChanged[0]({voice:{newValue:'google'}}, 'local');
  await tick(); await vm.runInContext('stop()', h.ctx);
  resolveSettings({...h.settings,voice:'google'}); await change; await tick();
  assert.equal(created, 0);
});

test('a queued fatal error cannot stop a newer session', async () => {
  const h = harness(); await tick(); let unblock;
  h.ctx.blocker = new Promise(r => {unblock = r;});
  vm.runInContext("state = {...IDLE_STATE, active:true, tabId:1,sessionId:'A'}; runLifecycle(() => blocker); runLifecycle(() => { state = {...IDLE_STATE,active:true,sessionId:'B'}; });", h.ctx);
  h.listeners.onMessage[0]({type:'NT_OFF_FATAL',sessionId:'A',detail:'old error'}, {}, () => {});
  unblock(); await tick(); await tick();
  assert.equal(vm.runInContext('state.active', h.ctx), true);
  assert.equal(vm.runInContext('state.sessionId', h.ctx), 'B');
});

test('Stop message cancels startup before a pending page request resolves', async () => {
  const h = harness(); await tick();
  const messages = []; let resolvePing;
  h.ctx.chrome.tabs.sendMessage = async (id, message) => {
    messages.push(message.type);
    if (message.type === 'NT_PING') return new Promise(resolve => { resolvePing = resolve; });
    return {ok:true};
  };
  const startup = request(h, {type:'NT_START',tabId:1});
  await tick();
  let replied = false;
  const stopping = request(h, {type:'NT_STOP'}).then(() => { replied = true; });
  await tick();
  const cancelledBeforePing = !vm.runInContext('state.active', h.ctx) && replied;
  resolvePing({ok:true});
  await startup; await stopping; await tick();
  assert.equal(cancelledBeforePing, true);
  assert.equal(messages.includes('NT_C_START'), false);
});

test('state restoration cannot resurrect a session after Stop', async () => {
  let restore;
  const h = harness(new Promise(resolve => { restore = resolve; }));
  const messages = [];
  h.ctx.chrome.tabs.sendMessage = async (id, message) => {messages.push(message.type); return {ok:true};};
  const stopping = request(h, {type:'NT_STOP'});
  await tick();
  restore({ntState:{active:true,tabId:7,source:'captions',sessionId:'old'}});
  await stopping; await tick();
  assert.equal(vm.runInContext('state.active', h.ctx), false);
  assert.ok(messages.includes('NT_C_STOP'));
});

test('offscreen speech retries cannot cross into a replacement session', async () => {
  const h = harness(); await tick();
  h.settings.voice = 'google';
  const attempts = [];
  h.ctx.chrome.runtime.getContexts=async()=>[{}];
  h.ctx.chrome.runtime.sendMessage = async message => {
    if (message.type === 'NT_OFF_SPEAK') {attempts.push(message); return undefined;}
    return {ok:true};
  };
  vm.runInContext("state = {...IDLE_STATE,active:true,source:'captions',sessionId:'A'}", h.ctx);
  await vm.runInContext("speak('old session text')", h.ctx);
  await tick(); await request(h, {type:'NT_STOP'});
  vm.runInContext("state = {...IDLE_STATE,active:true,source:'captions',sessionId:'B'}", h.ctx);
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].sessionId, 'A');
});

test('browser voice test reports a synthesis error instead of success', async () => {
  const h = harness(); await tick();
  h.ctx.chrome.tts.speak = (text, options) => options.onEvent?.({type:'error',errorMessage:'Voice unavailable'});
  const result = await Promise.race([
    request(h, {type:'NT_TEST_BROWSER_VOICE',text:'test',lang:'ru-RU'}),
    new Promise(resolve => setTimeout(() => resolve({ok:true}), 30))
  ]);
  assert.equal(result.ok, false);
});

test('browser API rejection releases the voice queue and reports failure', async () => {
  const h = harness(); await tick();
  h.ctx.chrome.tts.speak = (text, options, callback) => {
    h.ctx.chrome.runtime.lastError = {message:'No voices available'};
    callback?.();
    delete h.ctx.chrome.runtime.lastError;
  };
  vm.runInContext("state = {...IDLE_STATE,active:true,source:'captions',voice:'browser'}; speakBrowser('test',{tts:'ru-RU'},{browserRate:1,dubVolume:1})", h.ctx);
  await tick(); h.resolveVoices([]); await tick();
  assert.equal(vm.runInContext('ttsBusy', h.ctx), false);
  assert.equal(vm.runInContext('state.status', h.ctx), 'voice_error');
});

test('replacement startup cannot overtake a cancelled offscreen cleanup', async () => {
  const h = harness(); await tick();
  h.settings.voice = 'google';
  let exists = true, lookups = 0, release;
  h.ctx.chrome.runtime.getContexts = () => ++lookups === 1
    ? new Promise(resolve => {release = resolve;}) : Promise.resolve(exists ? [{}] : []);
  h.ctx.chrome.runtime.sendMessage = async () => ({ok:true});
  h.ctx.chrome.offscreen = {
    createDocument: async () => {exists = true;}, closeDocument: async () => {exists = false;}
  };
  vm.runInContext("state = {...IDLE_STATE,active:true,tabId:1,source:'captions',sessionId:'A'}", h.ctx);
  const replacement = request(h, {type:'NT_START',tabId:2});
  await tick();
  const stopping = request(h, {type:'NT_STOP'});
  await tick();
  const fresh = request(h, {type:'NT_START',tabId:3});
  await tick(); release([{}]);
  await replacement; await stopping; await fresh; await tick();
  assert.equal(vm.runInContext('state.active', h.ctx), true);
  assert.equal(vm.runInContext('state.tabId', h.ctx), 3);
  assert.equal(exists, true);
});

test('tab close waits for worker state restoration before cleaning the session', async () => {
  let restore;
  const h = harness(new Promise(resolve => {restore = resolve;}));
  const closing = h.listeners.onRemoved[0](7);
  restore({ntState:{active:true,tabId:7,source:'captions',sessionId:'A'}});
  await closing; await tick();
  assert.equal(vm.runInContext('state.active', h.ctx), false);
});

test('a slow earlier translation does not block a newer subtitle', async () => {
  const h = harness(); await tick();
  const replies = new Map();
  h.ctx.ntTranslate = text => new Promise(resolve => replies.set(text, resolve));
  vm.runInContext("state = {...IDLE_STATE,active:true,source:'captions',targetLang:'ru'}; handleCaption('slow'); handleCaption('fresh')", h.ctx);
  await tick(); replies.get('fresh')({ok:true,text:'Свежая фраза'}); await tick();
  const visible = h.events.filter(e => e.type === 'NT_SUBTITLE' && e.text).map(e => e.text);
  replies.get('slow')({ok:true,text:'Старая фраза'}); await tick();
  assert.deepEqual(visible, ['Свежая фраза']);
  assert.equal(h.events.filter(e => e.type === 'NT_SUBTITLE' && e.text).at(-1).text, 'Свежая фраза');
});

test('pausing media cancels a translation that is still in flight', async () => {
  const h = harness(); await tick();
  vm.runInContext("state = {...IDLE_STATE,active:true,tabId:1,source:'captions',targetLang:'ru',sessionId:'A'}; handleCaption('pending')", h.ctx);
  await tick();
  h.listeners.onMessage[0]({type:'NT_MEDIA_STATE',sessionId:'A',version:1,paused:true}, {tab:{id:1}}, () => {});
  await tick(); h.resolveTranslation({ok:true,text:'После паузы'}); await tick();
  assert.equal(h.events.filter(e => e.type === 'NT_SUBTITLE' && e.text).length, 0);
  assert.equal(vm.runInContext('state.status', h.ctx), 'paused');
});

test('translation older than the live budget is not displayed', async () => {
  const h = harness(); await tick(); let clock = 1000;
  h.ctx.Date = {now:() => clock};
  vm.runInContext("state = {...IDLE_STATE,active:true,source:'captions',targetLang:'ru'}; handleCaption('old')", h.ctx);
  await tick(); clock += 3100; h.resolveTranslation({ok:true,text:'Слишком поздно'}); await tick();
  assert.equal(h.events.filter(e => e.type === 'NT_SUBTITLE' && e.text).length, 0);
});

test('a late browser engine start event cannot duck audio after the cue expired', async () => {
  const h = harness(); await tick();
  const ducks = [];
  h.ctx.chrome.tabs.sendMessage = async (id, msg) => {if (msg.type === 'NT_C_DUCK') ducks.push(msg.on); return {ok:true};};
  h.ctx.expiry = Date.now() + 40;
  vm.runInContext("state = {...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'browser'}; speakBrowser('short',{tts:'ru-RU'},{browserRate:1,dubVolume:1},expiry)", h.ctx);
  await tick(); h.resolveVoices([{voiceName:'Russian',lang:'ru-RU'}]); await tick();
  assert.equal(h.spoken.length, 1);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(vm.runInContext('ttsBusy', h.ctx), false);
  h.spoken[0][1].onEvent({type:'start'});
  assert.equal(ducks.includes(true), false);
});

test('a new managed Google job stops leftover standalone browser speech', async () => {
  const h = harness(); await tick();
  h.settings.voice = 'google';
  let stops = 0;
  h.ctx.chrome.tts.stop = () => {stops++;};
  h.ctx.chrome.tts.getVoices = callback => callback([{voiceName:'Russian',lang:'ru-RU'}]);
  h.ctx.chrome.runtime.sendMessage = async msg => {h.events.push(msg);return {ok:true};};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'google'};speakBrowser('old fallback',{tts:'ru-RU'},{browserRate:1,dubVolume:1})",h.ctx);
  await tick();
  assert.equal(vm.runInContext('ttsBusy',h.ctx),true);
  await vm.runInContext("speak('new Google phrase')",h.ctx);
  assert.ok(stops>0);
  assert.equal(vm.runInContext('ttsBusy',h.ctx),false);
});

test('a delayed voice fallback cannot dispatch after a newer caption has begun', async () => {
  const h = harness(); await tick();
  h.settings.voice='browser';
  let release;
  h.ctx.ensureOffscreen=()=>new Promise(resolve=>{release=resolve;});
  h.ctx.chrome.runtime.sendMessage=async msg=>{h.events.push(msg);return {ok:true};};
  h.ctx.chrome.tts.getVoices=cb=>cb([{voiceName:'Russian',lang:'ru-RU'}]);
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'browser',sessionId:'A'}",h.ctx);
  const pending=vm.runInContext("googleVoiceFallback('obsolete',{tts:'ru-RU'},{voice:'browser'},Date.now()+1500)",h.ctx);
  await tick();
  await vm.runInContext("speak('replacement')",h.ctx);
  release(); await pending; await tick();
  assert.equal(h.events.some(msg=>msg.type==='NT_OFF_SPEAK'&&msg.text==='obsolete'),false);
});

test('worker restoration keeps voice epochs ahead of the surviving audio document', async () => {
  const h=harness(Promise.resolve({ntState:{active:true,tabId:1,source:'captions',voice:'google',sessionId:'A',voiceEpoch:8}}));
  await tick(); h.settings.voice='google';
  h.ctx.chrome.runtime.getContexts=async()=>[{}];
  h.ctx.chrome.runtime.sendMessage=async msg=>{h.events.push(msg);return {ok:true};};
  await vm.runInContext("speak('after worker restart')",h.ctx);
  await tick();
  const message=h.events.find(msg=>msg.type==='NT_OFF_SPEAK');
  assert.ok(message.voiceEpoch>8);
  assert.equal(vm.runInContext('state.voiceEpoch',h.ctx),message.voiceEpoch);
});

test('automatic browser voice selection prefers local speech and respects an explicit choice',()=>{
  const h=harness();
  h.ctx.voices=[{voiceName:'Google Russian Natural Online',lang:'ru-RU',remote:true},{voiceName:'Microsoft Irina',lang:'ru-RU',remote:false}];
  assert.equal(vm.runInContext("pickVoice(voices,{tts:'ru-RU'},'')",h.ctx),'Microsoft Irina');
  assert.equal(vm.runInContext("pickVoice(voices,{tts:'ru-RU'},'Google Russian Natural Online')",h.ctx),'Google Russian Natural Online');
});

test('preparing a future caption cannot display or speak it before its cue',async()=>{
  const h=harness();await tick();h.settings.voice='google';
  h.ctx.chrome.runtime.sendMessage=async msg=>{h.events.push(msg);return {ok:true};};
  h.ctx.chrome.runtime.getContexts=async()=>[{}];
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'google',targetLang:'ru',sessionId:'A'}",h.ctx);
  const pending=vm.runInContext("handleCaptionPrefetch('future','en',{mediaVersion:0,startAt:Date.now()+3000})",h.ctx);
  await tick();h.resolveTranslation({ok:true,text:'Будущая фраза'});await pending;
  assert.ok(h.events.some(msg=>msg.type==='NT_OFF_PREFETCH'&&msg.text==='Будущая фраза'));
  assert.equal(h.events.some(msg=>msg.type==='NT_OFF_SPEAK'||msg.type==='NT_SUBTITLE'),false);
});

test('pausing cancels a future caption preparation before it reaches audio',async()=>{
  const h=harness();await tick();h.settings.voice='google';
  h.ctx.chrome.runtime.sendMessage=async msg=>{h.events.push(msg);return {ok:true};};
  h.ctx.chrome.runtime.getContexts=async()=>[{}];
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'google',targetLang:'ru',sessionId:'A'}",h.ctx);
  const pending=vm.runInContext("handleCaptionPrefetch('future','en',{mediaVersion:0,startAt:Date.now()+3000})",h.ctx);
  await tick();
  vm.runInContext('handleMediaState({version:1,paused:true})',h.ctx);
  h.resolveTranslation({ok:true,text:'Будущая фраза'});await pending;
  assert.equal(h.events.some(msg=>msg.type==='NT_OFF_PREFETCH'),false);
});

test('changing source exits an active Gemini session and actually starts captions',async()=>{
  const h=harness();await tick();
  h.settings.source='captions';h.settings.voice='browser';
  const messages=[];h.ctx.chrome.tabs.sendMessage=async(id,msg)=>{messages.push(msg);return {ok:true};};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'gemini',voice:'gemini',sessionId:'A'}",h.ctx);
  await h.listeners.onChanged[0]({source:{newValue:'captions'},voice:{newValue:'browser'}},'local');await tick();
  assert.equal(vm.runInContext('state.source',h.ctx),'captions');
  assert.ok(messages.some(msg=>msg.type==='NT_C_STOP'));
  assert.ok(messages.some(msg=>msg.type==='NT_C_START'&&msg.settings.source==='captions'));
});

test('a new browser caption does not interrupt a speaking phrase',async()=>{
  const h=harness();await tick();h.settings.voice='browser';
  h.ctx.chrome.tts.getVoices=cb=>cb([{voiceName:'Russian',lang:'ru-RU',remote:false}]);
  h.ctx.chrome.tts.speak=(text,options)=>{h.spoken.push([text,options]);options.onEvent({type:'start'});};
  let stops=0;h.ctx.chrome.tts.stop=()=>{stops++;};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'browser'};speak('First phrase')",h.ctx);
  await tick();await tick();const before=stops;
  vm.runInContext("speak('Next phrase')",h.ctx);await tick();await tick();
  assert.equal(stops,before);assert.equal(h.spoken.length,1);
  h.spoken[0][1].onEvent({type:'end'});await tick();await tick();assert.equal(h.spoken.length,2);
  await vm.runInContext('stop()',h.ctx);
});

test('an expired browser fallback releases its active owner instead of stranding all captions',async()=>{
  const h=harness();await tick();h.ctx.completions=0;
  vm.runInContext("state={...IDLE_STATE,active:true,source:'captions'};activeVoiceCompletion={token:voiceEpoch,finish:()=>{completions++;}};speakBrowser('late',{tts:'ru-RU'},{},Date.now()-1,false)",h.ctx);
  await tick();assert.equal(h.ctx.completions,1);
});

test('an expired Google fallback releases its owner without creating an audio document',async()=>{
  const h=harness();await tick();h.ctx.completions=0;
  vm.runInContext("state={...IDLE_STATE,active:true,source:'captions'};activeVoiceCompletion={token:voiceEpoch,finish:()=>{completions++;}};",h.ctx);
  await vm.runInContext("googleVoiceFallback('late',{tts:'ru-RU'},{},Date.now()-1)",h.ctx);
  assert.equal(h.ctx.completions,1);
});

test('an interrupted browser engine falls back only with the remaining text',async()=>{
  const h=harness();await tick();h.ctx.remainders=[];
  h.ctx.chrome.tts.getVoices=cb=>cb([{voiceName:'Russian',lang:'ru-RU'}]);
  vm.runInContext("state={...IDLE_STATE,active:true,source:'captions'};googleVoiceFallback=async text=>remainders.push(text);speakBrowser('First second',{tts:'ru-RU'},{browserRate:1,dubVolume:1})",h.ctx);
  await tick();h.spoken[0][1].onEvent({type:'start'});h.spoken[0][1].onEvent({type:'interrupted',charIndex:6});await tick();
  assert.deepEqual(Array.from(h.ctx.remainders),['second']);
});

test('a long spoken sentence receives time to finish without an unbounded voice deadline',async()=>{
  const h=harness();await tick();h.settings.voice='google';
  h.ctx.chrome.runtime.getContexts=async()=>[{}];
  h.ctx.chrome.runtime.sendMessage=async msg=>{h.events.push(msg);return {ok:true};};
  vm.runInContext("state={...IDLE_STATE,active:true,source:'captions',voice:'google'};speak('Обычная длинная фраза '.repeat(5))",h.ctx);
  await tick();await tick();
  const speech=h.events.find(msg=>msg.type==='NT_OFF_SPEAK');
  assert.ok(speech.deadline-Date.now()>6000);
  assert.ok(speech.deadline-Date.now()<=15000);
});

test('a voice selection during the inactive source restart is not lost',async()=>{
  const h=harness();await tick();h.settings.voice='browser';
  let release,exists=false,calls=0;
  h.ctx.ntGetSettings=()=>{
    const snapshot={...h.settings};calls++;
    if(calls===1)return new Promise(resolve=>{release=()=>resolve(snapshot);});
    return Promise.resolve(snapshot);
  };
  h.ctx.chrome.runtime.getContexts=async()=>exists?[{}]:[];
  h.ctx.chrome.runtime.sendMessage=async()=>({ok:true});
  h.ctx.chrome.offscreen={createDocument:async()=>{exists=true;},closeDocument:async()=>{exists=false;}};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'gemini',voice:'gemini',sessionId:'A'}",h.ctx);
  const switching=h.listeners.onChanged[0]({source:{newValue:'captions'}},'local');
  await tick();await tick();assert.equal(typeof release,'function');
  h.settings.voice='google';await h.listeners.onChanged[0]({voice:{newValue:'google'}},'local');
  release();await switching;await tick();
  assert.equal(vm.runInContext('state.voice',h.ctx),'google');
  assert.equal(vm.runInContext('state.source',h.ctx),'captions');
});

test('a transient live-settings read failure cannot permanently silence the next caption',async()=>{
  const h=harness();await tick();h.settings.voice='browser';let reads=0;
  h.ctx.ntGetSettings=async()=>{if(++reads===1)throw new Error('Temporary storage failure');return {...h.settings};};
  h.ctx.chrome.tts.getVoices=cb=>cb([{voiceName:'Russian',lang:'ru-RU'}]);
  h.ctx.chrome.tts.speak=(...args)=>h.spoken.push(args);
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'google',sessionId:'A'}",h.ctx);
  await h.listeners.onChanged[0]({voice:{newValue:'browser'}},'local');
  await vm.runInContext("speak('Fresh sentence')",h.ctx);await tick();await tick();
  assert.equal(vm.runInContext('state.voice',h.ctx),'browser');assert.equal(h.spoken.length,1);
});

test('a delayed speech settings read cannot revert a newer voice selection',async()=>{
  const h=harness();await tick();h.settings.voice='browser';let release,reads=0;
  h.ctx.ntGetSettings=()=>{const snapshot={...h.settings};if(++reads===1)return new Promise(resolve=>{release=()=>resolve(snapshot);});return Promise.resolve(snapshot);};
  h.ctx.chrome.runtime.getContexts=async()=>[{}];h.ctx.chrome.runtime.sendMessage=async msg=>{h.events.push(msg);return {ok:true};};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'browser',targetLang:'ru',sessionId:'A'}",h.ctx);
  const pending=vm.runInContext("speak('obsolete')",h.ctx);await tick();
  h.settings.voice='google';await h.listeners.onChanged[0]({voice:{newValue:'google'}},'local');
  release();await pending;await tick();
  assert.equal(vm.runInContext('state.voice',h.ctx),'google');assert.equal(h.spoken.length,0);
});

test('a failed language notification still reconciles Gemini before discarding an old-language transcript',async()=>{
  const h=harness();await tick();h.settings.source='gemini';h.settings.voice='browser';h.settings.targetLang='en';
  h.ctx.chrome.runtime.getContexts=async()=>[{}];h.ctx.chrome.runtime.sendMessage=async msg=>{h.events.push(msg);return {ok:true};};
  vm.runInContext("state={...IDLE_STATE,active:true,source:'gemini',voice:'browser',targetLang:'ru',sessionId:'A'}",h.ctx);
  await vm.runInContext("speak('старый русский текст')",h.ctx);await tick();
  assert.equal(vm.runInContext('state.targetLang',h.ctx),'en');
  assert.ok(h.events.some(msg=>msg.type==='NT_OFF_SETTINGS'&&msg.settings.targetLang==='en'));
  assert.equal(h.spoken.length,0);
});

test('a transient translation failure retries once only while the same caption is still current',async()=>{
  const h=harness();await tick();let calls=0;
  h.ctx.ntTranslate=async()=>++calls===1?{ok:false,error:'freeTranslationUnavailable',detail:'Failed to fetch'}:{ok:true,text:'Recovered translation',detected:'en'};
  h.ctx.chrome.tabs.sendMessage=async(id,msg)=>msg.type==='NT_C_CHECK_CAPTION'?{current:true,deadline:Date.now()+2500}:{ok:true};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',targetLang:'ru'};handleCaption('Still visible sentence.','en')",h.ctx);
  await tick();await tick();
  assert.equal(calls,2);assert.ok(h.events.some(msg=>msg.type==='NT_SUBTITLE'&&msg.text==='Recovered translation'));
});

test('a vanished caption and a quota error are never retried',async()=>{
  const h=harness();await tick();let calls=0;
  h.ctx.ntTranslate=async()=>{calls++;return {ok:false,error:'freeTranslationUnavailable',detail:'Google HTTP 429'};};
  h.ctx.chrome.tabs.sendMessage=async()=>({current:true,deadline:Date.now()+2500});
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',targetLang:'ru'};handleCaption('Quota','en')",h.ctx);
  await tick();await tick();assert.equal(calls,1);
  h.ctx.ntTranslate=async()=>{calls++;return {ok:false,error:'freeTranslationUnavailable',detail:'Failed to fetch'};};
  h.ctx.chrome.tabs.sendMessage=async()=>({current:false});
  vm.runInContext("handleCaption('Gone','en')",h.ctx);await tick();await tick();assert.equal(calls,2);
});

test('a queued phrase cannot start after its freshness budget expires during a settings read',async()=>{
  const h=harness();await tick();h.settings.voice='google';
  let now=1000,release;
  h.ctx.Date={now:()=>now};
  h.ctx.ntGetSettings=()=>new Promise(resolve=>{release=()=>resolve({...h.settings});});
  h.ctx.chrome.runtime.getContexts=async()=>[{}];
  h.ctx.chrome.runtime.sendMessage=async msg=>{h.events.push(msg);return {ok:true};};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'google',sessionId:'A'};voiceQueue.enqueue({text:'stale',settings:{voice:'google',targetLang:'ru'},epoch:sessionEpoch,deadline:3500,startBy:2000})",h.ctx);
  await tick();now=2100;release();await tick();await tick();
  assert.equal(h.events.some(msg=>msg.type==='NT_OFF_SPEAK'),false);
  assert.equal(vm.runInContext('voiceQueue.active',h.ctx),false);
});

test('navigation loading cancels current speech and pending captions before page completion',async()=>{
  const h=harness();await tick();h.settings.voice='browser';
  h.ctx.chrome.tts.getVoices=cb=>cb([{voiceName:'Russian',lang:'ru-RU'}]);
  h.ctx.chrome.tts.speak=(text,options)=>{h.spoken.push([text,options]);options.onEvent({type:'start'});};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'browser',sessionId:'A'};speak('Current');speak('Waiting')",h.ctx);
  await tick();await tick();
  assert.equal(h.spoken.length,1);
  let stops=0;h.ctx.chrome.tts.stop=()=>{stops++;};
  await h.listeners.onUpdated[0](1,{status:'loading'});await tick();
  assert.ok(stops>0);
  assert.equal(vm.runInContext('voiceQueue.active',h.ctx),false);
  assert.equal(vm.runInContext('voiceQueue.pendingCount',h.ctx),0);
  assert.equal(vm.runInContext('state.paused',h.ctx),true);
  h.spoken[0][1].onEvent({type:'end'});await tick();
  assert.equal(h.spoken.length,1);
  await h.listeners.onUpdated[0](1,{status:'complete'});await tick();
  assert.equal(vm.runInContext('state.active',h.ctx),true);
});

test('late speaking and error signals from an older voice cannot affect its replacement',async()=>{
  const h=harness();await tick();const ducks=[];
  h.ctx.chrome.tabs.sendMessage=async(id,msg)=>{if(msg.type==='NT_C_DUCK')ducks.push(msg.on);return {ok:true};};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'google',sessionId:'A',status:'translating'};voiceEpoch=4",h.ctx);
  h.listeners.onMessage[0]({type:'NT_OFF_SPEAKING',sessionId:'A',mediaVersion:0,voiceEpoch:3,on:true},{},()=>{});
  h.listeners.onMessage[0]({type:'NT_OFF_STATUS',sessionId:'A',mediaVersion:0,voiceEpoch:3,code:'voice_error',detail:'old error'},{},()=>{});
  await tick();assert.deepEqual(ducks,[]);
  assert.equal(vm.runInContext('state.status',h.ctx),'translating');
  h.listeners.onMessage[0]({type:'NT_OFF_SPEAKING',sessionId:'A',mediaVersion:0,voiceEpoch:4,on:true},{},()=>{});
  await tick();assert.deepEqual(ducks,[true]);
});

test('failed navigation reinjection ends the session and reports the page error',async()=>{
  const h=harness();await tick();
  h.ctx.chrome.tabs.sendMessage=async()=>{throw new Error('No content script');};
  h.ctx.chrome.scripting={executeScript:async()=>{throw new Error('Cannot access this page');}};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'off',sessionId:'A'}",h.ctx);
  await h.listeners.onUpdated[0](1,{status:'complete'});await tick();
  assert.equal(vm.runInContext('state.active',h.ctx),false);
  assert.equal(vm.runInContext('state.status',h.ctx),'error');
  assert.match(vm.runInContext('state.detail',h.ctx),/Cannot access this page/);
});

test('media resume received during worker restoration is applied to restored session state',async()=>{
  let restore;
  const h=harness(new Promise(resolve=>{restore=resolve;}));
  // A runtime sender retains its tab while session storage is still loading.
  const receive=h.listeners.onMessage[0];let acknowledged=false;
  const pending=receive({type:'NT_MEDIA_STATE',sessionId:'A',version:5,paused:false},{tab:{id:1}},()=>{acknowledged=true;});
  assert.equal(pending,true);
  restore({ntState:{...h.settings,active:true,tabId:1,sessionId:'A',mediaVersion:4,paused:true}});
  await tick();await tick();
  assert.equal(vm.runInContext('state.paused',h.ctx),false);
  assert.equal(vm.runInContext('state.mediaVersion',h.ctx),5);
  assert.equal(acknowledged,true);
});

test('browser voice discovery cannot start a queued caption after startBy',async()=>{
  const h=harness();await tick();h.settings.voice='browser';let now=1000;
  h.ctx.Date={now:()=>now};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'browser',sessionId:'A'};voiceQueue.enqueue({text:'Expired while loading voices',settings:{voice:'browser',targetLang:'ru'},epoch:sessionEpoch,deadline:3500,startBy:2000})",h.ctx);
  await tick();await tick();now=2100;
  h.resolveVoices([{voiceName:'Russian',lang:'ru-RU'}]);await tick();await tick();
  assert.equal(h.spoken.length,0);
  assert.equal(vm.runInContext('voiceQueue.active',h.ctx),false);
});

test('settings changed during startup reconcile the page after its initial snapshot',async()=>{
  const h=harness();await tick();h.settings.originalVolume=.25;
  let release;const configs=[];
  h.ctx.chrome.tabs.sendMessage=async(id,msg)=>{
    if(msg.type==='NT_PING')return new Promise(resolve=>{release=()=>resolve({ok:true});});
    if(msg.type==='NT_C_START'||msg.type==='NT_C_SETTINGS')configs.push({settings:msg.settings,sessionId:msg.sessionId});
    return {ok:true};
  };
  const startup=request(h,{type:'NT_START',tabId:1});await tick();
  h.settings.originalVolume=.8;
  const change=h.listeners.onChanged[0]({originalVolume:{newValue:.8}},'local');
  release();await startup;await change;await tick();
  assert.equal(configs.at(-1).settings.originalVolume,.8);
  assert.equal(configs.at(-1).sessionId,vm.runInContext('state.sessionId',h.ctx));
});

test('a source change waiting for restoration cannot restart a session after Stop',async()=>{
  const h=harness(ctx=>vm.runInContext('new Promise(resolve=>{globalThis.restoreSession=resolve;})',ctx));
  const messages=[];h.ctx.chrome.tabs.sendMessage=async(id,msg)=>{messages.push(msg.type);return {ok:true};};
  const stopping=request(h,{type:'NT_STOP'});
  const change=h.listeners.onChanged[0]({source:{newValue:'captions'}},'local');
  h.ctx.restoreSession({ntState:{...h.settings,active:true,tabId:1,source:'captions',sessionId:'A'}});
  await stopping;await change;await tick();await tick();
  assert.equal(vm.runInContext('state.active',h.ctx),false);
  assert.equal(messages.includes('NT_C_START'),false);
});

test('an old navigation failure cannot terminate a newer page navigation',async()=>{
  const h=harness();await tick();let rejectOld,pings=0;const messages=[];
  h.ctx.chrome.tabs.sendMessage=async(id,msg)=>{
    messages.push(msg.type);
    if(msg.type==='NT_PING'&&++pings===1)throw new Error('Old document disappeared');
    return {ok:true};
  };
  h.ctx.chrome.scripting={executeScript:()=>new Promise((resolve,reject)=>{rejectOld=reject;})};
  vm.runInContext("state={...IDLE_STATE,active:true,tabId:1,source:'captions',voice:'off',sessionId:'A'}",h.ctx);
  const oldNavigation=h.listeners.onUpdated[0](1,{status:'complete'});await tick();
  await h.listeners.onUpdated[0](1,{status:'loading'});
  const newNavigation=h.listeners.onUpdated[0](1,{status:'complete'});await tick();
  rejectOld(new Error('Old injection rejected'));
  await oldNavigation;await newNavigation;await tick();
  assert.equal(vm.runInContext('state.active',h.ctx),true);
  assert.equal(messages.includes('NT_C_START'),true);
  assert.notEqual(vm.runInContext('state.status',h.ctx),'error');
});
