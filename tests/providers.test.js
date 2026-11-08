const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('Yandex y0 API keys use Api-Key rather than IAM Bearer authentication', async () => {
  let authorization, form;
  const ctx = { self: {}, URLSearchParams, AbortSignal, fetch: async (url, options) => {
    authorization = options.headers.Authorization;
    form = options.body;
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) };
  }};
  vm.createContext(ctx); vm.runInContext(fs.readFileSync('src/offscreen/tts-providers.js', 'utf8'), ctx);
  await ctx.self.ntYandexTts('Привет', {gt:'ru'}, { yandexApiKey:'y0_example', yandexVoice:'marina', yandexFolderId:'user-folder' });
  assert.equal(authorization, 'Api-Key y0_example');
  assert.equal(form.has('folderId'), false, 'API-key requests must use the service account folder implicitly');
});

test('SpeechKit v1 does not offer voices that require v3', () => {
  const ctx = vm.createContext({self:{}});
  vm.runInContext(fs.readFileSync('src/offscreen/tts-providers.js', 'utf8'), ctx);
  assert.equal(ctx.self.ntYandexSupports({gt:'he'}), false);
  assert.ok(!ctx.self.NT_YANDEX_VOICES.ru.includes('dasha'));
});

test('speech chunks never exceed the provider limit, even with long words', () => {
  const ctx = vm.createContext({ self: {} });
  vm.runInContext(fs.readFileSync('src/offscreen/tts-providers.js', 'utf8'), ctx);
  const chunks = vm.runInContext("ntSplitText('a'.repeat(381), 190)", ctx);
  assert.ok(chunks.every(c => c.length <= 190));
  assert.equal(chunks.join(''), 'a'.repeat(381));
});

test('Google voice tries the second permitted host if the first is blocked', async () => {
  const urls=[];
  const ctx=vm.createContext({self:{},AbortSignal,AbortController,DOMException,setTimeout,clearTimeout,fetch:async url => {
    urls.push(url);
    if(url.startsWith('https://translate.google.com/'))throw new Error('Blocked');
    return {ok:true,arrayBuffer:async () => new ArrayBuffer(2)};
  }});
  vm.runInContext(fs.readFileSync('src/offscreen/tts-providers.js','utf8'),ctx);
  const buffers=await ctx.self.ntGoogleTts('Привет',{gt:'ru'},{decodeAudioData:async () => 'decoded'});
  assert.deepEqual(Array.from(buffers),['decoded']);
  assert.ok(urls[1].startsWith('https://translate.googleapis.com/'));
});

function ttsClock() {
  let now=0,id=0;
  const timers=new Map();
  const schedule=(fn,ms)=>{timers.set(++id,{at:now+ms,fn});return id;};
  const clear=id=>timers.delete(id);
  return {now:()=>now,globals:{setTimeout:schedule,clearTimeout:clear,
    AbortSignal:{any:signals=>AbortSignal.any(signals),timeout(ms){const c=new AbortController();schedule(()=>c.abort(new DOMException('Timeout','TimeoutError')),ms);return c.signal;}}},
    async advance(ms) {
      const until=now+ms;
      for (;;) {
        await new Promise(setImmediate);
        const next=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
        if (!next) break;
        now=next[1].at;timers.delete(next[0]);next[1].fn();
      }
      now=until;await new Promise(setImmediate);
    },
    after(ms,value,signal) {return new Promise((resolve,reject)=>{
      const timer=schedule(()=>resolve(value),ms);
      signal.addEventListener('abort',()=>{clear(timer);reject(signal.reason);},{once:true});
    });}
  };
}
function googleVoice(fetch,globals={}) {
  const ctx=vm.createContext({self:{},AbortSignal,AbortController,DOMException,setTimeout,clearTimeout,fetch,...globals});
  vm.runInContext(fs.readFileSync('src/offscreen/tts-providers.js','utf8'),ctx);
  return ctx.self.ntGoogleTts;
}
const audioResponse=value=>({ok:true,arrayBuffer:async()=>value});

test('ElevenLabs cancels and unlocks its response stream when playback throws', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    cancel() { cancelled = true; }
  });
  const ctx = vm.createContext({self:{}, AbortSignal, fetch:async () => new Response(body)});
  vm.runInContext(fs.readFileSync('src/offscreen/tts-providers.js', 'utf8'), ctx);
  const playbackError = new Error('Playback stopped');
  await assert.rejects(ctx.self.ntElevenLabsStream('Hello', {gt:'en'},
    {elevenApiKey:'test', elevenVoiceId:'test'}, () => { throw playbackError; }), error => error === playbackError);
  assert.equal(cancelled, true, 'failed playback must stop downloading the remaining speech');
  assert.equal(body.locked, false);
});

test('Google TTS keeps surrogate pairs intact at a long-word chunk boundary', async () => {
  const chunks = [];
  const text = 'a'.repeat(189) + '😀' + 'b'.repeat(10);
  const tts = googleVoice(async url => {
    chunks.push(new URL(url).searchParams.get('q'));
    return audioResponse('encoded');
  });
  const buffers = await tts(text, {gt:'en'}, {decodeAudioData:async () => 'decoded'});
  assert.equal(buffers.length, 2);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 190));
});

test('Google TTS does not decode a response body that finishes after cancellation', async () => {
  const controller = new AbortController();
  let finishBody, decodes = 0;
  const tts = googleVoice(async () => ({ok:true, arrayBuffer:() => new Promise(resolve => {finishBody = resolve;})}));
  const pending = tts('Привет', {gt:'ru'}, {decodeAudioData:async () => {decodes++; return 'decoded';}}, controller.signal);
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await new Promise(setImmediate);
  controller.abort();
  await rejected;
  finishBody(new ArrayBuffer(2));
  await new Promise(setImmediate);
  assert.equal(decodes, 0, 'cancelled captions must not consume the shared audio decoder');
});

test('Google TTS hedges a stalled host after 250ms instead of waiting for its timeout',async()=>{
  const clock=ttsClock(),attempts=[];
  const tts=googleVoice((url,{signal})=>{
    attempts.push({url,signal,at:clock.now()});
    return clock.after(url.includes('googleapis')?50:1600,audioResponse('audio'),signal);
  },clock.globals);
  let result;
  const pending=tts('Привет',{gt:'ru'},{decodeAudioData:async b=>b}).then(r=>{result=r;});
  await clock.advance(249); assert.equal(attempts.length,1);
  await clock.advance(51);
  assert.equal(attempts.length,2);
  assert.deepEqual(attempts.map(a=>a.at),[0,250]);
  assert.deepEqual(Array.from(result||[]),['audio']);
  assert.equal(attempts[0].signal.aborted,true);
  await pending;
});

test('a fast Google TTS response avoids an unnecessary second request',async()=>{
  const clock=ttsClock(),urls=[];
  const tts=googleVoice((url,{signal})=>{urls.push(url);return clock.after(100,audioResponse('audio'),signal);},clock.globals);
  const pending=tts('Привет',{gt:'ru'},{decodeAudioData:async b=>b});
  await clock.advance(100);assert.deepEqual(Array.from(await pending),['audio']);
  await clock.advance(2500);assert.equal(urls.length,1);
});

test('Google TTS rejects promptly on cancellation even if the transport ignores abort',async()=>{
  const clock=ttsClock(),controller=new AbortController(),urls=[];
  const tts=googleVoice(url=>{urls.push(url);return new Promise(()=>{});},clock.globals);
  let error;
  tts('Привет',{gt:'ru'},{},controller.signal).catch(e=>{error=e;});
  controller.abort();await clock.advance(0);
  assert.equal(error?.name,'AbortError');
  await clock.advance(2500);assert.equal(urls.length,1);
});

test('Google TTS bounds both stalled hosts even when fetch ignores cancellation',async()=>{
  const clock=ttsClock(),signals=[];
  const tts=googleVoice((url,{signal})=>{signals.push(signal);return new Promise(()=>{});},clock.globals);
  let error;
  tts('Привет',{gt:'ru'},{}).catch(e=>{error=e;});
  await clock.advance(2100);
  assert.ok(error,'TTS must stop waiting within 2100ms');
  assert.equal(signals.length,2);assert.ok(signals.every(s=>s.aborted));
});

test('Google TTS starts the first decoded chunk without waiting for a later chunk',async()=>{
  const clock=ttsClock(),played=[];
  let release;
  const tts=googleVoice(url=>{
    const text=new URL(url).searchParams.get('q');
    return text.startsWith('Первый')?Promise.resolve(audioResponse('first')):new Promise(resolve=>{release=()=>resolve(audioResponse('second'));});
  },clock.globals);
  let complete=false;
  const text='Первый '.repeat(24)+'. '+'Второй '.repeat(10)+'.';
  const pending=tts(text,{gt:'ru'},{decodeAudioData:async b=>b},undefined,b=>played.push(b)).then(r=>{complete=true;return r;});
  await clock.advance(0);
  assert.deepEqual(played,['first']);assert.equal(complete,false);
  release();await clock.advance(0);
  assert.deepEqual(played,['first','second']);assert.equal((await pending).length,2);
});

test('Google TTS emits concurrently loaded chunks in caption order',async()=>{
  const clock=ttsClock(),played=[];
  const tts=googleVoice((url,{signal})=>{
    const first=new URL(url).searchParams.get('q').startsWith('Первый');
    return clock.after(first?100:20,audioResponse(first?'first':'second'),signal);
  },clock.globals);
  const pending=tts('Первый '.repeat(24)+'. '+'Второй '.repeat(10)+'.',{gt:'ru'},{decodeAudioData:async b=>b},undefined,b=>played.push(b));
  await clock.advance(20);assert.deepEqual(played,[]);
  await clock.advance(80);await pending;assert.deepEqual(played,['first','second']);
});

test('an undecodable Google response falls back instead of winning the TTS race',async()=>{
  const tts=googleVoice(async url=>audioResponse(url.includes('googleapis')?'valid':'invalid'));
  const buffers=await tts('Привет',{gt:'ru'},{decodeAudioData:async b=>{if(b==='invalid')throw new Error('Bad MP3');return b;}});
  assert.deepEqual(Array.from(buffers),['valid']);
});

test('audio decoded after caller cancellation is never delivered to playback',async()=>{
  const controller=new AbortController(),played=[];
  let release;
  const tts=googleVoice(async()=>audioResponse('encoded'));
  const pending=tts('Привет',{gt:'ru'},{decodeAudioData:()=>new Promise(resolve=>{release=resolve;})},controller.signal,b=>played.push(b));
  const rejected=assert.rejects(pending,e=>e.name==='AbortError');
  await new Promise(setImmediate);
  controller.abort();await rejected;
  release('decoded late');await new Promise(setImmediate);
  assert.deepEqual(played,[]);
});

test('a terminal later-chunk failure cancels stalled earlier chunks immediately',async()=>{
  const clock=ttsClock(),stalled=[];
  const tts=googleVoice((url,{signal})=>{
    if(new URL(url).searchParams.get('q').startsWith('Первый')){
      stalled.push(signal);return new Promise(()=>{});
    }
    return Promise.resolve({ok:false,status:503});
  },clock.globals);
  let error;
  tts('Первый '.repeat(24)+'. '+'Второй '.repeat(10)+'.',{gt:'ru'},{}).catch(e=>{error=e;});
  await clock.advance(0);
  assert.ok(error,'a known failed phrase must not wait for the first chunk timeout');
  assert.ok(stalled.every(signal=>signal.aborted));
});

test('prepared Google audio is reused without another request or decode',async()=>{
  let calls=0,decodes=0;
  const audio={length:100,numberOfChannels:1};
  const context={decodeAudioData:async()=>{decodes++;return audio;}};
  const tts=googleVoice(async()=>{calls++;return audioResponse('encoded');});
  await tts('Заранее',{gt:'ru'},context);
  const played=[];
  await tts('Заранее',{gt:'ru'},context,undefined,b=>played.push(b));
  assert.equal(calls,1);assert.equal(decodes,1);assert.equal(played[0],audio);
});

test('prepared audio is isolated by language and AudioContext',async()=>{
  let calls=0;
  const tts=googleVoice(async()=>{calls++;return audioResponse('encoded');});
  const first={decodeAudioData:async()=>({length:100,numberOfChannels:1})};
  const second={...first};
  await tts('test',{gt:'ru'},first);
  await tts('test',{gt:'en'},first);
  await tts('test',{gt:'ru'},second);
  assert.equal(calls,3);
});

test('prepared Google audio has a bounded cache and cannot serve cancelled speech',async()=>{
  let calls=0;
  const tts=googleVoice(async()=>{calls++;return audioResponse('encoded');});
  const context={decodeAudioData:async()=>({length:100,numberOfChannels:1})};
  for(let i=0;i<25;i++)await tts('text '+i,{gt:'ru'},context);
  await tts('text 24',{gt:'ru'},context);assert.equal(calls,25);
  await tts('text 0',{gt:'ru'},context);
  assert.equal(calls,26);
  const controller=new AbortController();controller.abort();
  await assert.rejects(tts('text 0',{gt:'ru'},context,controller.signal),e=>e.name==='AbortError');
});

test('prepared audio is also bounded by decoded memory and expires',async()=>{
  let calls=0,now=0;
  const tts=googleVoice(async()=>{calls++;return audioResponse('encoded');},{Date:{now:()=>now}});
  const context={decodeAudioData:async()=>({length:2*1024*1024,numberOfChannels:1})};
  await tts('large first',{gt:'ru'},context);
  await tts('large second',{gt:'ru'},context);
  await tts('large first',{gt:'ru'},context);
  assert.equal(calls,3,'two 8MiB buffers must not exceed the 12MiB limit');
  now=120001;
  await tts('large first',{gt:'ru'},context);
  assert.equal(calls,4);
});

test('Google waits for asynchronous playback before delivering its next chunk',async()=>{
  const tts=googleVoice(async()=>audioResponse('audio'));
  let release,complete=false;const delivered=[];
  const pending=tts('x'.repeat(200),{gt:'en'},{decodeAudioData:async()=>({duration:1})},undefined,
    async buffer=>{delivered.push(buffer);if(delivered.length===1)await new Promise(resolve=>{release=resolve;});}).then(()=>{complete=true;});
  await new Promise(setImmediate);
  assert.equal(delivered.length,1);assert.equal(complete,false);
  release();await pending;assert.equal(delivered.length,2);assert.equal(complete,true);
});
