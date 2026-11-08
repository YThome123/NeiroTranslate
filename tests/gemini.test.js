const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function client(ResponseClass = Response, globals = {}) {
  const transcripts = [], audio = [], timers = [], fatals = [];
  class Socket { static OPEN = 1; readyState = 1; send() {} close() {} }
  const ctx = vm.createContext({ self: {}, WebSocket: Socket, Response: ResponseClass, console,
    setTimeout: (fn, ms) => { timers.push({fn, ms, cancelled:false}); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cancelled = true; }, ...globals });
  vm.runInContext(fs.readFileSync('src/offscreen/gemini-live.js', 'utf8'), ctx);
  const g = new ctx.self.NtGeminiLive({ apiKey:'test', onTranscript: t => transcripts.push(t), onAudio: a => audio.push(a), onFatal: detail => fatals.push(detail) });
  return { g, transcripts, audio, timers, fatals };
}
test('closing Gemini discards unfinished speech instead of emitting it', () => {
  const {g, transcripts} = client(); g.outBuf = 'Unfinished'; g.close();
  assert.equal(transcripts.length, 0);
});
test('late socket messages after close cannot play audio or emit subtitles', async () => {
  const {g, transcripts, audio} = client(); g.connect(); const socket = g.ws; g.close();
  await socket.onmessage({data:JSON.stringify({serverContent:{outputTranscription:{text:'Late.'},modelTurn:{parts:[{inlineData:{data:'AAAA'}}]}}})});
  assert.equal(audio.length, 0); assert.equal(transcripts.length, 0);
});
test('reconnect immediately stops sending audio to an unready socket', () => {
  const {g} = client(); g.connect(); g.ready = true; g._reconnect(500); g.sendAudio('AA');
  assert.equal(g.ready, false); assert.equal(g.pending.length, 1);
});

test('a decoded message from an old socket cannot complete a new handshake', async () => {
  let decode;
  class DelayedResponse { text() { return new Promise(r => {decode = r;}); } }
  const {g} = client(DelayedResponse); g.connect();
  g.ws.onmessage({data:{}});
  g._reconnect(0); g.connect();
  decode(JSON.stringify({setupComplete:{}}));
  await new Promise(r => setImmediate(r));
  assert.equal(g.ready, false);
});

test('malformed Gemini frames cannot reject the handler or emit invalid speech', async () => {
  const {g, transcripts, audio} = client();
  g.connect();
  try {
    for (const payload of [null, 5, [],
      {serverContent:{modelTurn:{parts:{}}}},
      {serverContent:{modelTurn:{parts:[null, {inlineData:{data:{}}}]},
        inputTranscription:{text:{}}, outputTranscription:{text:{}}}}
    ]) {
      await assert.doesNotReject(async () => g.ws.onmessage({data:JSON.stringify(payload)}));
    }
    assert.equal(audio.length, 0);
    assert.equal(transcripts.length, 0);
    await g.ws.onmessage({data:JSON.stringify({serverContent:{
      modelTurn:{parts:[{inlineData:{data:'AAAA', mimeType:'audio/pcm;rate=24000'}}]},
      outputTranscription:{text:'Valid.'}
    }})});
    assert.deepEqual(audio, ['AAAA']);
    assert.equal(transcripts[0].text, 'Valid.');
  } finally { g.close(); }
});

test('a structured Gemini error message terminates without rejecting the handler', async () => {
  const {g, fatals} = client();
  g.connect();
  await assert.doesNotReject(async () => g.ws.onmessage({data:JSON.stringify({error:{message:{code:500}}})}));
  assert.equal(fatals.length, 1);
  assert.equal(g.ws, null);
  assert.equal(g.closedByUser, true);
});

test('terminal Gemini socket closes discard buffered transcripts and queued audio', () => {
  for (const [event, retries, variant] of [
    [{code:1008, reason:'quota exhausted'}, 0, 0],
    [{code:1008, reason:'unknown model'}, 0, 2],
    [{code:1006, reason:''}, 6, 0]
  ]) {
    const {g, transcripts, timers, fatals} = client();
    g.connect();
    g.sendAudio('queued');
    g._pushOut('Unfinished');
    g._pushIn('Input');
    g.retries = retries;
    g.variant = variant;
    const beforeClose = transcripts.length;
    g.ws.onclose(event);
    for (const timer of timers.filter(timer => !timer.cancelled)) timer.fn();
    assert.equal(transcripts.length, beforeClose, 'a terminal close must not emit a delayed subtitle');
    assert.equal(g.pending.length, 0);
    assert.equal(g.ws, null);
    assert.equal(g.closedByUser, true);
    assert.equal(fatals.length, 1);
  }
});

test('a congested ready Gemini transport is abandoned before more old audio can accumulate', () => {
  const {g, transcripts} = client(); g.connect(); g.ready = true;
  const old = g.ws; let sent = 0, closed = false;
  old.bufferedAmount = 1024 * 1024;
  old.send = () => {sent++;}; old.close = () => {closed = true;};
  g.resumeHandle = 'old-resumption'; g.outBuf = 'Unfinished old speech';
  g.sendAudio('fresh');
  assert.equal(sent, 0);
  assert.equal(closed, true);
  assert.equal(g.ready, false);
  assert.notEqual(g.ws, old);
  assert.equal(g.resumeHandle, null);
  assert.equal(transcripts.length, 0, 'congestion must discard the stale transcript tail');
  assert.ok(g.pending.length <= 1);
  g.close();
});

test('handshake cannot send source audio which has aged out while waiting', async () => {
  let now = 1000;
  class Clock extends Date {static now() {return now;}}
  const {g} = client(Response, {Date: Clock}); g.connect();
  const sent = []; g.ws.send = raw => sent.push(JSON.parse(raw));
  g.sendAudio('stale'); now = 5000; g.sendAudio('recent');
  await g.ws.onmessage({data:JSON.stringify({setupComplete:{}})});
  assert.deepEqual(sent.map(msg => msg.realtimeInput.audio.data), ['recent']);
  g.close();
});

test('a stale socket open cannot send its setup to the replacement transport', () => {
  const {g} = client(); g.connect(); const old = g.ws;
  g._reconnect(0); g.connect();
  let sent = 0; g.ws.send = () => {sent++;};
  old.onopen();
  assert.equal(sent, 0);
  g.close();
});

test('a Gemini send failure recovers without throwing into the audio capture callback', () => {
  const {g} = client(); g.connect(); g.ready = true;
  const old = g.ws; old.send = () => {throw new Error('Transport unavailable');};
  assert.doesNotThrow(() => g.sendAudio('fresh'));
  assert.equal(g.ready, false);
  assert.notEqual(g.ws, old);
  g.close();
});

test('persistent transport congestion has a bounded recovery budget', () => {
  const {g, fatals} = client();
  for (let attempt = 0; attempt < 12 && !fatals.length; attempt++) {
    g.connect(); g.ready = true;
    g.ws.bufferedAmount = 1024 * 1024;
    g.sendAudio('fresh');
  }
  assert.equal(fatals.length, 1);
  assert.equal(g.closedByUser, true);
  assert.equal(g.ws, null);
  assert.equal(g.pending.length, 0);
});

function clockClient() {
  let now = 0;
  class Clock extends Date {static now() {return now;}}
  const fixture = client(Response, {Date: Clock});
  return {
    ...fixture,
    advance(ms) { now += ms; },
    reconnect() {
      const timer = fixture.timers[fixture.g.reconnectTimer - 1];
      now += timer.ms;
      timer.fn();
    },
    async handshake() {
      fixture.g.ws.onopen();
      await fixture.g.ws.onmessage({data:JSON.stringify({setupComplete:{}})});
    }
  };
}

test('slow failed handshakes still exhaust the Gemini transport recovery budget', async () => {
  const fixture = clockClient();
  const {g, fatals} = fixture;
  g.connect();
  let attempts = 0;
  for (; attempts < 20 && !fatals.length; attempts++) {
    fixture.advance(11000);
    await fixture.handshake();
    g.ws.bufferedAmount = 1024 * 1024;
    g.sendAudio('fresh');
    if (!fatals.length) fixture.reconnect();
  }
  assert.equal(attempts, 7, 'six recoveries must be followed by a terminal failure');
  assert.equal(fatals.length, 1);
  assert.equal(g.closedByUser, true);
  assert.equal(g.ws, null);
  assert.equal(g.pending.length, 0);
});

test('sustained healthy audio restores the Gemini transport recovery budget', async () => {
  const fixture = clockClient();
  const {g, fatals} = fixture;
  g.connect();
  for (let attempt = 0; attempt < 6; attempt++) {
    await fixture.handshake();
    g.ws.bufferedAmount = 1024 * 1024;
    g.sendAudio('fresh');
    fixture.reconnect();
  }
  await fixture.handshake();
  // Backoff may expire queued audio; start a fresh stream after setup completes.
  g.sendAudio('healthy');
  for (let packet = 0; packet < 100; packet++) {
    fixture.advance(100);
    g.sendAudio('healthy');
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    g.ws.bufferedAmount = 1024 * 1024;
    g.sendAudio('fresh');
    assert.equal(fatals.length, 0, 'a healthy interval must allow six more recoveries');
    fixture.reconnect();
    await fixture.handshake();
  }
  g.ws.bufferedAmount = 1024 * 1024;
  g.sendAudio('fresh');
  assert.equal(fatals.length, 1, 'a restored budget must remain bounded');
  assert.equal(g.closedByUser, true);
});

test('idle ready time cannot restore the Gemini transport recovery budget', async () => {
  const fixture = clockClient();
  const {g, fatals} = fixture;
  g.connect();
  for (let attempt = 0; attempt < 6; attempt++) {
    await fixture.handshake();
    g.ws.bufferedAmount = 1024 * 1024;
    g.sendAudio('fresh');
    fixture.reconnect();
  }
  await fixture.handshake();
  fixture.advance(11000);
  g.sendAudio('after-idle');
  g.ws.bufferedAmount = 1024 * 1024;
  g.sendAudio('fresh');
  assert.equal(fatals.length, 1, 'idle time and an isolated send do not prove sustained health');
  assert.equal(g.ws, null);
});
