const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function settingsStore(initial = {}) {
  const data = { ...initial };
  const runtime = {};
  let getError, setError;
  const context = vm.createContext({ self: {}, chrome: { runtime, storage: { local: {
    get(defaults, callback) {
      runtime.lastError = getError && { message: getError };
      callback(Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, key in data ? data[key] : fallback])));
      delete runtime.lastError;
    },
    set(patch, callback) {
      runtime.lastError = setError && { message: setError };
      if (!setError) Object.assign(data, patch);
      callback();
      delete runtime.lastError;
    }
  } } } });
  vm.runInContext(fs.readFileSync('src/shared/settings.js', 'utf8'), context);
  return { ...context.self, data,
    failGet(message) { getError = message; },
    failSet(message) { setError = message; }
  };
}

test('settings reads reject the callback lastError instead of returning defaults as success', async () => {
  const store = settingsStore();
  store.failGet('Storage unavailable');
  await assert.rejects(store.ntGetSettings(), /Storage unavailable/);
});

test('settings writes reject the callback lastError without erasing saved keys or history', async () => {
  const store = settingsStore({ voice: 'google', geminiApiKey: 'saved-key', nt_sessions: [{ durationSec: 12 }] });
  store.failSet('Quota exceeded');
  await assert.rejects(store.ntSetSettings({ voice: 'browser' }), /Quota exceeded/);
  assert.equal(store.data.voice, 'google');
  assert.equal(store.data.geminiApiKey, 'saved-key');
  assert.deepEqual(store.data.nt_sessions, [{ durationSec: 12 }]);
});

test('invalid providers and nonnumeric volumes read as usable defaults', async () => {
  const store = settingsStore({ source: 'retired', voice: 'unknown', originalVolume: null, dubVolume: 'loud' });
  const settings = await store.ntGetSettings();
  assert.equal(settings.source, 'captions');
  assert.equal(settings.voice, 'browser');
  assert.equal(settings.originalVolume, 0.25);
  assert.equal(settings.dubVolume, 1);
});

test('volumes preserve intentional zero, parse numeric strings and clamp excessive values', async () => {
  const store = settingsStore({ originalVolume: '0', dubVolume: '1.25' });
  const settings = await store.ntGetSettings();
  assert.equal(settings.originalVolume, 0);
  assert.equal(settings.dubVolume, 1.25);
  await store.ntSetSettings({ originalVolume: 8, dubVolume: 4 });
  assert.equal(store.data.originalVolume, 1);
  assert.equal(store.data.dubVolume, 1.5);
});

test('blank, boolean and nonfinite volumes do not become accidental mute settings', async () => {
  for (const value of ['', ' ', false, true, NaN, Infinity, 'Infinity']) {
    const store = settingsStore({ originalVolume: value, dubVolume: value });
    const settings = await store.ntGetSettings();
    assert.equal(settings.originalVolume, 0.25);
    assert.equal(settings.dubVolume, 1);
    await store.ntSetSettings({ dubVolume: value });
    assert.equal(store.data.dubVolume, 1);
  }
});

test('normalizing stored providers preserves secrets, model names, manual voices and session history', async () => {
  const store = settingsStore({ source: 'captions', voice: 'gemini', geminiApiKey: ' original-key ',
    geminiModel: 'my-manual-model', browserVoiceName: 'Custom OS Voice', elevenVoiceId: 'manual-id',
    elevenVoiceName: 'My voice', nt_sessions: [{ domain: 'video.example' }] });
  const settings = await store.ntGetSettings();
  assert.equal(settings.voice, 'browser');
  assert.equal(settings.geminiApiKey, ' original-key ');
  assert.equal(settings.geminiModel, 'my-manual-model');
  assert.equal(settings.browserVoiceName, 'Custom OS Voice');
  assert.equal(settings.elevenVoiceId, 'manual-id');
  assert.equal(settings.elevenVoiceName, 'My voice');
  await store.ntSetSettings({ dubVolume: 0.5 });
  assert.deepEqual(store.data.nt_sessions, [{ domain: 'video.example' }]);
  assert.equal(store.data.geminiApiKey, ' original-key ');
});

test('partial voice writes do not implicitly change the source or user voice names', async () => {
  const store = settingsStore({ source: 'gemini', geminiApiKey: 'key', browserVoiceName: 'Selected voice' });
  await store.ntSetSettings({ voice: 'google' });
  assert.equal(store.data.source, 'gemini');
  assert.equal(store.data.voice, 'google');
  assert.equal(store.data.browserVoiceName, 'Selected voice');
  await store.ntSetSettings({ voice: 'invalid' });
  assert.equal(store.data.voice, 'browser');
});

test('whitespace does not satisfy the Gemini key requirement', () => {
  const store = settingsStore();
  assert.deepEqual(Array.from(store.ntValidate({ source: 'gemini', voice: 'browser', geminiApiKey: '   ' })), ['needGeminiKey']);
});

for (const [voice, key, problem] of [
  ['elevenlabs', 'elevenApiKey', 'needElevenKey'],
  ['yandex', 'yandexApiKey', 'needYandexKey']
]) {
  test(`${voice} rejects blank or nonstring credentials before starting`, () => {
    const store = settingsStore();
    for (const value of ['   ', '\t\n', true, 123, {}]) {
      const settings = { ...store.NT_DEFAULTS, voice, [key]: value, elevenVoiceId: 'voice-id' };
      assert.deepEqual(Array.from(store.ntValidate(settings)), [problem]);
    }
  });
}

test('ElevenLabs requires a nonblank string voice ID when a key is present', () => {
  const store = settingsStore();
  for (const elevenVoiceId of ['   ', true, 123]) {
    assert.deepEqual(Array.from(store.ntValidate({ ...store.NT_DEFAULTS,
      voice: 'elevenlabs', elevenApiKey: 'test-key', elevenVoiceId })), ['needElevenVoice']);
  }
});

test('ElevenLabs delivery settings clamp numbers, preserve zero and repair invalid storage', async () => {
  const store = settingsStore({ elevenStability: '0', elevenSimilarity: '0.7', elevenSpeakerBoost: false });
  let settings = await store.ntGetSettings();
  assert.equal(settings.elevenStability, 0);
  assert.equal(settings.elevenSimilarity, 0.7);
  await store.ntSetSettings({ elevenStability: 5, elevenSimilarity: -2 });
  assert.equal(store.data.elevenStability, 1);
  assert.equal(store.data.elevenSimilarity, 0);
  await store.ntSetSettings({ elevenStability: null, elevenSimilarity: false });
  settings = await store.ntGetSettings();
  assert.equal(settings.elevenStability, 0.5);
  assert.equal(settings.elevenSimilarity, 0.75);
});
