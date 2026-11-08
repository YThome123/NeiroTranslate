const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness() {
  const sources = [];
  const ctx = {
    currentTime:10, state:'running',
    createGain:() => ({gain:{setValueAtTime(){},linearRampToValueAtTime(){}},connect(){},disconnect(){}}),
    createBufferSource:() => {
      const source = {playbackRate:{value:1},connect(){},disconnect(){},
        start(at) {this.startAt=at;}, stop(at) {this.stopAt=at;}};
      sources.push(source);
      return source;
    }
  };
  const realm = vm.createContext({self:{},setInterval:() => 1,clearInterval(){},setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync('src/offscreen/audio-player.js','utf8'),realm);
  return {player:new realm.self.NtAudioPlayer(ctx,{}),ctx,sources};
}

test('WebAudio schedules the source to stop at its caption deadline', () => {
  const {player,sources} = harness();
  player.deadline = 10.5;
  player.enqueueBuffer({duration:8});
  assert.equal(sources[0].stopAt,10.5);
  assert.equal(player.endTime,10.5);
  assert.equal(player.aheadSec,0.5);
});

test('stream chunks past the caption deadline cannot schedule any more audio', () => {
  const {player,sources} = harness();
  player.deadline = 10.5;
  player.enqueueBuffer({duration:8});
  player.enqueueBuffer({duration:8});
  assert.equal(sources.length,1);
});

test('clearing caption audio removes its deadline for the next stream', () => {
  const {player,sources} = harness();
  player.deadline = 10.5;
  player.clear();
  player.enqueueBuffer({duration:8});
  assert.equal(sources[0].stopAt,undefined);
  assert.ok(player.aheadSec >= 8);
});

test('playback completion waits for the last real source, including cancellation',async()=>{
  const {player,sources}=harness();
  player.enqueueBuffer({duration:1});player.enqueueBuffer({duration:1});
  let idle=false;const pending=player.whenIdle().then(()=>{idle=true;});
  sources[0].onended();await Promise.resolve();assert.equal(idle,false);
  sources[1].onended();await pending;assert.equal(idle,true);
  player.enqueueBuffer({duration:1});const cancelled=player.whenIdle();player.clear();await cancelled;
});

test('first audio cannot start beyond startBy even with completion time remaining', () => {
  const {player,sources} = harness();
  player.startBy = Date.now() + 30;
  player.deadline = 20;
  assert.equal(player.enqueueBuffer({duration:1}), false);
  assert.equal(sources.length, 0);
});

test('a started phrase retains its tail after startBy; clear resets the first-start gate', () => {
  const {player,sources} = harness();
  player.startBy = Date.now() + 200;
  assert.equal(player.enqueueBuffer({duration:1}), true);
  player.startBy = Date.now() - 1;
  assert.equal(player.enqueueBuffer({duration:1}), true);
  player.clear();
  player.startBy = Date.now() - 1;
  assert.equal(player.enqueueBuffer({duration:1}), false);
  assert.equal(sources.length, 2);
});

test('async playback waits for context resume and rejects a now-expired first start',async()=>{
  const {player,ctx,sources}=harness();let resume;
  ctx.state='suspended';ctx.resume=()=>new Promise(resolve=>{resume=()=>{ctx.state='running';resolve();};});
  player.startBy=Date.now()+1000;
  const pending=player.enqueueBufferAsync({duration:.2});
  await new Promise(setImmediate);
  assert.equal(sources.length,0,'pending resume is not audible first audio');
  assert.equal(player.started,false);
  player.startBy=Date.now()-1;resume();
  assert.equal(await pending,false);assert.equal(sources.length,0);
});

test('clear cancels an unresolved resume without waiting or scheduling stale audio',async()=>{
  const {player,ctx,sources}=harness();let resume;
  ctx.state='suspended';ctx.resume=()=>new Promise(resolve=>{resume=()=>{ctx.state='running';resolve();};});
  player.startBy=Date.now()+1000;
  const pending=player.enqueueBufferAsync({duration:.2});
  await new Promise(setImmediate);player.clear();
  assert.equal(await pending,false);
  resume();await new Promise(setImmediate);
  assert.equal(sources.length,0);assert.equal(player.started,false);
});

test('clear between async readiness and scheduling cannot revive a superseded source',async()=>{
  const {player,sources}=harness();
  const pending=player.enqueueBufferAsync({duration:.2});
  await Promise.resolve();player.clear();
  assert.equal(await pending,false);assert.equal(sources.length,0);
});

test('unresolved resume expires at the first-start budget without marking speech started',async()=>{
  const {player,ctx,sources}=harness();
  ctx.state='suspended';ctx.resume=()=>new Promise(()=>{});
  player.startBy=Date.now()+90;
  assert.equal(await player.enqueueBufferAsync({duration:.2}),false);
  await player.whenIdle();assert.equal(player.started,false);assert.equal(sources.length,0);
});
