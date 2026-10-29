const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const flush = () => new Promise(setImmediate);

class Element {
  constructor(tagName = 'div', attributes = '') {
    this.tagName = tagName;
    this.attributes = Object.fromEntries(Array.from(attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g), m => [m[1], m[2] ?? '']));
    this.id = this.attributes.id || '';
    this.type = this.attributes.type || (tagName === 'select' ? 'select-one' : 'text');
    this.value = this.attributes.value || '';
    this.dataset = Object.fromEntries(Object.entries(this.attributes).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value]));
    this.textContent = '';
    this.checked = false;
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
    const classes = new Set((this.attributes.class || '').split(/\s+/));
    this.classList = {
      add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key),
      toggle(key, enabled = !classes.has(key)) { enabled ? classes.add(key) : classes.delete(key); }
    };
  }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  dispatchEvent(event) {
    event.target ||= this;
    return Promise.all((this.listeners.get(event.type) || []).map(listener => listener(event)));
  }
  appendChild(child) { this.children.push(child); }
  closest() { return null; }
  querySelector(selector) { return this.children.find(child => selector === `[value="${child.value}"]`) || null; }
  hasAttribute(name) { return name in this.attributes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  get selectedOptions() { return this.children.filter(child => child.value === this.value); }
}

function pageHarness({ initial = {}, active = false, page = 'popup', readError = '' } = {}) {
  const html = fs.readFileSync(`src/${page}/${page}.html`, 'utf8');
  const elements = Array.from(html.matchAll(/<(\w+)\b([^>]*)>/g), m => new Element(m[1], m[2]));
  const byId = id => elements.find(el => el.id === id);
  const matches = (el, selector) => {
    if (selector === 'input[name=source]') return el.tagName === 'input' && el.attributes.name === 'source';
    const match = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    return !!match && el.hasAttribute(match[1]) && (match[2] === undefined || el.attributes[match[1]] === match[2]);
  };
  if (page === 'popup') byId('voiceSelect').children = elements.filter(el => el.tagName === 'option');
  const document = {
    getElementById: byId, documentElement: {}, createElement: tagName => new Element(tagName),
    querySelectorAll: selector => elements.filter(el => matches(el, selector)),
    querySelector: selector => elements.find(el => matches(el, selector)) || null
  };
  const data = { uiLang: 'en', ...initial };
  const writes = [], reads = [], pendingWrites = [], storageListeners = [], messageListeners = [];
  let holdReads = false, holdWrites = false, nextWriteError = '', nextReadError = readError;
  const runtime = {
    onMessage: { addListener: listener => messageListeners.push(listener) },
    sendMessage: async message => message.type === 'NT_GET_STATE' ? { state: { active, status: active ? 'listening' : 'idle' } } : { ok: true, voices: [] },
    getManifest: () => ({ version: 'test' }), openOptionsPage: async () => {}, getURL: value => value
  };
  const emit = (changes, area = 'local') => storageListeners.forEach(listener => listener(changes, area));
  const chrome = { runtime, tabs: { query: async () => [{ id: 7, url: 'https://video.example/watch' }], get: async () => null, create: async () => {} },
    storage: { onChanged: { addListener: listener => storageListeners.push(listener) }, local: {
      get(defaults, callback) {
        const entries = typeof defaults === 'string' ? [[defaults, undefined]] : Object.entries(defaults);
        const snapshot = Object.fromEntries(entries.map(([key, fallback]) => [key, key in data ? data[key] : fallback]));
        const error = nextReadError;
        nextReadError = '';
        let resolveRead, rejectRead;
        const promise = callback ? undefined : new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
        const complete = () => {
          if (callback) {
            runtime.lastError = error && { message: error };
            callback(snapshot);
            delete runtime.lastError;
          } else if (error) rejectRead(new Error(error));
          else resolveRead(snapshot);
        };
        if (holdReads) reads.push(complete);
        else complete();
        return promise;
      },
      set(patch, callback) {
        writes.push({ ...patch });
        const error = nextWriteError;
        nextWriteError = '';
        const complete = () => {
          if (!error) {
            const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { oldValue: data[key], newValue }]));
            Object.assign(data, patch);
            emit(changes);
          }
          runtime.lastError = error && { message: error };
          callback();
          delete runtime.lastError;
        };
        if (holdWrites) pendingWrites.push(complete);
        else complete();
      }
    } }
  };
  const context = vm.createContext({ chrome, document, navigator: { language: 'en' }, location: { search: '' }, URLSearchParams,
    window: { addEventListener() {} }, AbortController,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    confirm: () => true, NT_YANDEX_VOICES: { ru: ['marina'] }, fetch() { throw new Error('Network is forbidden in UI tests'); } });
  context.self = context;
  for (const file of ['src/shared/settings.js', 'src/shared/languages.js', 'src/shared/i18n.js', `src/${page}/${page}.js`]) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return { data, writes, reads, pendingWrites, context, byId, elements,
    radio: value => elements.find(el => el.attributes.name === 'source' && el.value === value),
    field: key => elements.find(el => el.dataset.key === key),
    async change(el, value, type = 'change') { if (el.type === 'checkbox') el.checked = value; else el.value = value; await el.dispatchEvent({ type }); await flush(); },
    external(patch, area = 'local') {
      const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { oldValue: data[key], newValue }]));
      if (area === 'local') Object.assign(data, patch);
      emit(changes, area);
    },
    holdReads(value) { holdReads = value; }, holdWrites(value) { holdWrites = value; },
    failWrite(message) { nextWriteError = message; }, failRead(message) { nextReadError = message; }
  };
}

test('source controls remain usable while translation is active', async () => {
  const h = pageHarness({ active: true });
  await flush();
  assert.equal(h.radio('captions').disabled, false);
  assert.equal(h.radio('gemini').disabled, false);
});

test('selecting Gemini source preserves a deliberately chosen browser voice', async () => {
  const h = pageHarness({ initial: { voice: 'browser', geminiApiKey: 'key' } });
  await flush();
  await h.change(h.radio('gemini'), 'gemini');
  assert.deepEqual(h.writes, [{ source: 'gemini' }]);
  assert.equal(h.byId('voiceSelect').value, 'browser');
});

for (const voice of ['browser', 'google', 'off']) {
  test(`selecting free ${voice} without a Gemini key saves captions in the same patch`, async () => {
    const h = pageHarness({ initial: { source: 'gemini', voice: 'gemini', geminiApiKey: '   ' } });
    await flush();
    await h.change(h.byId('voiceSelect'), voice);
    assert.deepEqual(h.writes, [{ voice, source: 'captions' }]);
    assert.equal(h.radio('captions').checked, true);
    assert.equal(h.byId('toggleBtn').disabled, false);
  });
}

test('selecting free speech with a real key preserves Gemini as the input source', async () => {
  const h = pageHarness({ initial: { source: 'gemini', voice: 'gemini', geminiApiKey: 'user-key' } });
  await flush();
  await h.change(h.byId('voiceSelect'), 'google');
  assert.deepEqual(h.writes, [{ voice: 'google' }]);
  assert.equal(h.radio('gemini').checked, true);
});

test('leaving Gemini source resets only an incompatible Gemini voice', async () => {
  const h = pageHarness({ initial: { source: 'gemini', voice: 'gemini', geminiApiKey: 'key' } });
  await flush();
  await h.change(h.radio('captions'), 'captions');
  assert.deepEqual(h.writes, [{ source: 'captions', voice: 'browser' }]);
  assert.equal(h.byId('voiceSelect').value, 'browser');
});

test('popup follows external local settings, including removed keys, without reacting to sync storage', async () => {
  const h = pageHarness();
  await flush();
  h.external({ source: 'gemini', voice: 'google', geminiApiKey: 'key', targetLang: 'de', uiLang: 'ru', dubVolume: 0.4 });
  await flush();
  assert.equal(h.radio('gemini').checked, true);
  assert.equal(h.byId('voiceSelect').value, 'google');
  assert.equal(h.byId('targetLang').value, 'de');
  assert.equal(h.byId('dubVolVal').textContent, '40%');
  assert.equal(h.byId('uiLangBtn').textContent, 'RU');
  h.external({ voice: 'yandex' }, 'sync');
  await flush();
  assert.equal(h.byId('voiceSelect').value, 'google');
  delete h.data.dubVolume;
  h.external({ dubVolume: undefined });
  delete h.data.dubVolume;
  await flush();
  assert.equal(h.byId('dubVolVal').textContent, '100%');
});

test('a delayed external refresh cannot overwrite a newer user selection', async () => {
  const h = pageHarness({ initial: { voice: 'browser' } });
  await flush();
  h.holdReads(true);
  h.external({ voice: 'google' });
  await flush();
  assert.equal(h.reads.length, 1, 'the external change must start a real settings refresh');
  const staleRead = h.reads.shift();
  const selection = h.change(h.byId('voiceSelect'), 'off');
  await flush();
  assert.equal(h.data.voice, 'off');
  for (const complete of h.reads.splice(0)) complete();
  await selection;
  staleRead();
  await flush();
  assert.equal(h.byId('voiceSelect').value, 'off');
});

test('pending writes preserve the newest selection and persist in order', async () => {
  const h = pageHarness();
  await flush();
  h.holdWrites(true);
  const first = h.change(h.byId('voiceSelect'), 'google');
  await flush();
  const second = h.change(h.byId('voiceSelect'), 'off');
  await flush();
  assert.deepEqual(h.writes, [{ voice: 'google' }], 'later writes must wait for the current storage callback');
  h.pendingWrites.shift()();
  await flush();
  assert.equal(h.byId('voiceSelect').value, 'off');
  h.pendingWrites.shift()();
  await Promise.all([first, second]);
  assert.equal(h.data.voice, 'off');
});

test('save failure is visible, reverts the unsaved selection and does not reject the UI event', async () => {
  const h = pageHarness({ initial: { voice: 'google' } });
  await flush();
  h.failWrite('Storage quota exceeded');
  await h.change(h.byId('voiceSelect'), 'browser');
  assert.equal(h.data.voice, 'google');
  assert.equal(h.byId('voiceSelect').value, 'google');
  assert.equal(h.byId('problem').classList.contains('hidden'), false);
  assert.match(h.byId('problemText').textContent, /Storage quota exceeded/);
  assert.equal(h.byId('problemFix').classList.contains('hidden'), true);
  await h.change(h.byId('voiceSelect'), 'off');
  assert.equal(h.byId('problem').classList.contains('hidden'), true);
});

test('a failed language save restores the saved UI language', async () => {
  const h = pageHarness();
  await flush();
  h.failWrite('Storage unavailable');
  await h.byId('uiLangBtn').dispatchEvent({ type: 'click' });
  await flush();
  assert.equal(h.byId('uiLangBtn').textContent, 'EN');
  assert.match(h.byId('problemText').textContent, /Storage unavailable/);
});

test('options saving reports storage failure rather than showing Saved', async () => {
  const h = pageHarness({ page: 'options', initial: { browserVoiceName: 'Manual voice' } });
  await flush();
  h.failWrite('Storage quota exceeded');
  await h.change(h.field('browserVoiceName'), 'Other voice');
  assert.match(h.byId('toast').textContent, /Storage quota exceeded/);
  assert.equal(h.field('browserVoiceName').value, 'Manual voice');
});

test('options manual ElevenLabs voice save reports failure and preserves the saved voice', async () => {
  const h = pageHarness({ page: 'options', initial: { elevenVoiceId: 'manual-id', elevenVoiceName: 'Manual voice' } });
  await flush();
  const option = new Element('option'); option.value = 'new-id'; option.textContent = 'New voice';
  h.byId('elevenVoice').appendChild(option);
  h.failWrite('Storage unavailable');
  await h.change(h.byId('elevenVoice'), 'new-id');
  assert.match(h.byId('toast').textContent, /Storage unavailable/);
  assert.equal(h.byId('elevenVoice').value, 'manual-id');
  assert.equal(h.data.elevenVoiceName, 'Manual voice');
});

test('a newer external settings snapshot wins even if an older read finishes last', async () => {
  const h = pageHarness();
  await flush();
  h.holdReads(true);
  h.external({ voice: 'google' });
  h.external({ voice: 'off' });
  assert.equal(h.reads.length, 2);
  h.reads.pop()();
  await flush();
  h.reads.pop()();
  await flush();
  assert.equal(h.byId('voiceSelect').value, 'off');
});

test('a popup storage read failure is visible and leaves Start disabled', async () => {
  const h = pageHarness({ readError: 'Storage unavailable' });
  await flush();
  assert.match(h.byId('problemText').textContent, /Storage unavailable/);
  assert.equal(h.byId('toggleBtn').disabled, true);
});

test('an options storage read failure is visible instead of rejecting initialization', async () => {
  const h = pageHarness({ page: 'options', readError: 'Storage unavailable' });
  await flush();
  assert.match(h.byId('toast').textContent, /Storage unavailable/);
});

test('failed clearing of statistics reports storage failure and preserves history', async () => {
  const h = pageHarness({ page: 'options', initial: { nt_sessions: [{ durationSec: 42 }] } });
  await flush();
  h.failWrite('Storage unavailable');
  await h.byId('clearBtn').dispatchEvent({ type: 'click' });
  assert.match(h.byId('toast').textContent, /Storage unavailable/);
  assert.deepEqual(h.data.nt_sessions, [{ durationSec: 42 }]);
});

test('options follows settings changed in another extension page', async () => {
  const h = pageHarness({ page: 'options' });
  await flush();
  h.external({ browserRate: 1.6, uiLang: 'ru', targetLang: 'de' });
  await flush();
  assert.equal(Number(h.field('browserRate').value), 1.6);
  assert.equal(h.field('uiLang').value, 'ru');
  let request;
  h.context.chrome.runtime.sendMessage = async message => { request = message; return { ok: true }; };
  await h.elements.find(el => el.dataset.test === 'browser').dispatchEvent({ type: 'click' });
  assert.equal(request.lang, 'de-DE');
});

test('options external refresh preserves pending edits and newer snapshots win', async () => {
  const h = pageHarness({ page: 'options' });
  await flush();
  h.holdWrites(true);
  const edit = h.change(h.field('browserRate'), '1.35', 'input');
  await flush();
  h.holdReads(true);
  h.external({ browserRate: 1.7, showOriginal: false });
  h.external({ showOriginal: true });
  assert.equal(h.reads.length, 2);
  h.reads.pop()();
  await flush();
  h.reads.pop()();
  await flush();
  assert.equal(Number(h.field('browserRate').value), 1.35);
  assert.equal(h.field('showOriginal').checked, true);
  h.holdReads(false);
  h.pendingWrites.shift()();
  await edit;
  assert.equal(h.data.browserRate, 1.35);
  assert.equal(h.field('showOriginal').checked, true);
});

test('options disables every test sharing a result slot until the request settles', async () => {
  const h = pageHarness({ page: 'options' });
  await flush();
  let finish;
  h.context.chrome.runtime.sendMessage = () => new Promise(resolve => { finish = resolve; });
  const browser = h.elements.find(el => el.dataset.test === 'browser');
  const google = h.elements.find(el => el.dataset.test === 'google');
  const click = browser.dispatchEvent({ type: 'click' });
  const disabledDuringRequest = [browser.disabled, google.disabled];
  finish({ ok: false, error: 'browserVoiceUnavailable' });
  await click;
  assert.deepEqual(disabledDuringRequest, [true, true]);
  assert.equal(browser.disabled, false);
  assert.equal(google.disabled, false);
  assert.match(h.context.document.querySelector('[data-result="free"]').className, /bad/);
});

test('Yandex connection test reports an unsupported target instead of testing Russian', async () => {
  const h = pageHarness({ page: 'options', initial: { targetLang: 'fr', yandexApiKey: 'test-key' } });
  await flush();
  h.context.ntYandexSupports = () => false;
  h.context.ntYandexTts = async () => new ArrayBuffer(0);
  h.context.AudioContext = class { destination = {}; };
  h.context.NtAudioPlayer = class { enqueuePcm16() {} };
  await h.elements.find(el => el.dataset.test === 'yandex').dispatchEvent({ type: 'click' });
  const result = h.context.document.querySelector('[data-result="yandex"]');
  assert.match(result.className, /bad/);
  assert.match(result.textContent, /SpeechKit/);
});

test('options export reports history read failure without rejecting the click', async () => {
  const h = pageHarness({ page: 'options' });
  await flush();
  h.failRead('History storage unavailable');
  await assert.doesNotReject(h.byId('exportBtn').dispatchEvent({ type: 'click' }));
  assert.match(h.byId('toast').textContent, /History storage unavailable/);
  assert.equal(h.byId('toast').attributes.role, 'alert');
});

test('balanced ElevenLabs settings save atomically without replacing the selected voices or key', async () => {
  const h = pageHarness({ page: 'options', initial: { elevenApiKey: 'my-key', elevenVoiceId: 'narrator', elevenVoiceId2: 'guest' } });
  await flush();
  await h.byId('elevenBalanced').dispatchEvent({ type: 'click' });
  await flush();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0], { elevenModel: 'eleven_v4_turbo', elevenStability: 0.5,
    elevenSimilarity: 0.75, elevenSpeakerBoost: false, elevenContinuity: true });
  assert.equal(h.data.elevenApiKey, 'my-key');
  assert.equal(h.data.elevenVoiceId, 'narrator');
  assert.equal(h.data.elevenVoiceId2, 'guest');
});

test('ElevenLabs controls follow model capabilities when another window changes the model', async () => {
  const h = pageHarness({ page: 'options', initial: { elevenModel: 'eleven_v3' } });
  await flush();
  assert.equal(h.byId('elevenSimilarity').disabled, true);
  assert.equal(h.byId('elevenSpeakerBoost').disabled, true);
  h.external({ elevenModel: 'eleven_v4_turbo' });
  await flush();
  assert.equal(h.byId('elevenSimilarity').disabled, true);
  assert.equal(h.byId('elevenSpeakerBoost').disabled, true);
  h.external({ elevenModel: 'eleven_flash_v2_5' });
  await flush();
  assert.equal(h.byId('elevenSpeakerBoost').disabled, false);
});
