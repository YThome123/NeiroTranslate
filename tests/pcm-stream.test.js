const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const sources = [];
  const ctx = { currentTime: 0, state: 'running',
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { length, sampleRate, numberOfChannels: 1, duration: length / sampleRate, getChannelData: () => data };
    },
    createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }),
    createBufferSource() {
      const source = { playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() {}, stop() {} };
      sources.push(source); return source;
    }
  };
  const realm = vm.createContext({ self: {}, Float32Array, Date, setInterval: () => 1, clearInterval() {} });
  for (const file of ['src/offscreen/time-stretch.js', 'src/offscreen/audio-player.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), realm);
  }
  return { player: new realm.self.NtAudioPlayer(ctx, {}), sources };
}

const rate = 24000;
const shape = { tempo: 4 / 3, stream: true, preservePitch: true };
function pcm(seconds) {
  const bytes = new Uint8Array(Math.round(rate * seconds) * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length / 2; i++) view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * 180 * i / rate) * 10000), true);
  return bytes;
}

test('streamed tempo preserves pitch independent of 100ms versus 200ms network fragments', () => {
  const speech = pcm(0.65), rendered = [];
  for (const bytesPerPacket of [4800, 9600, 137]) {
    const h = harness();
    for (let at = 0; at < speech.length; at += bytesPerPacket) {
      h.player.enqueuePcm16(speech.slice(at, at + bytesPerPacket).buffer, rate, shape);
    }
    assert.ok(h.sources.every(source => source.playbackRate.value === 1), 'a small packet must not pitch-shift the voice');
    h.player.flushPcm16();
    const audio = h.sources.flatMap(source => Array.from(source.buffer.getChannelData(0)));
    const seconds = h.sources.reduce((sum, source) => sum + source.buffer.duration / source.playbackRate.value, 0);
    assert.ok(seconds >= 0.48 && seconds <= 0.56, `accelerated speech length: ${seconds}`);
    let crossings = 0;
    for (let i = 1; i < audio.length; i++) if (audio[i - 1] < 0 && audio[i] >= 0) crossings++;
    const frequency = crossings / (audio.length / rate);
    assert.ok(Math.abs(frequency - 180) < 8, `pitch should stay 180Hz, got ${frequency}`);
    rendered.push(audio);
  }
  assert.deepEqual(rendered[0], rendered[1], 'network boundaries must not change the rendered speech');
  assert.deepEqual(rendered[0], rendered[2], 'odd-byte packet boundaries must also preserve complete PCM samples');
});

test('streamed stretching schedules the first block after 160ms of PCM without waiting for the sentence', () => {
  const h = harness();
  h.player.enqueuePcm16(pcm(0.1).buffer, rate, shape);
  assert.equal(h.sources.length, 0);
  h.player.enqueuePcm16(pcm(0.06).buffer, rate, shape);
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].playbackRate.value, 1);
});

test('clearing speech discards a buffered PCM tail before a different voice starts', () => {
  const h = harness();
  h.player.enqueuePcm16(pcm(0.06).buffer, rate, shape);
  h.player.clear();
  h.player.flushPcm16();
  assert.equal(h.sources.length, 0);
  h.player.enqueuePcm16(pcm(0.03).buffer, rate);
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].buffer.length, 720, 'only the new voice may remain');
});
