const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {NtSegmenter} = require('../src/content/segmenter.js');
const shared = {...require('../src/shared/speech-timing.js'), ...require('../src/shared/speakers.js')};

test('YouTube navigation cannot enable captions after Stop', () => {
  let pressed = 'true', nextTimer = 0;
  const timers = new Map();
  const button = {offsetParent:{}, getAttribute: () => pressed, click: () => {pressed = pressed === 'true' ? 'false' : 'true';}};
  const listener = {addListener() {}};
  const ctx = vm.createContext({
    window: {addEventListener() {}, removeEventListener() {}},
    location: {hostname:'www.youtube.com'}, document: {addEventListener() {}, querySelector: () => button, querySelectorAll: () => []},
    NtSegmenter,...shared, Date, setInterval: () => 1, clearInterval() {},
    setTimeout: fn => {timers.set(++nextTimer, fn); return nextTimer;}, clearTimeout: id => timers.delete(id),
    chrome:{runtime:{onMessage:listener,sendMessage:async () => {}},storage:{onChanged:listener}}
  });
  // Expose the closure only inside the VM; shipped source has no testing hooks.
  const source = fs.readFileSync('src/content/content.js','utf8').replace(/\}\)\(\);\s*$/, 'globalThis.testReader = reader; globalThis.activate = value => { active = value; }; })();');
  vm.runInContext(source, ctx);
  ctx.activate(true); ctx.testReader.start();
  pressed = 'false'; ctx.testReader.onNav();
  ctx.activate(false); ctx.testReader.stop();
  for (const callback of timers.values()) callback();
  assert.equal(pressed, 'false');
});

test('pause event immediately notifies the worker and resets pending captions', () => {
  const events=new Map(), messages=[];
  const video={paused:false,seeking:false,ended:false,playbackRate:1,currentTime:1,getBoundingClientRect:() => ({width:800,height:450})};
  const listener={addListener(){}};
  const ctx=vm.createContext({window:{addEventListener(){},removeEventListener(){}},location:{hostname:'video.test'},Date,
    document:{querySelectorAll:() => [video],querySelector:() => video,addEventListener:(event,fn) => events.set(event,fn),removeEventListener(){}},
    NtSegmenter,...shared,setTimeout:() => 1,clearTimeout(){},setInterval:() => 1,clearInterval(){},
    chrome:{runtime:{onMessage:listener,sendMessage:async msg => {messages.push(msg);}},storage:{onChanged:listener}}
  });
  const source=fs.readFileSync('src/content/content.js','utf8').replace(/\}\)\(\);\s*$/,
    "active=true; sessionId='A'; reader.seg=new NtSegmenter(() => {}); reader.seg.pending='old'; overlay.show=() => {}; globalThis.playbackTest=playback; globalThis.readerTest=reader; })();");
  vm.runInContext(source,ctx);
  ctx.playbackTest.start();
  video.paused=true;
  events.get('pause')({target:video,type:'pause'});
  assert.equal(messages.at(-1).type,'NT_MEDIA_STATE');
  assert.equal(messages.at(-1).paused,true);
  assert.equal(ctx.readerTest.seg.pending,'');
});

test('buffering stays paused across polls until the player emits playing', () => {
  const events=new Map(),messages=[];
  const video={paused:false,seeking:false,ended:false,readyState:2,playbackRate:1,currentTime:1,getBoundingClientRect:()=>({width:800,height:450})};
  const listener={addListener(){}};
  const ctx=vm.createContext({window:{addEventListener(){},removeEventListener(){}},location:{hostname:'video.test'},Date,
    document:{querySelectorAll:()=>[video],querySelector:()=>video,addEventListener:(event,fn)=>events.set(event,fn),removeEventListener(){}},
    NtSegmenter,...shared,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    chrome:{runtime:{onMessage:listener,sendMessage:async msg=>{messages.push(msg);}},storage:{onChanged:listener}}});
  const source=fs.readFileSync('src/content/content.js','utf8').replace(/\}\)\(\);\s*$/,
    "active=true;sessionId='A';reader.seg=new NtSegmenter(()=>{});overlay.show=()=>{};globalThis.playbackTest=playback;})();");
  vm.runInContext(source,ctx);
  ctx.playbackTest.start();
  events.get('waiting')({target:video,type:'waiting'});
  ctx.playbackTest.sync();
  assert.equal(ctx.playbackTest.paused,true);
  assert.equal(messages.at(-1).paused,true);
  video.readyState=4;
  events.get('playing')({target:video,type:'playing'});
  assert.equal(ctx.playbackTest.paused,false);
});

test('a long cue keeps its overlay visible until its actual media deadline', () => {
  const waits=[];
  const listener={addListener(){}};
  const ctx=vm.createContext({window:{},location:{hostname:'video.test'},Date,
    document:{addEventListener(){}},NtSegmenter,...shared,
    setTimeout:(fn,ms)=>{waits.push(ms);return 1;},clearTimeout(){},
    chrome:{runtime:{onMessage:listener},storage:{onChanged:listener}}});
  const source=fs.readFileSync('src/content/content.js','utf8').replace(/\}\)\(\);\s*$/,'globalThis.testOverlay=overlay;})();');
  vm.runInContext(source,ctx);
  const el=()=>({textContent:'',classList:{toggle(){},add(){}}});
  Object.assign(ctx.testOverlay,{host:{},line:el(),orig:el(),subs:el()});
  ctx.testOverlay.show('Long subtitle','Original',true,Date.now()+12000);
  assert.ok(waits.at(-1)>11000);
});

test('native track lookahead prepares one upcoming cue after emitting the current cue',()=>{
  const messages=[];
  const current={startTime:0,endTime:2,text:'Current.'};
  const future={startTime:3,endTime:5,text:'Future.'};
  const track={kind:'subtitles',language:'en',mode:'hidden',cues:[current,future],activeCues:[current]};
  const video={currentTime:1,paused:false,textTracks:[track],getBoundingClientRect:()=>({width:800,height:450})};
  const listener={addListener(){}};
  const ctx=vm.createContext({window:{},location:{hostname:'video.test'},Date,NtSegmenter,...shared,
    document:{addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[video]},
    chrome:{runtime:{onMessage:listener,sendMessage:async msg=>messages.push(msg)},storage:{onChanged:listener}}});
  const source=fs.readFileSync('src/content/content.js','utf8').replace(/\}\)\(\);\s*$/,
    "active=true;sessionId='A';reader.startedAt=Date.now();reader.seg=new NtSegmenter(()=>{});playback.video=document.querySelectorAll()[0];globalThis.testReader=reader;})();");
  vm.runInContext(source,ctx);
  ctx.testReader.tick();ctx.testReader.tick();
  assert.equal(messages[0].type,'NT_CAPTION');
  const preparations=messages.filter(msg=>msg.type==='NT_CAPTION_PREFETCH');
  assert.equal(preparations.length,1);assert.equal(preparations[0].text,'Future.');
  assert.equal(messages.filter(msg=>msg.type==='NT_CAPTION').length,1);
});

test('buffering can recover from actual clock progress without another playing event',()=>{
  const events=new Map();const listener={addListener(){}};
  const video={paused:false,seeking:false,ended:false,readyState:2,playbackRate:1,currentTime:1,getBoundingClientRect:()=>({width:800,height:450})};
  const ctx=vm.createContext({window:{},location:{hostname:'video.test'},Date,NtSegmenter,...shared,
    document:{querySelectorAll:()=>[video],addEventListener:(event,fn)=>events.set(event,fn),removeEventListener(){}},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    chrome:{runtime:{onMessage:listener,sendMessage:async()=>{}},storage:{onChanged:listener}}});
  vm.runInContext(fs.readFileSync('src/content/content.js','utf8').replace(/\}\)\(\);\s*$/,
    'active=true;reader.seg=new NtSegmenter(()=>{});overlay.show=()=>{};globalThis.playbackTest=playback;})();'),ctx);
  ctx.playbackTest.start();events.get('waiting')({target:video,type:'waiting'});
  video.readyState=4;ctx.playbackTest.sync();assert.equal(ctx.playbackTest.paused,true);
  video.currentTime=1.3;ctx.playbackTest.sync();assert.equal(ctx.playbackTest.paused,false);
});
