const test=require('node:test');
const assert=require('node:assert/strict');
const {NtSpeechQueue}=require('../src/shared/speech-queue.js');
const {fakeClock}=require('./fixtures/clock.js');
const tick=()=>new Promise(setImmediate);

test('retained complete work survives expiry and rejects overflow without replacing accepted phrases',async()=>{
  let now=0;const played=[],releases=[];
  const queue=new NtSpeechQueue({now:()=>now,maxPending:6,play:item=>{played.push(item.id);return new Promise(resolve=>releases.push(resolve));}});
  queue.enqueue({id:1,startBy:10,retain:true});await tick();
  for(let id=2;id<=7;id++)assert.equal(queue.enqueue({id,startBy:10,retain:true}),true);
  assert.equal(queue.enqueue({id:8,startBy:10,retain:true}),false);
  now=20000;queue.watchOverrun();
  for(let i=0;i<7;i++){releases.shift()();await tick();}
  assert.deepEqual(played,[1,2,3,4,5,6,7]);
  queue.clear();
});

test('new captions wait for the current phrase rather than aborting it',async()=>{
  const played=[],releases=[];
  const queue=new NtSpeechQueue({play:(item,signal)=>{played.push({id:item.id,signal});return new Promise(resolve=>releases.push(resolve));}});
  queue.enqueue({id:'A',startBy:Date.now()+3000});await tick();
  queue.enqueue({id:'B',startBy:Date.now()+3000});await tick();
  assert.deepEqual(played.map(x=>x.id),['A']);assert.equal(played[0].signal.aborted,false);
  releases.shift()();await tick();assert.deepEqual(played.map(x=>x.id),['A','B']);
  queue.clear();releases.shift()();await tick();
});

test('a bounded pending queue keeps recent captions and skips expired ones',async()=>{
  let now=0;const played=[],release=[];
  const queue=new NtSpeechQueue({now:()=>now,maxPending:2,play:item=>{played.push(item.id);return new Promise(resolve=>release.push(resolve));}});
  queue.enqueue({id:'A',startBy:100});await tick();
  queue.enqueue({id:'old',startBy:100});queue.enqueue({id:'B',startBy:5});queue.enqueue({id:'C',startBy:100});
  assert.equal(queue.pendingCount,2);now=10;release.shift()();await tick();
  assert.deepEqual(played,['A','C']);queue.clear();release.shift()();await tick();
});

test('clear aborts current work immediately and a late completion cannot erase new speech',async()=>{
  const played=[],release=[];
  const queue=new NtSpeechQueue({play:(item,signal)=>{played.push({id:item.id,signal});return new Promise(resolve=>release.push(resolve));}});
  queue.enqueue({id:'A',startBy:Date.now()+3000});await tick();queue.enqueue({id:'B',startBy:Date.now()+3000});
  queue.clear();assert.equal(played[0].signal.aborted,true);assert.equal(queue.pendingCount,0);
  queue.enqueue({id:'C',startBy:Date.now()+3000});await tick();release[0]();await tick();
  assert.equal(queue.active,true);assert.deepEqual(played.map(x=>x.id),['A','C']);
  release[1]();await tick();assert.equal(queue.active,false);
});

test('one playback failure releases the queue for the next caption',async()=>{
  const played=[],errors=[];
  const queue=new NtSpeechQueue({play:async item=>{played.push(item.id);if(item.id==='A')throw new Error('Voice unavailable');},onError:error=>errors.push(error.message)});
  queue.enqueue({id:'A',startBy:Date.now()+3000});queue.enqueue({id:'B',startBy:Date.now()+3000});await tick();await tick();
  assert.deepEqual(played,['A','B']);assert.deepEqual(errors,['Voice unavailable']);assert.equal(queue.active,false);
});

test('a caption which expires before the playback microtask is never started',async()=>{
  let now=0;const played=[];
  const queue=new NtSpeechQueue({now:()=>now,play:item=>played.push(item.id)});
  queue.enqueue({id:'expired',startBy:10});
  now=10;await tick();
  assert.deepEqual(played,[]);
  assert.equal(queue.active,false);
  queue.enqueue({id:'fresh',startBy:20});await tick();
  assert.deepEqual(played,['fresh']);
});

test('a phrase overrunning its slot is cut only once a newer phrase waits',async()=>{
  let now=0;const played=[];
  const queue=new NtSpeechQueue({now:()=>now,maxPending:1,play:(item,signal)=>{played.push({id:item.id,signal});return new Promise(resolve=>signal.addEventListener('abort',resolve));}});
  queue.enqueue({id:'A',startBy:100,cutAt:50});await tick();
  now=80;queue.watchOverrun();
  assert.equal(played[0].signal.aborted,false,'nothing waits: the phrase finishes');
  queue.enqueue({id:'B',startBy:500,cutAt:900});
  assert.equal(played[0].signal.aborted,true);await tick();await tick();
  assert.deepEqual(played.map(x=>x.id),['A','B']);
  queue.clear();
});

test('an overrun is armed as a timer and disarmed when the phrase ends',async()=>{
  const clock=fakeClock();
  const context={module:{exports:{}},AbortController,...clock.globals};
  require('node:vm').runInNewContext(require('node:fs').readFileSync('src/shared/speech-queue.js','utf8'),context);
  const ClockedQueue=context.module.exports.NtSpeechQueue;
  const played=[];let release;
  const queue=new ClockedQueue({now:clock.now,maxPending:1,play:(item,signal)=>{played.push({id:item.id,signal});return new Promise(resolve=>{release=resolve;signal.addEventListener('abort',resolve);});}});
  queue.enqueue({id:'A',startBy:3000,cutAt:40});await tick();
  queue.enqueue({id:'B',startBy:3000,cutAt:Infinity});
  assert.equal(played[0].signal.aborted,false);
  await clock.advance(80);
  assert.equal(played[0].signal.aborted,true);await tick();await tick();
  assert.equal(played[1].id,'B');release();await tick();
  assert.equal(queue.active,false);
});

test('a near-ending phrase gets one grace period; an unknown or long remainder is cut',async()=>{
  let now=0,left=300;const played=[];const timers=[];
  const realSetTimeout=global.setTimeout;
  const queue=new NtSpeechQueue({now:()=>now,maxPending:1,nearEndMs:800,remaining:()=>left,
    play:(item,signal)=>{played.push({id:item.id,signal});return new Promise(resolve=>signal.addEventListener('abort',resolve));}});
  queue.enqueue({id:'A',startBy:100,cutAt:50});await tick();
  now=60;queue.enqueue({id:'B',startBy:500,cutAt:900});
  assert.equal(played[0].signal.aborted,false,'graced');
  queue.watchOverrun();
  assert.equal(played[0].signal.aborted,true,'grace is used only once');
  await tick();await tick();
  left=5000;now=1000;queue.enqueue({id:'C',startBy:2000,cutAt:3000});
  now=3100;queue.watchOverrun();
  assert.equal(played[1].signal.aborted,true,'a long remainder is cut at once');
  queue.clear();
});

test('an expired waiting phrase cannot cut the current one',async()=>{
  let now=0;const played=[];
  const queue=new NtSpeechQueue({now:()=>now,maxPending:1,
    play:(item,signal)=>{played.push({id:item.id,signal});return new Promise(resolve=>signal.addEventListener('abort',resolve));}});
  queue.enqueue({id:'A',startBy:100,cutAt:3000});await tick();
  now=50;queue.enqueue({id:'B',startBy:2000,cutAt:9000});
  now=5100;queue.watchOverrun();
  assert.equal(played[0].signal.aborted,false);
  assert.equal(queue.pendingCount,0);
  queue.clear();
});
