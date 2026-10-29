const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/shared/speakers.js');

function voice(hz, ms, rate = 16000, amp = 0.4) {
  const n = Math.round(rate * ms / 1000), out = new Float32Array(n);
  // Harmonic-rich source like a glottal pulse train, with mild vibrato and noise.
  for (let i = 0; i < n; i++) {
    const f = hz * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * i / rate));
    let v = 0;
    for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * i / rate) / h;
    out[i] = amp * v * 0.5 + (Math.random() - 0.5) * 0.01;
  }
  return out;
}

function frames(hz, from, to, rms = 0.1) {
  const out = [];
  for (let t = from; t <= to; t += 20) out.push({wall: t, f0: hz * (1 + (Math.random() - 0.5) * 0.04), rms});
  return out;
}

test('caption markup becomes ">>" turns with names, other tags removed', () => {
  assert.equal(S.ntMarkCaptionTurns('<v Roger>Hi there</v>'), '>> Roger: Hi there');
  assert.equal(S.ntMarkCaptionTurns('- Where are you?\n- At home.'), '>> Where are you? >> At home.');
  assert.equal(S.ntMarkCaptionTurns('<i>Just</i> a line\nwrapped'), 'Just a line wrapped');
  // A hyphen inside a sentence is not a turn.
  assert.equal(S.ntMarkCaptionTurns('well - maybe'), 'well - maybe');
});

test('turn parsing splits speakers and recognises labels conservatively', () => {
  assert.deepEqual(S.ntParseSpeakerTurns('>> JOHN: Hello. >> Hi John.').map(p => [p.name, p.text, p.turn]),
    [['JOHN', 'Hello.', true], [null, 'Hi John.', true]]);
  assert.deepEqual(S.ntParseSpeakerTurns('still talking'), [{text: 'still talking', name: null, turn: false}]);
  assert.equal(S.ntParseSpeakerTurns('Note: this is text')[0].name, null);
  assert.equal(S.ntParseSpeakerTurns('ANNA: Привет')[0].name, 'ANNA');
  assert.equal(S.ntParseSpeakerTurns('>>').length, 0);
});

test('sound descriptions and lyrics are not spoken', () => {
  assert.equal(S.ntSpeakableText('[Музыка] Привет (смеётся) всем ♪ ля-ля ♪'), 'Привет всем');
  assert.equal(S.ntSpeakableText('[Applause]'), '');
});

test('YIN finds the pitch of harmonic voices and nothing in noise or silence', () => {
  for (const hz of [95, 125, 180, 240, 310]) {
    const f0 = S.ntDetectPitch(voice(hz, 64), 16000);
    assert.ok(Math.abs(f0 - hz) / hz < 0.03, `${hz} → ${f0}`);
  }
  const noise = Float32Array.from({length: 1024}, () => Math.random() - 0.5);
  assert.equal(S.ntDetectPitch(noise, 16000), 0);
  assert.equal(S.ntDetectPitch(new Float32Array(1024), 16000), 0);
});

test('a phrase window summarises voiced loud frames only', () => {
  const list = [...frames(120, 0, 1000), ...frames(400, 1000, 1400, 0.001)];
  const summary = S.ntSummarizePitch(list, 0, 1400);
  assert.ok(Math.abs(Math.pow(2, summary.log2) - 120) < 5);
  assert.equal(S.ntSummarizePitch(list, 5000, 6000), null);
  assert.equal(S.ntSummarizePitch(frames(120, 0, 60), 0, 60), null); // too little speech
});

test('clusters separate a low and a high speaker and keep each stable', () => {
  const clusters = new S.NtSpeakerClusters();
  const ids = [];
  let previous = null;
  for (const hz of [115, 120, 225, 230, 118, 222, 112, 235]) {
    const result = clusters.assign(Math.log2(hz * (1 + (Math.random() - 0.5) * 0.04)), 30, previous);
    ids.push(result.cluster); previous = result.cluster;
  }
  assert.equal(new Set(ids).size, 2, ids.join(','));
  assert.equal(ids[0], ids[1]); assert.equal(ids[0], ids[4]); assert.equal(ids[2], ids[5]);
  assert.equal(clusters.assign(Math.log2(118), 30).pitchClass, 'low');
  assert.equal(clusters.assign(Math.log2(228), 30).pitchClass, 'high');
});

test('one speaker with normal intonation stays one cluster', () => {
  const clusters = new S.NtSpeakerClusters();
  let previous = null; const ids = new Set();
  for (const hz of [140, 150, 135, 160, 145, 152, 138, 158]) {
    previous = clusters.assign(Math.log2(hz), 30, previous).cluster; ids.add(previous);
  }
  assert.equal(ids.size, 1);
});

test('speaker book: names, acoustic clusters and bare turns map to stable profiles', () => {
  const book = new S.NtSpeakerBook();
  const a = book.resolve({text: 'x', name: 'Anna'}, null, 0);
  const b = book.resolve({text: 'y', name: 'Boris'}, null, 0);
  assert.equal(book.resolve({text: 'z', name: 'anna'}, null, 0), a);
  assert.notEqual(a.index, b.index);
  // Unmarked text continues the last speaker; a bare turn goes to the other one.
  assert.equal(book.resolve({text: 'q'}, null, 0), a);
  assert.equal(book.resolve({text: 'w', turn: true}, null, 0), b);
  const fresh = new S.NtSpeakerBook();
  const low = fresh.resolve({}, {cluster: 1, pitchClass: 'low'}, 0);
  const high = fresh.resolve({}, {cluster: 2, pitchClass: 'high'}, 0);
  assert.equal(low.pitchClass, 'low'); assert.equal(high.pitchClass, 'high');
  assert.equal(fresh.resolve({}, {cluster: 1, pitchClass: 'low'}, 0), low);
  assert.equal(fresh.lastCluster, 1);
});

test('speaker book stays bounded on endless new names', () => {
  const book = new S.NtSpeakerBook();
  for (let i = 0; i < 50; i++) book.resolve({name: 'P' + i}, null, 0);
  assert.ok(book.size <= S.NT_SPEAKERS.MAX_PROFILES);
});

test('browser voices: speakers get distinct voices matched to pitch class', () => {
  const book = new S.NtSpeakerBook();
  const voices = [{voiceName: 'Microsoft Irina'}, {voiceName: 'Microsoft Pavel'}, {voiceName: 'Microsoft Svetlana'}];
  const first = book.resolve({}, {cluster: 1, pitchClass: 'high'}, 0);
  const second = book.resolve({}, {cluster: 2, pitchClass: 'low'}, 0);
  assert.deepEqual(S.ntPickSpeakerVoice('browser', first, book, {voices, primary: 'Microsoft Irina'}), {voiceName: 'Microsoft Irina', pitch: 1});
  const v2 = S.ntPickSpeakerVoice('browser', second, book, {voices, primary: 'Microsoft Irina'});
  assert.equal(v2.voiceName, 'Microsoft Pavel');
  // Stable on repeat.
  assert.equal(S.ntPickSpeakerVoice('browser', second, book, {voices, primary: 'Microsoft Irina'}).voiceName, 'Microsoft Pavel');
});

test('browser with a single voice separates speakers by pitch', () => {
  const book = new S.NtSpeakerBook();
  const voices = [{voiceName: 'Google русский'}];
  const first = book.resolve({name: 'A'}, null, 0), second = book.resolve({name: 'B'}, null, 0);
  const p1 = S.ntPickSpeakerVoice('browser', first, book, {voices, primary: 'Google русский'});
  const p2 = S.ntPickSpeakerVoice('browser', second, book, {voices, primary: 'Google русский'});
  assert.equal(p2.voiceName, 'Google русский');
  assert.notEqual(p1.pitch, p2.pitch);
});

test('Google voice: low speakers sound lower, unknown speakers alternate', () => {
  const book = new S.NtSpeakerBook();
  const low = book.resolve({}, {cluster: 1, pitchClass: 'low'}, 0);
  assert.ok(S.ntPickSpeakerVoice('google', low, book).pitch < 0.9);
  const plain = new S.NtSpeakerBook();
  const a = plain.resolve({name: 'A'}, null, 0), b = plain.resolve({name: 'B'}, null, 0);
  assert.equal(S.ntPickSpeakerVoice('google', a, plain).pitch, 1);
  assert.notEqual(S.ntPickSpeakerVoice('google', b, plain).pitch, 1);
  assert.deepEqual(S.ntPickSpeakerVoice('google', null, plain), {pitch: 1});
});

test('Yandex picks a voice of matching gender for other speakers; ElevenLabs uses the second voice', () => {
  const book = new S.NtSpeakerBook();
  const first = book.resolve({}, {cluster: 1, pitchClass: 'high'}, 0);
  const man = book.resolve({}, {cluster: 2, pitchClass: 'low'}, 0);
  const settings = {yandexVoice: 'marina', elevenVoiceId: 'v1', elevenVoiceId2: 'v2'};
  assert.equal(S.ntPickSpeakerVoice('yandex', first, book, {settings, lang: 'ru'}).yandexVoice, 'marina');
  assert.equal(S.ntPickSpeakerVoice('yandex', man, book, {settings, lang: 'ru'}).yandexVoice, 'filipp');
  assert.equal(S.ntPickSpeakerVoice('elevenlabs', first, book, {settings}).elevenVoiceId, 'v1');
  assert.equal(S.ntPickSpeakerVoice('elevenlabs', man, book, {settings}).elevenVoiceId, 'v2');
  assert.equal(S.ntPickSpeakerVoice('elevenlabs', man, book, {settings: {elevenVoiceId: 'v1'}}).elevenVoiceId, 'v1');
});

test('voice gender guesses from common voice names', () => {
  assert.equal(S.ntGuessVoiceGender('Microsoft Dmitry Online (Natural) - Russian'), 'male');
  assert.equal(S.ntGuessVoiceGender('Microsoft Svetlana Online (Natural)'), 'female');
  assert.equal(S.ntGuessVoiceGender('Google UK English Male'), 'male');
  assert.equal(S.ntGuessVoiceGender('Google UK English Female'), 'female');
  assert.equal(S.ntGuessVoiceGender('Unknown voice'), null);
});
