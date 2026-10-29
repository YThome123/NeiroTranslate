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
  const realm = vm.createContext({self:{},setInterval:() => 1,clearInterval(){}});
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
