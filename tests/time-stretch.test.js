const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {ntTimeStretch} = require('../src/offscreen/time-stretch.js');

const RATE = 24000;
function tone(hz, seconds) {
  return Float32Array.from({length: Math.round(RATE * seconds)}, (_, i) =>
    0.5 * Math.sin(2 * Math.PI * hz * i / RATE) + 0.2 * Math.sin(2 * Math.PI * 2 * hz * i / RATE));
}
function frequency(samples) {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  return crossings / (samples.length / RATE);
}

test('WSOLA changes duration but keeps pitch', () => {
  for (const ratio of [0.6, 0.8, 1.25]) {
    const out = ntTimeStretch(tone(180, 2), ratio, RATE);
    assert.equal(out.length, Math.round(2 * RATE * ratio));
    assert.ok(Math.abs(frequency(out) - 180) < 3, `${ratio}: ${frequency(out)}`);
  }
});

test('WSOLA output has no clicks or level jumps on a steady tone', () => {
  const out = ntTimeStretch(tone(200, 1), 0.7, RATE);
  let peak = 0;
  for (let i = RATE * 0.05; i < out.length - RATE * 0.05; i++) peak = Math.max(peak, Math.abs(out[i]));
  assert.ok(peak < 0.8, String(peak));
});

test('degenerate input is handled without throwing or hanging', () => {
  assert.equal(ntTimeStretch(new Float32Array(0), 0.7, RATE).length, 0);
  assert.equal(ntTimeStretch(tone(200, 0.01), 0.7, RATE).length, Math.round(0.01 * RATE * 0.7));
  assert.equal(ntTimeStretch(tone(200, 0.1), NaN, RATE).length, 0);
  const same = tone(200, 0.1);
  assert.deepEqual(ntTimeStretch(same, 1.005, RATE), same);
});

function playerHarness() {
  const sources = [];
  const ctx = {
    currentTime: 10, state: 'running',
    createGain: () => ({gain: {setValueAtTime() {}, linearRampToValueAtTime() {}}, connect() {}, disconnect() {}}),
    createBuffer: (channels, length, sampleRate) => {
      const data = new Float32Array(length);
      return {numberOfChannels: 1, length, sampleRate, duration: length / sampleRate, getChannelData: () => data};
    },
    createBufferSource: () => {
      const source = {playbackRate: {value: 1}, connect() {}, disconnect() {}, start(at) { this.startAt = at; }, stop(at) { this.stopAt = at; }};
      sources.push(source);
      return source;
    }
  };
  const realm = vm.createContext({self: {}, setInterval: () => 1, clearInterval() {}, Float32Array, Math, Date});
  vm.runInContext(fs.readFileSync('src/offscreen/time-stretch.js', 'utf8'), realm);
  realm.ntStretchAudioBuffer = realm.self.ntStretchAudioBuffer;
  vm.runInContext(fs.readFileSync('src/offscreen/audio-player.js', 'utf8'), realm);
  return {player: new realm.self.NtAudioPlayer(ctx, {}), ctx, sources};
}

function buffer(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.round(RATE * seconds), RATE);
  b.getChannelData(0).set(tone(200, seconds));
  return b;
}

test('player speeds a phrase up with its pitch kept (stretch, rate 1)', () => {
  const {player, ctx, sources} = playerHarness();
  player.enqueueBuffer(buffer(ctx, 2), {tempo: 1.5});
  assert.equal(sources[0].playbackRate.value, 1);
  assert.ok(Math.abs(sources[0].buffer.duration - 2 / 1.5) < 0.01);
  assert.ok(Math.abs(player.endTime - (10.06 + 2 / 1.5)) < 0.01);
});

test('player shifts pitch at constant duration for a second speaker', () => {
  const {player, ctx, sources} = playerHarness();
  player.enqueueBuffer(buffer(ctx, 2), {pitch: 0.8});
  assert.equal(sources[0].playbackRate.value, 0.8);
  assert.ok(Math.abs(sources[0].buffer.duration / 0.8 - 2) < 0.01);
});

test('live stream catch-up speeds up a backlog and drops what is too far behind', () => {
  const {player, ctx, sources} = playerHarness();
  player.catchUp = true;
  player.enqueueBuffer({duration: 2});
  player.enqueueBuffer({duration: 2});
  assert.ok(sources[1].playbackRate.value > 1);
  player.enqueueBuffer({duration: 4});
  const count = sources.length;
  player.enqueueBuffer({duration: 1});
  assert.equal(sources.length, count, 'backlog beyond dropAfterSec is discarded');
});
