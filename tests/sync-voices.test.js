// Worker-level tests for real-time voice timing and multi-speaker voices.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {fakeClock} = require('./fixtures/clock.js');

function harness(settingsPatch = {}, globals = {}) {
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
    }, ...globals
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

test('complete mode retains seven captions behind a stalled translation and speaks after subtitle expiry',async()=>{
  const h=harness({syncMode:'complete'});await tick();let now=Date.now();h.ctx.Date={now:()=>now};
  const requests=[];
  h.ctx.ntTranslate=text=>new Promise(resolve=>requests.push({text,resolve}));
  vm.runInContext(active+"for(let i=1;i<=7;i++)handleCaption('Phrase '+i,'en',{deadline:Date.now()+1000,syncEnd:Date.now()+500})",h.ctx);
  await settle();now+=20000;
  for(let i=1;i<=7;i++){
    const request=requests.find(r=>r.text==='Phrase '+i);assert.ok(request,'accepted translation '+i);
    request.resolve({ok:true,text:'Translation '+i,detected:'en'});await settle();
  }
  assert.equal(h.spoken.length,1);
  for(let i=0;i<7;i++){assert.equal(h.spoken[i]?.text,'Translation '+(i+1));assert.equal(h.spoken[i].options.rate,1);h.spoken[i].options.onEvent({type:'end'});await settle();}
});

for(const reverse of [false,true])test('mixed-language dialogue suppresses only its target-language part '+reverse,async()=>{
  const h=harness();await tick();
  h.ctx.ntTranslate=async text=>({ok:true,text:text==='Hello'?'Translated hello':text,detected:text==='Hello'?'en':'ru'});
  vm.runInContext(active+`handleCaption('${reverse?'>> Hello >> Привет':'>> Привет >> Hello'}','auto',{deadline:Date.now()+5000})`,h.ctx);
  await settle();
  assert.deepEqual(h.spoken.map(s=>s.text),['Translated hello']);
  assert.equal(h.spoken[0].options.voiceName,reverse?'Microsoft Irina':'Microsoft Pavel');
});

test('fully target-language dialogue is displayed without speech',async()=>{
  const h=harness();await tick();h.ctx.ntTranslate=async text=>({ok:true,text,detected:'ru'});
  vm.runInContext(active+"handleCaption('>> Привет >> Пока','ru',{deadline:Date.now()+5000})",h.ctx);await settle();
  assert.equal(h.spoken.length,0);assert.ok(h.events.some(m=>m.type==='NT_SUBTITLE'&&m.text));
});

test('complete backlog overload preserves accepted work and asks for manual catchup',async()=>{
  const h=harness({syncMode:'complete'});await tick();h.ctx.ntTranslate=()=>new Promise(()=>{});
  vm.runInContext(active+"for(let i=0;i<260;i++)handleCaption('Phrase '+i,'en',{deadline:Date.now()+1000})",h.ctx);await settle();
  assert.ok(h.events.some(m=>m.type==='NT_STATE'&&m.state.detail==='completeBacklogFull'));
  assert.equal(vm.runInContext('translations.size',h.ctx),256);
  assert.equal(h.tabMessages.some(m=>m.type==='NT_C_PAUSE'),false);
  vm.runInContext('cancelTranslations()',h.ctx);
});

test('complete overload recovery cannot bypass earlier accepted translations',async()=>{
  const h=harness({syncMode:'complete'});await tick();const requests=[];
  h.ctx.ntTranslate=text=>new Promise(resolve=>requests.push({text,resolve}));
  vm.runInContext(active+"speak('Blocking',Date.now()+5000)",h.ctx);await settle();
  vm.runInContext("for(let i=1;i<=256;i++)handleCaption('P'+i,'en',{deadline:Date.now()+5000})",h.ctx);await settle();
  assert.equal(vm.runInContext('translations.size',h.ctx),255);
  assert.ok(h.events.some(m=>m.type==='NT_STATE'&&m.state.detail==='completeBacklogFull'));
  h.spoken[0].options.onEvent({type:'end'});await settle();
  vm.runInContext("handleCaption('P257','en',{deadline:Date.now()+5000})",h.ctx);await settle();
  assert.deepEqual(requests.map(r=>r.text),['P1'],'capacity recovery must still wait for P1');
  for(let i=1;i<=255;i++){
    assert.equal(requests.at(-1).text,'P'+i);
    requests.at(-1).resolve({ok:true,text:'Translation P'+i,detected:'en'});await settle();
  }
  assert.equal(requests.at(-1).text,'P257');
  requests.at(-1).resolve({ok:true,text:'Translation P257',detected:'en'});await settle();
  for(let i=1;i<=256;i++){
    assert.equal(h.spoken[i]?.text,'Translation P'+(i===256?257:i));
    h.spoken[i].options.onEvent({type:'end'});await settle();
  }
});

test('a complete translation retry remains accepted when a newer caption arrives',async()=>{
  const h=harness({syncMode:'complete'});await tick();const requests=[];
  h.ctx.ntTranslate=text=>new Promise(resolve=>requests.push({text,resolve}));
  h.ctx.chrome.tabs.sendMessage=async(id,m)=>m.type==='NT_C_CHECK_CAPTION'?{current:true,deadline:Date.now()+5000}:{ok:true};
  vm.runInContext(active+"handleCaption('P1','en',{deadline:Date.now()+5000})",h.ctx);await settle();
  requests[0].resolve({ok:false,error:'temporary network failure'});await settle();
  assert.deepEqual(requests.map(r=>r.text),['P1','P1']);
  vm.runInContext("handleCaption('P2','en',{deadline:Date.now()+5000})",h.ctx);await settle();
  requests[1].resolve({ok:true,text:'Translation P1',detected:'en'});await settle();
  assert.equal(requests[2]?.text,'P2');requests[2].resolve({ok:true,text:'Translation P2',detected:'en'});await settle();
  assert.deepEqual(h.spoken.map(s=>s.text),['Translation P1']);
  h.spoken[0].options.onEvent({type:'end'});await settle();
  assert.deepEqual(h.spoken.map(s=>s.text),['Translation P1','Translation P2']);
});

test('offscreen requests carry separate first-audio and completion deadlines',async()=>{
  const h=harness({voice:'google'});await tick();h.ctx.chrome.runtime.getContexts=async()=>[{}];
  vm.runInContext(active+"state.voice='google';speak('Fresh phrase',Date.now()+9000,'ru')",h.ctx);await settle();
  const speech=h.events.find(m=>m.type==='NT_OFF_SPEAK');assert.ok(Number.isFinite(speech.startBy));assert.ok(speech.startBy<speech.deadline);
});

for(const key of ['sourceLang','syncMode'])test('changing '+key+' clears retained complete translations and speech',async()=>{
  const h=harness({syncMode:'complete'});await tick();let release;
  h.ctx.ntTranslate=()=>new Promise(resolve=>{release=resolve;});
  vm.runInContext(active+"speak('First',Date.now()+5000);speak('Second',Date.now()+5000);handleCaption('Pending','en',{deadline:Date.now()+5000})",h.ctx);await settle();
  h.settings[key]=key==='syncMode'?'realtime':'de';await h.listeners.onChanged[0]({[key]:{newValue:h.settings[key]}},'local');await settle();
  assert.equal(vm.runInContext('voiceQueue.active || voiceQueue.pendingCount>0 || translations.size>0',h.ctx),false);
  release({ok:true,text:'Stale translation',detected:'en'});await settle();
  assert.equal(h.spoken.some(s=>s.text==='Stale translation'),false);
});

for(const action of ['stop()', 'handleMediaState({version:1,paused:true})', 'handleMediaState({version:1,paused:false})'])test('retained complete work is cancelled by '+action,async()=>{
  const h=harness({syncMode:'complete'});await tick();let release;
  h.ctx.ntTranslate=()=>new Promise(resolve=>{release=resolve;});
  vm.runInContext(active+"speak('First',Date.now()+5000);speak('Second',Date.now()+5000);handleCaption('Pending','en',{deadline:Date.now()+5000})",h.ctx);await settle();
  await vm.runInContext(action,h.ctx);await settle();
  assert.equal(vm.runInContext('voiceQueue.active || voiceQueue.pendingCount>0 || translations.size>0',h.ctx),false);
  release({ok:true,text:'Stale translation',detected:'en'});await settle();assert.equal(h.spoken.length,1);
});

test('Google-to-browser fallback preserves the original first-audio deadline',async()=>{
  const h=harness({voice:'google'});await tick();let now=Date.now();h.ctx.Date={now:()=>now};
  h.ctx.chrome.runtime.getContexts=async()=>[{}];
  vm.runInContext(active+"state.voice='google';speak('Original',Date.now()+9000,'ru')",h.ctx);await settle();
  const speech=h.events.find(m=>m.type==='NT_OFF_SPEAK');now=speech.startBy+1;
  h.listeners.onMessage[0]({type:'NT_OFF_VOICE_ERROR',sessionId:'A',voiceEpoch:speech.voiceEpoch,text:'Original',lang:{tts:'ru-RU'},deadline:speech.deadline,startBy:speech.startBy},{},()=>{});await settle();
  assert.equal(h.spoken.length,0);assert.equal(vm.runInContext('voiceQueue.active',h.ctx),false);
});

test('a stale duck failure cannot clear capture or duck the new session',async()=>{
  const h=harness();await tick();let reject;
  h.ctx.chrome.runtime.sendMessage=m=>m.type==='NT_OFF_DUCK'?new Promise((resolve,no)=>{reject=no;}):Promise.resolve({ok:true});
  vm.runInContext(active+'state.capture=true;setDuck(true)',h.ctx);await settle();
  vm.runInContext("sessionEpoch++;state={...state,sessionId:'B',tabId:2,capture:true}",h.ctx);
  reject(new Error('audio doc gone'));await new Promise(r=>setTimeout(r,80));await settle();
  assert.equal(vm.runInContext('state.capture',h.ctx),true);assert.equal(h.tabMessages.some(m=>m.type==='NT_C_DUCK'),false);
});

test('final duck retry exhaustion cannot mutate a replacement session',async()=>{
  const h=harness();await tick();let sends=0;
  h.ctx.chrome.runtime.sendMessage=async m=>{if(m.type!=='NT_OFF_DUCK')return {ok:true};if(++sends===3)vm.runInContext("sessionEpoch++;state={...state,sessionId:'B',tabId:2,capture:true}",h.ctx);return undefined;};
  vm.runInContext(active+'state.capture=true;setDuck(true)',h.ctx);await new Promise(r=>setTimeout(r,240));await settle();
  assert.equal(vm.runInContext('state.capture',h.ctx),true);assert.equal(h.tabMessages.some(m=>m.type==='NT_C_DUCK'),false);
});

test('a current duck failure falls back to page volume',async()=>{
  const h=harness();await tick();h.ctx.chrome.runtime.sendMessage=async m=>m.type==='NT_OFF_DUCK'?{error:'audio doc gone'}:{ok:true};
  vm.runInContext(active+'state.capture=true;setDuck(true)',h.ctx);await settle();
  assert.equal(vm.runInContext('state.capture',h.ctx),false);assert.ok(h.tabMessages.some(m=>m.type==='NT_C_DUCK'&&m.on));
});

test('a superseded duck operation cannot retry and change the current volume',async()=>{
  const h=harness();await tick();let onRequests=0;
  h.ctx.chrome.runtime.sendMessage=async m=>{if(m.type==='NT_OFF_DUCK'&&m.on){onRequests++;return undefined;}return {ok:true};};
  vm.runInContext(active+'state.capture=true;setDuck(true)',h.ctx);await settle();
  vm.runInContext('setDuck(false)',h.ctx);await new Promise(r=>setTimeout(r,240));await settle();
  assert.equal(onRequests,1);assert.equal(vm.runInContext('state.capture',h.ctx),true);
  assert.equal(h.tabMessages.some(m=>m.type==='NT_C_DUCK'),false);
});

test('browser-to-Google fallback cannot start after its first-audio freshness window',async()=>{
  const h=harness();await tick();let now=Date.now();h.ctx.Date={now:()=>now};
  h.ctx.chrome.runtime.getContexts=async()=>[{}];h.ctx.chrome.tts.speak=(text,options)=>{now+=2000;options.onEvent({type:'error'});};
  vm.runInContext(active+"speakBrowser('late',{tts:'ru-RU'},{voice:'browser'},Date.now()+9000,true,voiceEpoch,Date.now()+1000)",h.ctx);await settle();
  assert.equal(h.events.some(m=>m.type==='NT_OFF_SPEAK'),false);
});

test('browser engine start after freshness expires is stopped without ducking',async()=>{
  const h=harness();await tick();let now=Date.now();h.ctx.Date={now:()=>now};let stops=0;h.ctx.chrome.tts.stop=()=>stops++;
  h.ctx.chrome.tts.speak=(text,options)=>{h.spoken.push({text,options});};
  vm.runInContext(active+"speakBrowser('late',{tts:'ru-RU'},{voice:'browser'},Date.now()+9000,false,voiceEpoch,Date.now()+1000)",h.ctx);await settle();
  now+=2000;h.spoken[0].options.onEvent({type:'start'});await settle();
  assert.ok(stops>0);assert.equal(h.tabMessages.some(m=>m.type==='NT_C_DUCK'&&m.on),false);
});

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
  assert.equal(h.spoken[0].options.rate, 1);
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

test('a fresh realtime caption is not held behind a long tail beyond the catchup window', async () => {
  const clock = fakeClock(1000);
  const h = harness({}, clock.globals); await tick();
  vm.runInContext(active + "speak('This deliberately long sentence cannot finish anywhere near the source slot.',Date.now()+9000,'ru',{syncEnd:Date.now()+300})", h.ctx);
  await settle();
  assert.equal(h.spoken.length,1);
  await clock.advance(400);
  vm.runInContext("speak('Fresh caption',Date.now()+9000,'ru',{syncEnd:Date.now()+4000})",h.ctx);
  await settle();
  await clock.advance(250);await settle();
  assert.equal(h.spoken.at(-1).text,'Fresh caption','release a long overrun within350ms of its sync end when new speech waits');
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
  const clock = fakeClock(1000);
  const h = harness({}, clock.globals); await tick();
  let stops = 0; h.ctx.chrome.tts.stop = () => { stops++; };
  vm.runInContext(active + "speak('Короткая', Date.now()+9000, 'ru', {syncEnd: Date.now()-600})", h.ctx);
  await settle();
  const before = stops;
  await clock.advance(150);
  vm.runInContext("speak('Свежая фраза', Date.now()+9000, 'ru', {syncEnd: Date.now()+3000})", h.ctx);
  await settle();
  assert.equal(stops, before, 'not cut while its expected end is near');
  assert.equal(h.spoken.length, 1);
  // The engine never reports the end: after the grace it yields anyway.
  await clock.advance(900);
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
