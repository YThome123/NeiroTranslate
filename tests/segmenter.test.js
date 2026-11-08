// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { NtSegmenter } = require('../src/content/segmenter.js');

function run(snapshots, stepMs = 250) {
  const out = [];
  const seg = new NtSegmenter((t) => out.push(t));
  let now = 0;
  for (const s of snapshots) { seg.feed(s, now); now += stepMs; }
  // silence long enough to commit the tail
  for (let i = 0; i < 8; i++) { seg.feed(snapshots[snapshots.length - 1], now); now += stepMs; }
  return out;
}

test('rolling YouTube auto-captions are not duplicated', () => {
  const out = run([
    'so today we',
    'so today we are going',
    'so today we are going to talk about',
    'so today we are going to talk about neural networks',
    'so today we are going to talk about neural networks and how',
    'neural networks and how they learn',
    'neural networks and how they learn from data',
    'how they learn from data. First, let us',
    'from data. First, let us look at a neuron'
  ]);
  const joined = out.join(' | ');
  assert.equal((joined.match(/neural networks/g) || []).length, 1, joined);
  assert.equal((joined.match(/learn from data/g) || []).length, 1, joined);
  assert.ok(joined.includes('First, let us look at a neuron'), joined);
});

test('discrete cues are emitted once each, in order', () => {
  const out = run(['Hello there.', 'Hello there.', '', 'How are you today?', 'How are you today?', 'I am fine, thanks.']);
  assert.deepEqual(out, ['Hello there.', 'How are you today?', 'I am fine, thanks.']);
});

test('a replaced cue commits the previous one', () => {
  const out = run(['We will start', 'Completely different line']);
  assert.deepEqual(out, ['We will start', 'Completely different line']);
});

test('very long captions are split', () => {
  const long = Array.from({ length: 60 }, (_, i) => 'word' + i).join(' ');
  const out = run([long]);
  assert.ok(out.length >= 2, JSON.stringify(out));
  assert.ok(out.every((s) => s.length <= 180));
});

test('punctuation-only snapshots are ignored', () => {
  assert.deepEqual(run(['♪', '♪ ♪', '[Music]']), ['[Music]']);
});

test('a complete caption is emitted on its first frame', () => {
  const lines = [];
  const seg = new NtSegmenter(text => lines.push(text));
  seg.feed('A complete sentence.', 0);
  assert.deepEqual(lines, ['A complete sentence.']);
});

test('rolling captions use a short stable window instead of a one-second delay', () => {
  const lines = [];
  const seg = new NtSegmenter(text => lines.push(text), {stableMs:200,maxWaitMs:600});
  seg.feed('a short subtitle', 0); seg.feed('a short subtitle', 250);
  assert.deepEqual(lines, ['a short subtitle']);
});

test('identical utterances separated by missing captions are spoken independently', () => {
  assert.deepEqual(run(['Yes.', '', 'Yes.', '', 'Yes.', '']), ['Yes.', 'Yes.', 'Yes.']);
});

test('unchanged snapshots and a rolling prefix are still deduplicated within one utterance', () => {
  assert.deepEqual(run(['Yes.', 'Yes.', 'Yes.']), ['Yes.']);
  assert.deepEqual(run(['Hello.', 'Hello. How are', 'Hello. How are you?', 'Hello. How are you?']),
    ['Hello.', 'How are you?']);
});

test('repeated sentences inside one growing caption keep both spoken occurrences', () => {
  assert.deepEqual(run(['No! No!', 'No! No!', 'No! No! We should stop.']), ['No!', 'No!', 'We should stop.']);
});
