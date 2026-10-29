const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const flush = () => new Promise(setImmediate);

function historyHarness(initial = []) {
  let sessions = structuredClone(initial);
  const reads = [], writes = [], warnings = [], listeners = [];
  let lastError, errorReads = 0, stopped = 0;
  const listener = { addListener() {} };
  const runtime = { onMessage: listener, onInstalled: listener,
    getURL: path => path, getContexts: async () => [], sendMessage: async () => {} };
  Object.defineProperty(runtime, 'lastError', { get() { if (lastError) errorReads++; return lastError; } });
  const notify = (value, area = 'local') => {
    const oldValue = sessions;
    if (area === 'local') sessions = structuredClone(value);
    return Promise.all(listeners.map(fn => fn({ nt_sessions: { oldValue, newValue: value } }, area)));
  };
  const callbackWithError = (error, callback) => {
    lastError = error ? { message: error } : undefined;
    try { callback(); } finally { lastError = undefined; }
  };
  const context = vm.createContext({ console: { warn: (...args) => warnings.push(args.join(' ')), error: (...args) => warnings.push(args.join(' ')) },
    URL, AbortController, crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout, importScripts() {},
    chrome: {
      runtime,
      storage: { session: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener: fn => listeners.push(fn) }, local: {
          get(defaults, callback) {
            const snapshot = structuredClone(sessions);
            reads.push({ complete(error = '') {
              callbackWithError(error, () => callback(error ? undefined : { nt_sessions: snapshot }));
            } });
          },
          set(patch, callback) {
            const value = structuredClone(patch.nt_sessions);
            let committed = false;
            const write = {
              commit() { if (!committed) { committed = true; return notify(value); } },
              complete(error = '') {
                if (!error) write.commit();
                callbackWithError(error, () => callback?.());
              }
            };
            writes.push(write);
          }
        } },
      tabs: { sendMessage: async () => ({}), onRemoved: listener, onUpdated: listener },
      action: { setBadgeText: async () => {} }, tts: { stop() { stopped++; } }, commands: { onCommand: listener }
    }
  });
  for (const file of ['src/shared/speech-queue.js', 'src/shared/speech-timing.js', 'src/shared/speakers.js', 'src/background/background.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return { context, reads, writes, warnings, notify,
    get sessions() { return structuredClone(sessions); },
    get errorReads() { return errorReads; },
    get stopped() { return stopped; },
    record(domain, elapsed = 10000) {
      context.recordSession({ startedAt: Date.now() - elapsed, targetLang: 'ru', domain, source: 'captions', voice: 'browser' });
    }
  };
}

test('concurrent history records serialize the entire read/write operation without losing sessions', async () => {
  const h = historyHarness([{ id: 'existing', domain: 'existing.example' }]);
  h.record('first.example');
  h.record('second.example');
  await flush();
  assert.equal(h.reads.length, 1, 'the second record must not read before the first write completes');
  h.reads.shift().complete();
  await flush();
  assert.equal(h.reads.length, 0);
  h.writes.shift().complete();
  await flush();
  h.reads.shift().complete();
  await flush();
  h.writes.shift().complete();
  await flush();
  assert.deepEqual(h.sessions.map(s => s.domain), ['second.example', 'first.example', 'existing.example']);
  assert.equal(h.sessions[1].durationSec, 10);
  assert.equal(h.sessions[1].lang, 'ru');
});

for (const [name, clearedValue] of [['clearing', []], ['removing', undefined]]) {
  test(`${name} history invalidates an older read and queued records but preserves a later session`, async () => {
    const h = historyHarness([{ id: 'existing', domain: 'existing.example' }]);
    h.record('before-reset.example');
    h.record('queued-before-reset.example');
    await flush();
    const staleRead = h.reads.shift();
    await h.notify(clearedValue);
    h.record('after-reset.example');
    staleRead.complete();
    await flush();
    assert.equal(h.writes.length, 0, 'a pre-reset read must never write its old snapshot');
    assert.equal(h.reads.length, 1, 'only the post-reset record may read history');
    h.reads.shift().complete();
    await flush();
    h.writes.shift().complete();
    await flush();
    assert.deepEqual(h.sessions.map(s => s.domain), ['after-reset.example']);
  });
}

test('a delayed callback for a committed pre-reset write cannot cancel a post-reset record', async () => {
  const h = historyHarness();
  h.record('before-reset.example');
  await flush();
  h.reads.shift().complete();
  await flush();
  const oldWrite = h.writes.shift();
  await oldWrite.commit();
  await h.notify([]);
  h.record('after-reset.example');
  await flush();
  assert.equal(h.reads.length, 0, 'the history queue must still wait for the old callback');
  oldWrite.complete();
  await flush();
  h.reads.shift().complete();
  await flush();
  h.writes.shift().complete();
  await flush();
  assert.deepEqual(h.sessions.map(s => s.domain), ['after-reset.example']);
});

test('history read failures consume lastError, report the failure and release the next record', async () => {
  const h = historyHarness([{ id: 'existing', domain: 'existing.example' }]);
  h.record('failed.example');
  await flush();
  assert.doesNotThrow(() => h.reads.shift().complete('History read unavailable'));
  await flush();
  assert.equal(h.errorReads, 1);
  assert.match(h.warnings.join('\n'), /History read unavailable/);
  assert.equal(h.writes.length, 0);
  h.record('recovered.example');
  await flush();
  h.reads.shift().complete();
  await flush();
  h.writes.shift().complete();
  await flush();
  assert.deepEqual(h.sessions.map(s => s.domain), ['recovered.example', 'existing.example']);
});

test('history write failures consume lastError, report the failure and do not poison the queue', async () => {
  const h = historyHarness([{ id: 'existing', domain: 'existing.example' }]);
  h.record('failed.example');
  await flush();
  h.reads.shift().complete();
  await flush();
  h.writes.shift().complete('History quota exceeded');
  await flush();
  assert.equal(h.errorReads, 1);
  assert.match(h.warnings.join('\n'), /History quota exceeded/);
  h.record('recovered.example');
  await flush();
  h.reads.shift().complete();
  await flush();
  h.writes.shift().complete();
  await flush();
  assert.deepEqual(h.sessions.map(s => s.domain), ['recovered.example', 'existing.example']);
});

test('a failed stale history read still consumes its callback lastError after reset', async () => {
  const h = historyHarness();
  h.record('before-reset.example');
  await flush();
  await h.notify([]);
  assert.doesNotThrow(() => h.reads.shift().complete('Old history read failed'));
  await flush();
  assert.equal(h.errorReads, 1);
  assert.match(h.warnings.join('\n'), /Old history read failed/);
  assert.deepEqual(h.sessions, []);
  assert.equal(h.writes.length, 0);
});

test('sync history notifications do not invalidate local history records', async () => {
  const h = historyHarness();
  h.record('local.example');
  await flush();
  await h.notify([], 'sync');
  h.reads.shift().complete();
  await flush();
  h.writes.shift().complete();
  await flush();
  assert.deepEqual(h.sessions.map(s => s.domain), ['local.example']);
});

test('history persistence keeps the 2000-session cap and ignores sessions under three seconds', async () => {
  const h = historyHarness(Array.from({ length: 2000 }, (_, i) => ({ id: String(i), domain: `saved-${i}.example` })));
  h.record('too-short.example', 1000);
  await flush();
  assert.equal(h.reads.length, 0);
  h.record('latest.example');
  await flush();
  h.reads.shift().complete();
  await flush();
  h.writes.shift().complete();
  await flush();
  assert.equal(h.sessions.length, 2000);
  assert.equal(h.sessions[0].domain, 'latest.example');
  assert.equal(h.sessions.at(-1).domain, 'saved-1998.example');
});

test('Stop finishes without waiting for a pending history read', async () => {
  const h = historyHarness();
  await flush();
  vm.runInContext("state = {...IDLE_STATE, active: true, startedAt: Date.now() - 10000, source: 'captions'}", h.context);
  let finished = false;
  const stopping = h.context.stop().then(() => { finished = true; });
  await flush();
  assert.equal(finished, true);
  assert.equal(h.stopped, 1);
  assert.equal(h.reads.length, 1);
  assert.equal(vm.runInContext('state.active', h.context), false);
  await stopping;
});
