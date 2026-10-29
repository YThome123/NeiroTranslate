const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const flush = () => new Promise(setImmediate);

class Element {
  constructor(tagName = 'div', attributes = '') {
    this.tagName = tagName;
    this.id = attributes.match(/\bid="([^"]*)"/)?.[1] || '';
    this.dataset = { days: attributes.match(/\bdata-days="([^"]*)"/)?.[1] };
    this.textContent = '';
    this.hidden = /\bhidden\b/.test(attributes);
    this.style = {};
    this.children = [];
    this.parts = new Map();
    this.listeners = new Map();
    this.classList = { toggle() {} };
  }
  set innerHTML(value) { this.children = []; this.parts.clear(); }
  appendChild(child) { this.children.push(child); }
  querySelector(selector) {
    if (!this.parts.has(selector)) this.parts.set(selector, new Element());
    return this.parts.get(selector);
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  closest(selector) { return selector === 'button' && this.tagName === 'button' ? this : null; }
}

function statsPage({ initial = {}, historyError = '', settingsError = '', holdHistoryReads = false } = {}) {
  const html = fs.readFileSync('src/stats/stats.html', 'utf8');
  const elements = Array.from(html.matchAll(/<(\w+)\b([^>]*)>/g), m => new Element(m[1], m[2]));
  const byId = id => elements.find(el => el.id === id);
  const document = { getElementById: byId, documentElement: {}, createElement: tag => new Element(tag),
    querySelectorAll: selector => selector === '#filters button' ? elements.filter(el => el.tagName === 'button') : [] };
  const data = { uiLang: 'en', nt_sessions: [], ...initial };
  const runtime = {};
  const listeners = [], reads = [];
  const chrome = { runtime, storage: { onChanged: { addListener: listener => listeners.push(listener) }, local: {
    get(defaults, callback) {
      const history = Object.hasOwn(defaults, 'nt_sessions');
      const snapshot = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, key in data ? data[key] : fallback]));
      const complete = () => {
        runtime.lastError = (history ? historyError : settingsError) ? { message: history ? historyError : settingsError } : undefined;
        callback(snapshot);
        delete runtime.lastError;
      };
      if (history && holdHistoryReads) reads.push(complete);
      else complete();
    }
  } } };
  const context = vm.createContext({ chrome, document, navigator: { language: 'en' } });
  context.self = context;
  for (const file of ['src/shared/settings.js', 'src/shared/languages.js', 'src/shared/i18n.js', 'src/stats/stats.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return { byId, reads,
    filter(days) { byId('filters').listeners.get('click')({ target: elements.find(el => el.dataset.days === days) }); },
    update(sessions, area = 'local') {
      if (area === 'local') data.nt_sessions = sessions;
      listeners.forEach(listener => listener({ nt_sessions: { newValue: sessions } }, area));
    }
  };
}

const session = (daysAgo = 0) => ({ startTime: Date.now() - daysAgo * 864e5,
  durationSec: 120, lang: 'ru', domain: 'video.example', source: 'captions', voice: 'browser' });

test('an open stats page follows history resets and retains its selected filter', async () => {
  const h = statsPage({ initial: { nt_sessions: [session(1), session(10)] } });
  await flush();
  assert.equal(h.byId('kSessions').textContent, 2);
  h.filter('7');
  assert.equal(h.byId('kSessions').textContent, 1);
  h.update([]);
  assert.equal(h.byId('kSessions').textContent, 0);
  assert.equal(h.byId('kTime').textContent, '0s');
  assert.equal(h.byId('heat').children.some(el => el.className), false);
  h.update([session(1), session(10)]);
  assert.equal(h.byId('kSessions').textContent, 1);
  h.update([], 'sync');
  assert.equal(h.byId('kSessions').textContent, 1);
  h.update(undefined);
  assert.equal(h.byId('kSessions').textContent, 0);
});

test('a delayed stats load cannot restore history cleared after the read began', async () => {
  const h = statsPage({ initial: { nt_sessions: [session()] }, holdHistoryReads: true });
  await flush();
  h.update([]);
  h.reads.shift()();
  await flush();
  assert.equal(h.byId('kSessions').textContent, 0);
});

test('a filter chosen during the initial history load remains selected', async () => {
  const h = statsPage({ initial: { nt_sessions: [session(1), session(10)] }, holdHistoryReads: true });
  await flush();
  h.filter('7');
  h.reads.shift()();
  await flush();
  assert.equal(h.byId('kSessions').textContent, 1);
});

test('stats history read errors are visible and a subsequent update recovers', async () => {
  const h = statsPage({ historyError: 'History storage unavailable' });
  await flush();
  const error = h.byId('error');
  assert.ok(error && !error.hidden, 'storage failure must be visible');
  assert.match(error.textContent, /History storage unavailable/);
  h.update([session()]);
  assert.equal(error.hidden, true);
  assert.equal(h.byId('kSessions').textContent, 1);
});

test('stats settings read errors are shown instead of rejecting initialization', async () => {
  const h = statsPage({ settingsError: 'Settings storage unavailable' });
  await flush();
  const error = h.byId('error');
  assert.ok(error && !error.hidden, 'settings failure must be visible');
  assert.match(error.textContent, /Settings storage unavailable/);
});
