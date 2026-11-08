const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('offscreen document rejects speech for a different session', () => {
  let receive;
  const ctx = vm.createContext({chrome:{runtime:{onMessage:{addListener:fn => {receive = fn;}}}}, speechCalls:[]});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'), ctx);
  vm.runInContext("sessionId = 'B'; speakEnqueue = text => speechCalls.push(text)", ctx);
  receive({target:'offscreen',type:'NT_OFF_SPEAK',sessionId:'A',text:'old'}, {}, () => {});
  assert.equal(ctx.speechCalls.length, 0);
});

test('a media pause aborts voice requests and clears all scheduled sound', () => {
  let receive, cleared=0;
  const abort=new AbortController();
  const ctx=vm.createContext({clearTimeout,chrome:{runtime:{onMessage:{addListener:fn => {receive=fn;}},sendMessage:async()=>{}}},controller:abort,clear:() => {cleared++;}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A'; speech.abort=controller; speech.busy=true; speech.queue.push({text:'old'}); player={clear};",ctx);
  receive({target:'offscreen',type:'NT_OFF_MEDIA',sessionId:'A',mediaVersion:1,paused:true},{},() => {});
  assert.equal(abort.signal.aborted,true);
  assert.equal(vm.runInContext('speech.queue.length',ctx),0);
  assert.equal(cleared,1);
});

test('old voice results with the right session but wrong media version are ignored', () => {
  let receive;
  const ctx=vm.createContext({chrome:{runtime:{onMessage:{addListener:fn => {receive=fn;}}}},speechCalls:[]});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A'; globalThis.testSetVersion = () => { mediaVersion=2; }; speakEnqueue=text => speechCalls.push(text);",ctx);
  ctx.testSetVersion();
  receive({target:'offscreen',type:'NT_OFF_SPEAK',sessionId:'A',mediaVersion:1,text:'old'},{},() => {});
  assert.equal(ctx.speechCalls.length,0);
});

test('pausing Gemini restores the original monitor after external browser ducking', () => {
  let receive;
  const values=[];
  const ctx=vm.createContext({clearTimeout,chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}},sendMessage:async()=>{}}},
    gain:{gain:{setTargetAtTime:value=>values.push(value)}}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A';source='gemini';settings={voice:'browser',originalVolume:0.25};playCtx={currentTime:0};monitorGain=gain;externalDuck=true;connectGemini=()=>{};updateDuck();",ctx);
  receive({target:'offscreen',type:'NT_OFF_MEDIA',sessionId:'A',mediaVersion:1,paused:true},{},()=>{});
  assert.equal(values[0],0.25);
  assert.equal(values.at(-1),1);
});

test('a failed later chunk cannot replay the already spoken prefix using another voice',async()=>{
  const messages=[],played=[];
  const ctx=vm.createContext({Date,setTimeout,clearTimeout,AbortController,
    console:{warn(){}},chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async msg=>messages.push(msg)}},
    ntGoogleTts:async(text,lang,audio,signal,onBuffer)=>{onBuffer('first');throw new Error('Tail unavailable');},
    audioPlayer:{clear(){},whenIdle:async()=>{},enqueueBuffer:buffer=>played.push(buffer)}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A';playCtx={currentTime:0};player=audioPlayer;speakEnqueue('long phrase',{gt:'ru'},{voice:'google'});",ctx);
  await new Promise(setImmediate);
  assert.deepEqual(played,['first']);
  assert.equal(messages.some(msg=>msg.type==='NT_OFF_VOICE_ERROR'),false);
  assert.ok(messages.some(msg=>msg.type==='NT_OFF_STATUS'&&msg.code==='voice_error'));
  vm.runInContext('clearSpeech()',ctx);
});

test('future audio preparation has no playback callback and pause cancels it',async()=>{
  let receive,signal,finish,calls=0;
  const ctx=vm.createContext({clearTimeout,AbortController,
    chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}},sendMessage:async()=>{}}},
    ntGoogleTts:(text,lang,audio,s,onBuffer)=>{calls++;signal=s;assert.equal(onBuffer,undefined);return new Promise(resolve=>{finish=resolve;});}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A';source='captions';settings={voice:'google',targetLang:'ru'};ensurePlayback=()=>{}",ctx);
  receive({target:'offscreen',type:'NT_OFF_PREFETCH',sessionId:'A',mediaVersion:0,text:'future',lang:{gt:'ru'},preparationKey:JSON.stringify(['google','ru',''])},{},()=>{});
  assert.equal(calls,1);
  receive({target:'offscreen',type:'NT_OFF_MEDIA',sessionId:'A',mediaVersion:1,paused:true},{},()=>{});
  assert.equal(signal.aborted,true);
  finish([]);await new Promise(setImmediate);
  assert.equal(vm.runInContext('speech.queue.length',ctx),0);
  receive({target:'offscreen',type:'NT_OFF_PREFETCH',sessionId:'A',mediaVersion:1,text:'late',lang:{gt:'ru'},preparationKey:JSON.stringify(['google','ru',''])},{},()=>{});
  assert.equal(calls,1);
});

test('Google fallback speech cannot replace the selected browser configuration',()=>{
  let receive;
  const ctx=vm.createContext({chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}}}}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A';settings={voice:'browser',dubVolume:1};speakEnqueue=()=>{}",ctx);
  receive({type:'NT_OFF_SPEAK',target:'offscreen',sessionId:'A',mediaVersion:0,text:'fallback',settings:{voice:'google',dubVolume:.5},fallback:true},{},()=>{});
  assert.equal(vm.runInContext('settings.voice',ctx),'browser');
  assert.equal(vm.runInContext('settings.dubVolume',ctx),1);
});

const shared={...require('../src/shared/speech-timing.js'),...require('../src/shared/speakers.js')};

function elevenOffscreenHarness() {
  let receive;
  const calls = [], shapes = [];
  const ctx = vm.createContext({ ...shared, Date, Math, setTimeout, clearTimeout, AbortController,
    console: { warn() {} }, chrome: { runtime: { onMessage: { addListener(fn) { receive = fn; } }, sendMessage: async () => {} } },
    ntElevenLabsStream: async (text, lang, settings, onPcm) => {
      calls.push({ text, settings }); onPcm(new ArrayBuffer(24000), 24000);
    },
    audioPlayer: { clear() {}, whenIdle: async () => {}, get nextStartWall() { return Date.now(); },
      enqueuePcm16(pcm, rate, shape) { shapes.push(shape); return true; } },
    configuration: { voice: 'elevenlabs', targetLang: 'ru', elevenVoiceId: 'narrator',
      elevenModel: 'eleven_flash_v2_5', elevenStability: 0.5, elevenSimilarity: 0.75, elevenContinuity: true }
  });
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js', 'utf8'), ctx);
  vm.runInContext("sessionId='eleven-session';settings=configuration;playCtx={currentTime:0};player=audioPlayer", ctx);
  const send = msg => receive({ target: 'offscreen', sessionId: 'eleven-session', mediaVersion: 0, ...msg }, {}, () => {});
  return { ctx, calls, shapes, send,
    async play(text, patch = {}, voice = {}, timing = {}) {
      send({ type: 'NT_OFF_SPEAK', text, lang: { gt: 'ru' }, settings: { ...ctx.configuration, ...patch },
        deadline: Date.now() + 10000, voice, ...timing });
      await new Promise(setImmediate);
    },
    close() { vm.runInContext('clearSpeech()', ctx); }
  };
}

test('ElevenLabs conditions the next phrase on the completed phrase without repeating it', async t => {
  const h = elevenOffscreenHarness(); t.after(() => h.close());
  await h.play('Первое предложение.');
  h.send({ type: 'NT_OFF_CLEAR', keepElevenContext: true });
  await h.play('Его продолжение.');
  assert.equal(h.calls[1].settings.elevenPreviousText, 'Первое предложение.');
  assert.equal(h.calls[1].text, 'Его продолжение.');
});

test('ElevenLabs does not carry narrator context across another speaker, model or voice', async t => {
  const h = elevenOffscreenHarness(); t.after(() => h.close());
  await h.play('Говорит первый.', {}, { speakerKey: 'one' });
  await h.play('Говорит второй.', {}, { speakerKey: 'two' });
  assert.ok(!h.calls[1].settings.elevenPreviousText);
  await h.play('Другой тембр.', { elevenVoiceId: 'another-voice' }, { speakerKey: 'two' });
  assert.ok(!h.calls[2].settings.elevenPreviousText);
  await h.play('Другая модель.', { elevenModel: 'eleven_v4' }, { speakerKey: 'two' });
  assert.ok(!h.calls[3].settings.elevenPreviousText);
});

test('pausing or clearing speech resets ElevenLabs continuity before playback resumes', async t => {
  const h = elevenOffscreenHarness(); t.after(() => h.close());
  await h.play('До остановки.');
  h.send({ type: 'NT_OFF_CLEAR' });
  await h.play('После остановки.');
  assert.ok(!h.calls[1].settings.elevenPreviousText);
  h.send({ type: 'NT_OFF_MEDIA', mediaVersion: 1, paused: true });
  h.send({ type: 'NT_OFF_MEDIA', mediaVersion: 2, paused: false });
  await h.play('После паузы.', {}, {}, { mediaVersion: 2 });
  assert.ok(!h.calls[2].settings.elevenPreviousText);
});

test('ElevenLabs v4 keeps local tempo control because its API does not accept speed', async t => {
  const h = elevenOffscreenHarness(); t.after(() => h.close());
  await h.play('Это достаточно длинное предложение для подгонки темпа.',
    { elevenModel: 'eleven_v4_turbo' }, {}, { syncEnd: Date.now() + 1000, maxTempo: 1.6 });
  assert.ok(h.shapes[0]?.tempo > 1, 'the new model must still catch up with the video');
  assert.ok(h.shapes[0].tempo <= 1.6);
});

test('failed ElevenLabs PCM buffered before the first block cannot count as a spoken dialogue part', async t => {
  const h = elevenOffscreenHarness(), messages = []; t.after(() => h.close());
  h.ctx.chrome.runtime.sendMessage = async msg => { messages.push(msg); };
  h.ctx.audioPlayer.enqueuePcm16 = () => false; // fewer than 120ms, nothing scheduled
  h.ctx.ntElevenLabsStream = async (text, lang, settings, onPcm) => {
    onPcm(new ArrayBuffer(4800), 24000);
    throw new Error('Stream failed before first complete block');
  };
  await h.play('Первая часть диалога.');
  assert.equal(messages.some(msg => msg.type === 'NT_OFF_SPEECH_END'), false,
    'a later speaker must not follow a part that never sounded');
  assert.ok(messages.some(msg => msg.type === 'NT_OFF_VOICE_DONE'), 'the failed queue owner must still finish');
});

test('speaker query returns the pitch cluster of the requested window',()=>{
  let receive;
  const ctx=vm.createContext({...shared,Date,Math,chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}}}}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  const now=Date.now();
  vm.runInContext("sessionId='A';analyser={};",ctx);
  for(let t=now-2000;t<now-1000;t+=20)vm.runInContext(`speakerFrames.push({wall:${t},f0:110,rms:0.1})`,ctx);
  for(let t=now-900;t<now;t+=20)vm.runInContext(`speakerFrames.push({wall:${t},f0:230,rms:0.1})`,ctx);
  const ask=(from,to,previous)=>{let out;receive({target:'offscreen',type:'NT_OFF_SPEAKER',sessionId:'A',from,to,previous},{},r=>{out=r;});return out.speaker;};
  const low=ask(now-2000,now-1000,null),high=ask(now-900,now,low.cluster);
  assert.equal(low.pitchClass,'low');assert.equal(high.pitchClass,'high');
  assert.notEqual(low.cluster,high.cluster);
  assert.equal(ask(now+5000,now+6000,null),null);
});

test('a failed free-mode capture releases the tab instead of leaving it muted',async()=>{
  let receive,stopped=0;
  const track={stop:()=>{stopped++;}};
  const ctx=vm.createContext({...shared,Date,Math,console:{warn(){}},
    chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}},sendMessage:async()=>{}}},
    navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track]})}},
    AudioContext:class{constructor(){this.state='running';this.currentTime=0;this.destination={};
      this.audioWorklet={addModule:async()=>{throw new Error('worklet blocked');}};}
      createGain(){return {gain:{value:1,setTargetAtTime(){}},connect(){},disconnect(){}};}
      createMediaStreamSource(){return {connect(){},disconnect(){}};}
      close(){return Promise.resolve();} resume(){return Promise.resolve();}},
    NtAudioPlayer:class{clear(){}destroy(){}}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  const reply=await new Promise(resolve=>{
    const sync=receive({target:'offscreen',type:'NT_OFF_PREPARE',sessionId:'A',settings:{voice:'browser',dubVolume:1,originalVolume:.25},streamId:'s1'},{},resolve);
    assert.equal(sync,true);
  });
  assert.equal(reply.ok,true);assert.equal(reply.capture,false);
  assert.match(reply.captureError,/speakerAnalysisUnavailable/);
  assert.equal(stopped,1);
  assert.equal(vm.runInContext('stream===null && monitorSrc===null && capCtx===null',ctx),true);
});

test('Google voice is sped up from its exact decoded length to fit the sync window',async()=>{
  const shapes=[];
  const ctx=vm.createContext({...shared,Date,Math,setTimeout,clearTimeout,AbortController,console:{warn(){}},
    chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async()=>{}}},
    ntGoogleTts:async(text,lang,audio,signal,onBuffer)=>{onBuffer({duration:3},{chars:40,restChars:0});},
    audioPlayer:{clear(){},whenIdle:async()=>{},get nextStartWall(){return Date.now();},enqueueBuffer:(buffer,shape)=>shapes.push(shape)}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A';playCtx={currentTime:0};player=audioPlayer;",ctx);
  ctx.syncEnd=Date.now()+2000;
  vm.runInContext("speakEnqueue('text',{gt:'ru'},{voice:'google'},Date.now()+9000,false,0,{syncEnd,maxTempo:1.6,voice:{pitch:0.8}})",ctx);
  await new Promise(setImmediate);await new Promise(setImmediate);
  assert.ok(shapes[0].tempo>1.4&&shapes[0].tempo<=1.6,String(shapes[0].tempo));
  assert.equal(shapes[0].pitch,0.8);
  vm.runInContext('clearSpeech()',ctx);
});

test('a same-version media resync keeps speaker history; a seek clears it',()=>{
  let receive;
  const ctx=vm.createContext({...shared,Date,Math,clearTimeout,chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}},sendMessage:async()=>{}}}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A';speakerFrames.push({wall:1,f0:120,rms:.1});",ctx);
  receive({target:'offscreen',type:'NT_OFF_MEDIA',sessionId:'A',mediaVersion:0,paused:false},{},()=>{});
  assert.equal(vm.runInContext('speakerFrames.length',ctx),1);
  receive({target:'offscreen',type:'NT_OFF_MEDIA',sessionId:'A',mediaVersion:1,paused:false},{},()=>{});
  assert.equal(vm.runInContext('speakerFrames.length',ctx),0);
});

test('Yandex speed requested from SpeechKit and the exact correction never exceed maxTempo together',async()=>{
  const shapes=[];let requested;
  const ctx=vm.createContext({...shared,Date,Math,setTimeout,clearTimeout,AbortController,console:{warn(){}},
    chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async()=>{}}},
    ntYandexSupports:()=>true,
    ntYandexTts:async(text,lang,s)=>{requested=Number(s.yandexSpeed);return new ArrayBuffer(48000*2*3);},
    audioPlayer:{clear(){},whenIdle:async()=>{},get nextStartWall(){return Date.now();},get endWall(){return Date.now();},
      enqueuePcm16:(pcm,rate,shape)=>shapes.push(shape)}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A';playCtx={currentTime:0};player=audioPlayer;",ctx);
  ctx.syncEnd=Date.now()+1000;
  vm.runInContext("speakEnqueue('Длинная фраза для проверки предела скорости озвучки',{gt:'ru'},{voice:'yandex',yandexSpeed:1},Date.now()+9000,false,0,{syncEnd,maxTempo:1.6,voice:{pitch:1}})",ctx);
  await new Promise(setImmediate);await new Promise(setImmediate);
  assert.ok(requested*shapes[0].tempo<=1.6+1e-9,`${requested} x ${shapes[0].tempo}`);
  vm.runInContext('clearSpeech()',ctx);
});

test('late Google response is expired without starting audio or browser fallback', async()=>{
  let receive,deliver; const messages=[],played=[];
  const ctx=vm.createContext({...shared,Date,Math,setTimeout,clearTimeout,AbortController,console:{warn(){}},
    chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}},sendMessage:async msg=>messages.push(msg)}},
    ntGoogleTts:async(text,lang,audio,signal,onBuffer)=>{await new Promise(resolve=>{deliver=resolve;});await onBuffer({duration:1});},
    audioPlayer:{clear(){},whenIdle:async()=>{},get nextStartWall(){return Date.now()+60;},enqueueBuffer:()=>{played.push(1);return true;}}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A';playCtx={currentTime:0};player=audioPlayer",ctx);
  receive({target:'offscreen',type:'NT_OFF_SPEAK',sessionId:'A',text:'late',lang:{gt:'ru'},settings:{voice:'google'},startBy:Date.now()+20,deadline:Date.now()+3000},{},()=>{});
  await new Promise(resolve=>setTimeout(resolve,40));
  deliver();await new Promise(setImmediate);
  assert.equal(played.length,0);
  assert.equal(messages.some(m=>m.type==='NT_OFF_VOICE_ERROR'),false);
  assert.equal(messages.some(m=>m.type==='NT_OFF_VOICE_DONE'),true);
  vm.runInContext('clearSpeech()',ctx);
});

for (const voice of ['google','yandex','elevenlabs']) {
  test(`${voice} rejects first response past startBy even when its expiry timer is throttled`,async()=>{
    let receive,deliver,now=10000;const played=[],messages=[];
    const wait=()=>new Promise(resolve=>{deliver=resolve;});
    const ctx=vm.createContext({...shared,Date:{now:()=>now},Math,AbortController,setTimeout:()=>1,clearTimeout(){},console:{warn(){}},
      chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}},sendMessage:async msg=>messages.push(msg)}},
      ntGoogleTts:async(text,lang,audio,signal,callback)=>{await wait();await callback({duration:1});},
      ntYandexSupports:()=>true,ntYandexTts:async()=>{await wait();return new ArrayBuffer(96000);},
      ntElevenLabsStream:async(text,lang,s,callback)=>{await wait();await callback(new ArrayBuffer(48000),24000);},
      audioPlayer:{clear(){},whenIdle:async()=>{},get nextStartWall(){return now+60;},
        enqueueBuffer(){played.push(1);return true;},enqueuePcm16(){played.push(1);return true;}}});
    vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
    vm.runInContext("sessionId='A';playCtx={currentTime:0};player=audioPlayer",ctx);
    receive({target:'offscreen',type:'NT_OFF_SPEAK',sessionId:'A',text:'late',lang:{gt:'ru'},settings:{voice},startBy:10080,deadline:14000},{},()=>{});
    now=10100;deliver();await new Promise(setImmediate);
    assert.equal(played.length,0);assert.equal(messages.some(m=>m.type==='NT_OFF_VOICE_ERROR'),false);
    assert.equal(messages.some(m=>m.type==='NT_OFF_VOICE_DONE'),true);
  });
}

test('Google tail remains valid after first-start expiry and fallback retains startBy on genuine failure',async()=>{
  let receive,tail,now=10000;const played=[],messages=[],timers=[];
  const ctx=vm.createContext({...shared,Date:{now:()=>now},Math,AbortController,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){},console:{warn(){}},
    chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}},sendMessage:async msg=>messages.push(msg)}},
    ntGoogleTts:async(text,lang,audio,signal,callback)=>{
      if(text==='fail')throw new Error('network failure');
      await callback({duration:.2});await new Promise(resolve=>{tail=resolve;});await callback({duration:.2});
    },audioPlayer:{clear(){this.started=false;},whenIdle:async()=>{},get nextStartWall(){return now+60;},
      enqueueBuffer(){this.started=true;played.push(1);return true;}}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A';playCtx={currentTime:0};player=audioPlayer",ctx);
  const speak=text=>receive({target:'offscreen',type:'NT_OFF_SPEAK',sessionId:'A',text,lang:{gt:'ru'},settings:{voice:'google'},startBy:now+200,deadline:now+4000},{},()=>{});
  speak('tail');await new Promise(setImmediate);now+=250;
  timers.find(t=>t.ms===200).fn();tail();await new Promise(setImmediate);
  assert.equal(played.length,2);assert.equal(messages.some(m=>m.type==='NT_OFF_VOICE_ERROR'),false);
  speak('fail');await new Promise(setImmediate);
  assert.equal(messages.find(m=>m.type==='NT_OFF_VOICE_ERROR').startBy,now+200);
});

test('expired SPEAK is explicitly rejected so the caller releases its owner immediately',()=>{
  let receive,response;let providerCalls=0;const messages=[];
  const ctx=vm.createContext({Date:{now:()=>10000},
    chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}},sendMessage:async msg=>messages.push(msg)}},
    ntGoogleTts:()=>{providerCalls++;}});
  vm.runInContext(fs.readFileSync('src/offscreen/offscreen.js','utf8'),ctx);
  vm.runInContext("sessionId='A';voiceEpoch=7",ctx);
  receive({target:'offscreen',type:'NT_OFF_SPEAK',sessionId:'A',mediaVersion:0,voiceEpoch:7,
    text:'expired in transit',lang:{gt:'en'},settings:{voice:'google'},startBy:9999,deadline:20000},{},reply=>{response=reply;});
  assert.equal(response.ok,true);
  assert.equal(response.ignored || response.cancelled,true,'existing caller completion branch must recognize rejection');
  assert.equal(providerCalls,0);assert.equal(messages.length,0);
  assert.equal(vm.runInContext('speech.busy || speech.queue.length > 0 || speech.pendingTimer !== 0',ctx),false);
});
