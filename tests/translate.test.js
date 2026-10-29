const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function translator(fetch, globals = {}) {
  const ctx = vm.createContext({ self:{}, fetch, AbortSignal, AbortController, TextEncoder, setTimeout, clearTimeout, console:{warn() {}}, ...globals });
  vm.runInContext(fs.readFileSync('src/shared/translate.js', 'utf8'), ctx);
  return ctx.self.ntTranslate;
}

function translationClock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  const schedule = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, {at:now + delay, callback});
    return id;
  };
  const cancel = id => timers.delete(id);
  const globals = {
    setTimeout:schedule, clearTimeout:cancel,
    AbortSignal:{
      timeout(delay) {
        const controller = new AbortController();
        schedule(() => controller.abort(new DOMException('Provider timed out', 'TimeoutError')), delay);
        return controller.signal;
      },
      any: signals => AbortSignal.any(signals)
    }
  };
  return {
    globals, now:() => now,
    async advance(delay) {
      const until = now + delay;
      for (;;) {
        // Drain provider promises before choosing the next scheduled event.
        await new Promise(setImmediate);
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = until;
      await new Promise(setImmediate);
    },
    responseAfter(delay, response, signal) {
      return new Promise((resolve, reject) => {
        const onAbort = () => { cancel(timer); reject(signal.reason); };
        const timer = schedule(() => {
          signal.removeEventListener('abort', onAbort);
          resolve(response);
        }, delay);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, {once:true});
      });
    }
  };
}
test('Google response segments are joined and successful results are cached', async () => {
  let calls = 0;
  const translate = translator(async () => { calls++; return {ok:true, json:async () => [[['Добрый '],['день!']],null,'en']}; });
  assert.equal((await translate('Hello!', 'ru')).text, 'Добрый день!');
  assert.equal((await translate('Hello!', 'ru')).detected, 'en');
  assert.equal(calls, 1);
});

test('Google detected language metadata stays a string for downstream consumers and cache hits', async () => {
  for (const [detected, source, expected] of [
    [{language:'en'}, 'en-US', 'en-US'],
    [['en'], 'en-US', 'en-US'],
    [123, 'en', 'en'],
    [true, undefined, ''],
    [{language:'en'}, undefined, ''],
    [['en'], undefined, ''],
    [null, 'en', 'en'],
    [undefined, undefined, ''],
    ['', 'en', 'en'],
    ['de', 'en', 'de']
  ]) {
    let calls = 0;
    const translate = translator(async () => {
      calls++;
      return {ok:true, json:async () => [[['Привет']], null, detected]};
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await translate('Hello', 'ru', source);
      assert.equal(result.ok, true);
      assert.equal(result.text, 'Привет');
      assert.doesNotThrow(() => result.detected.split('-'), 'background language handling must preserve the translation');
      assert.equal(result.detected, expected);
    }
    assert.equal(calls, 1, 'cache hits must retain normalized language metadata');
  }
});

test('outage without a source hint returns an explicit failure, not a fake successful translation', async () => {
  const translate = translator(async () => { throw new Error('Network unavailable'); });
  const result = await translate('Hello!', 'ru');
  assert.equal(result.ok, false); assert.equal(result.text, 'Hello!');
});
test('MyMemory receives the known source language instead of autodetect', async () => {
  const urls = [];
  const translate = translator(async url => {
    urls.push(new URL(url));
    if (!url.includes('mymemory')) throw new Error('HTTP 429');
    return {ok:true, json:async () => ({responseData:{translatedText:'Привет!'}, responseStatus:200})};
  });
  assert.equal((await translate('Hello!', 'ru', 'en')).text, 'Привет!');
  assert.equal(urls.at(-1).searchParams.get('langpair'), 'en|ru');
});
test('fallback never silently truncates a long sentence', async () => {
  const translate = translator(async url => {
    if (!url.includes('mymemory')) throw new Error('HTTP 429');
    const text = new URL(url).searchParams.get('q');
    return {ok:true, json:async () => ({responseData:{translatedText:text}, responseStatus:200})};
  });
  const result = await translate('a'.repeat(600), 'ru', 'en');
  assert.equal(result.ok, false);
});

test('a blocked Google API host falls back to the second Google host without a source hint', async () => {
  const urls = [];
  const translate = translator(async url => {
    urls.push(url);
    if (url.includes('googleapis')) throw new Error('Blocked host');
    return {ok:true,json:async () => [[['Привет']],null,'en']};
  });
  assert.equal((await translate('Hello','ru')).ok, true);
  assert.ok(urls[1].startsWith('https://translate.google.com/'));
});

test('caller cancellation prevents fallback requests and late results', async () => {
  const abort = new AbortController(); let finish; const urls=[];
  const translate=translator(url => {urls.push(url);return new Promise(resolve => {finish=resolve;});});
  const pending=translate('Hello','ru','en',abort.signal);
  abort.abort();
  finish({ok:true,json:async () => [[['Поздно']],null,'en']});
  const result=await pending;
  assert.equal(result.cancelled,true);
  assert.equal(result.ok,false);
  assert.equal(urls.length,1);
});

test('missing target language fails without requesting or caching an untranslated Google response', async () => {
  let calls = 0;
  const translate = translator(async () => {
    calls++;
    return {ok:true, json:async () => [[['Hello', 'Hello']], null, 'en']};
  });
  for (const target of [undefined, null, '', '   ', 'auto']) {
    const result = await translate('Hello', target, 'en');
    assert.equal(result.ok, false, `target ${JSON.stringify(target)} must not report success`);
    assert.equal(result.error, 'freeTranslationUnavailable');
    assert.equal(result.text, 'Hello');
  }
  assert.equal(calls, 0);
});

test('blank MyMemory output fails instead of caching an invisible subtitle', async () => {
  let fallbackCalls = 0;
  const translate = translator(async url => {
    if (!url.includes('mymemory')) throw new Error('Google unavailable');
    fallbackCalls++;
    return {ok:true, json:async () => ({responseData:{translatedText:' \n '}, responseStatus:200, quotaFinished:false})};
  });
  assert.equal((await translate('Hello', 'ru', 'en')).ok, false);
  assert.equal((await translate('Hello', 'ru', 'en')).ok, false);
  assert.equal(fallbackCalls, 2, 'an invalid result must not suppress a later retry');
});

test('MyMemory quota flag cannot turn an HTTP 200 response into a successful subtitle', async () => {
  const translate = translator(async url => {
    if (!url.includes('mymemory')) throw new Error('Google unavailable');
    return {ok:true, json:async () => ({
      responseData:{translatedText:'USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY'},
      responseStatus:200, quotaFinished:true
    })};
  });
  const result = await translate('Hello', 'ru', 'en');
  assert.equal(result.ok, false);
  assert.equal(result.text, 'Hello');
  assert.equal(result.error, 'freeTranslationUnavailable');
});

test('MyMemory responseStatus must explicitly confirm a successful translation', async () => {
  const translate = translator(async url => {
    if (!url.includes('mymemory')) throw new Error('Google unavailable');
    return {ok:true, json:async () => ({responseData:{translatedText:'Invalid provider response'}})};
  });
  assert.equal((await translate('Hello', 'ru', 'en')).ok, false);
});

test('a timed-out Google request advances to the other host and caches its translation', async () => {
  const deadlines = [];
  const urls = [];
  const translate = translator((url, {signal}) => {
    urls.push(url);
    if (urls.length === 1) return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
    });
    return Promise.resolve({ok:true, json:async () => [[['Привет']], null, 'en']});
  }, {AbortSignal:{
    timeout() { const controller = new AbortController(); deadlines.push(controller); return controller.signal; },
    any: signals => AbortSignal.any(signals)
  }});
  const pending = translate('Hello', 'ru', '', new AbortController().signal);
  deadlines[0].abort(new DOMException('Provider timed out', 'TimeoutError'));
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Привет');
  assert.equal(new URL(urls[1]).host, 'translate.google.com');
  assert.equal((await translate('Hello', 'ru', '')).text, 'Привет');
  assert.equal(urls.length, 2);
});

test('all provider timeouts return a failure which can recover on the next caption', async () => {
  const deadlines = [];
  const urls = [];
  let recovered = false;
  const translate = translator((url, {signal}) => {
    urls.push(url);
    if (recovered) return Promise.resolve({ok:true, json:async () => [[['Привет']], null, 'en']});
    const deadline = deadlines.at(-1);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      queueMicrotask(() => deadline.abort(new DOMException('Provider timed out', 'TimeoutError')));
    });
  }, {AbortSignal:{
    timeout() { const controller = new AbortController(); deadlines.push(controller); return controller.signal; },
    any: signals => AbortSignal.any(signals)
  }});
  const result = await translate('Hello', 'ru', 'en');
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, undefined, 'a provider timeout is not caller cancellation');
  assert.equal(result.error, 'freeTranslationUnavailable');
  assert.equal(urls.length, 3);
  recovered = true;
  assert.equal((await translate('Hello', 'ru', 'en')).text, 'Привет');
  assert.equal(urls.length, 4);
});

test('an already cancelled caption makes no network request even when cached', async () => {
  let calls = 0;
  const translate = translator(async () => {
    calls++;
    return {ok:true, json:async () => [[['Привет']], null, 'en']};
  });
  await translate('Hello', 'ru', 'en');
  const controller = new AbortController(); controller.abort();
  const result = await translate('Hello', 'ru', 'en', controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(calls, 1);
});

test('cancellation of a pending fetch rejects promptly without calling a fallback', async () => {
  const controller = new AbortController();
  let calls = 0;
  const translate = translator((url, {signal}) => {
    calls++;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
    });
  });
  const pending = translate('Hello', 'ru', 'en', controller.signal);
  controller.abort();
  assert.equal((await pending).cancelled, true);
  assert.equal(calls, 1);
});

test('MyMemory is skipped when the source is missing or set to auto', async () => {
  for (const source of [undefined, '', 'auto']) {
    const urls = [];
    const translate = translator(async url => {
      urls.push(new URL(url));
      throw new Error('Google unavailable');
    });
    const result = await translate('Hello', 'ru', source);
    assert.equal(result.ok, false);
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => url.searchParams.get('sl') === 'auto'));
    assert.ok(urls.every(url => !url.host.includes('mymemory')));
  }
});

test('MyMemory preserves regional language hints and accepts its string success status', async () => {
  let request;
  const translate = translator(async (url, options) => {
    if (!url.includes('mymemory')) return {ok:false, status:429};
    request = new URL(url);
    assert.equal(options.credentials, 'omit');
    return {ok:true, json:async () => ({responseData:{translatedText:' Привет! '}, responseStatus:'200', quotaFinished:false})};
  });
  const result = await translate('Hello!', 'ru', 'en-US');
  assert.equal(result.text, 'Привет!');
  assert.equal(result.provider, 'mymemory');
  assert.equal(result.detected, 'en-US');
  assert.equal(request.searchParams.get('langpair'), 'en-US|ru');
});

test('MyMemory accepts 500 UTF-8 bytes and skips a 501-byte sentence without truncation', async () => {
  const sent = [];
  const translate = translator(async url => {
    if (!url.includes('mymemory')) throw new Error('Google unavailable');
    sent.push(new URL(url).searchParams.get('q'));
    return {ok:true, json:async () => ({responseData:{translatedText:'Translation'}, responseStatus:200, quotaFinished:false})};
  });
  const boundary = 'я'.repeat(250);
  assert.equal((await translate(boundary, 'en', 'ru')).ok, true);
  assert.equal((await translate(boundary + 'a', 'en', 'ru')).ok, false);
  assert.deepEqual(sent, [boundary]);
});

test('HTTP 200 MyMemory errors and quota messages cannot be spoken as translations', async () => {
  for (const [status, text] of [
    ['403', 'INVALID TARGET LANGUAGE'],
    [429, 'USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY'],
    [200, 'MYMEMORY WARNING: exhausted'],
    [200, 'QUERY LENGTH LIMIT EXCEEDED']
  ]) {
    const translate = translator(async url => {
      if (!url.includes('mymemory')) return {ok:false, status:429};
      return {ok:true, json:async () => ({responseData:{translatedText:text}, responseStatus:status, quotaFinished:status === 429})};
    });
    const result = await translate('Hello', 'ru', 'en');
    assert.equal(result.ok, false);
    assert.equal(result.text, 'Hello');
  }
});

test('malformed Google responses fall through to a healthy MyMemory provider', async () => {
  for (const payload of [null, {}, [[], null, 'en'], [[null], null, 'en']]) {
    const translate = translator(async url => ({ok:true, json:async () => url.includes('mymemory')
      ? {responseData:{translatedText:'Привет'}, responseStatus:200, quotaFinished:false}
      : payload}));
    const result = await translate('Hello', 'ru', 'en');
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'mymemory');
    assert.equal(result.text, 'Привет');
  }
});

test('malformed Google segments cannot be spoken or cached as translations', async () => {
  for (const payload of [
    [['Provider error string'], null, 'en'],
    [[[123]], null, 'en'],
    [[[{error:'Provider unavailable'}]], null, 'en'],
    [[['Partial translation'], [{error:'Invalid segment'}]], null, 'en']
  ]) {
    let calls = 0, recovered = false;
    const translate = translator(async () => {
      calls++;
      return {ok:true, json:async () => recovered ? [[['Привет']], null, 'en'] : payload};
    });
    const result = await translate('Hello', 'ru');
    assert.equal(result.ok, false, 'non-string segments must reject the whole response');
    assert.equal(result.text, 'Hello');
    recovered = true;
    assert.equal((await translate('Hello', 'ru')).text, 'Привет');
    assert.equal(calls, 3, 'an invalid response must not suppress a healthy retry');
  }
});

test('same-language output is legitimate and is not rejected just because text is unchanged', async () => {
  const translate = translator(async () => ({ok:true, json:async () => [[['Hello']], null, 'en']}));
  assert.equal((await translate('Hello', 'en', 'en')).ok, true);
});

test('translation cache separates source and target languages while normalizing caption spacing', async () => {
  const requests = [];
  const replies = ['First source', 'Other source', 'Other target'];
  const translate = translator(async url => {
    requests.push(new URL(url));
    const text = replies.shift();
    return {ok:true, json:async () => [[[text]], null, 'en']};
  });
  assert.equal((await translate(' Hello\n world ', 'ru', 'en')).text, 'First source');
  assert.equal((await translate('Hello world', 'ru', 'en')).text, 'First source');
  assert.equal((await translate('Hello world', 'ru', 'de')).text, 'Other source');
  assert.equal((await translate('Hello world', 'fr', 'en')).text, 'Other target');
  assert.equal(requests[0].searchParams.get('q'), 'Hello world');
  assert.equal(requests.length, 3);
});

test('a healthy MyMemory fallback is not held behind a stalled second Google host', async () => {
  let enteredGoogle;
  const googleStarted = new Promise(resolve => { enteredGoogle = resolve; });
  let secondarySignal;
  let fallbackStarted = false;
  const translate = translator((url, {signal}) => {
    if (url.includes('googleapis')) return Promise.reject(new Error('Primary unavailable'));
    if (url.includes('translate.google.com')) {
      secondarySignal = signal;
      enteredGoogle();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      });
    }
    fallbackStarted = true;
    return Promise.resolve({ok:true, json:async () => ({
      responseData:{translatedText:'Привет'}, responseStatus:200, quotaFinished:false
    })});
  });
  const pending = translate('Hello', 'ru', 'en');
  await googleStarted;
  assert.equal(fallbackStarted, true, 'MyMemory must start while the second Google request is pending');
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'mymemory');
  assert.equal(result.text, 'Привет');
  assert.equal(secondarySignal.aborted, true, 'the losing fallback must release its request');
});

test('a fast Google fallback cancels a stalled MyMemory request', async () => {
  let memorySignal;
  const translate = translator((url, {signal}) => {
    if (url.includes('googleapis')) return Promise.reject(new Error('Primary unavailable'));
    if (url.includes('translate.google.com')) return Promise.resolve({ok:true, json:async () => [[['Привет']], null, 'en']});
    memorySignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
    });
  });
  const result = await translate('Hello', 'ru', 'en');
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'google');
  assert.equal(result.text, 'Привет');
  assert.equal(memorySignal.aborted, true);
});

test('a fast quota rejection cannot beat a valid translation from the other fallback', async () => {
  let finishGoogle;
  let memoryStarted;
  const memoryReady = new Promise(resolve => { memoryStarted = resolve; });
  const translate = translator(url => {
    if (url.includes('googleapis')) return Promise.reject(new Error('Primary unavailable'));
    if (url.includes('translate.google.com')) return new Promise(resolve => { finishGoogle = resolve; });
    memoryStarted();
    return Promise.resolve({ok:true, json:async () => ({
      responseData:{translatedText:'MYMEMORY WARNING: exhausted'}, responseStatus:429, quotaFinished:true
    })});
  });
  const pending = translate('Hello', 'ru', 'en');
  await memoryReady;
  finishGoogle({ok:true, json:async () => [[['Привет']], null, 'en']});
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'google');
  assert.equal(result.text, 'Привет');
});

test('caller cancellation aborts both racing fallbacks without caching their results', async () => {
  const controller = new AbortController();
  const fallbackSignals = [];
  let memoryStarted;
  let recovered = false;
  const memoryReady = new Promise(resolve => { memoryStarted = resolve; });
  const translate = translator((url, {signal}) => {
    if (recovered) return Promise.resolve({ok:true, json:async () => [[['Привет']], null, 'en']});
    if (url.includes('googleapis')) return Promise.reject(new Error('Primary unavailable'));
    fallbackSignals.push(signal);
    if (url.includes('mymemory')) memoryStarted();
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
    });
  });
  const pending = translate('Hello', 'ru', 'en', controller.signal);
  await memoryReady;
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(fallbackSignals.length, 2);
  assert.ok(fallbackSignals.every(signal => signal.aborted));
  recovered = true;
  assert.equal((await translate('Hello', 'ru', 'en')).text, 'Привет');
});

test('a fast primary finishes without launching fallbacks after the hedge delay', async () => {
  const clock = translationClock();
  const hosts = [];
  const translate = translator((url, {signal}) => {
    hosts.push(new URL(url).host);
    return clock.responseAfter(200, {ok:true, json:async () => [[['Быстро']], null, 'en']}, signal);
  }, clock.globals);
  const pending = translate('Fast primary', 'ru', 'en');
  await clock.advance(200);
  assert.equal((await pending).text, 'Быстро');
  await clock.advance(3000);
  assert.deepEqual(hosts, ['translate.googleapis.com']);
});

test('fallbacks hedge a pending primary after 600ms without aborting it', async () => {
  const clock = translationClock();
  const attempts = [];
  const translate = translator((url, {signal}) => {
    attempts.push({host:new URL(url).host, signal, started:clock.now()});
    return clock.responseAfter(2000, {ok:true, json:async () => [[['Поздно']], null, 'en']}, signal);
  }, clock.globals);
  const pending = translate('Pending primary', 'ru', 'en');
  await clock.advance(599);
  assert.equal(attempts.length, 1);
  await clock.advance(1);
  assert.deepEqual(attempts.map(attempt => [attempt.host, attempt.started]), [
    ['translate.googleapis.com', 0], ['translate.google.com', 600], ['api.mymemory.translated.net', 600]
  ]);
  assert.equal(attempts[0].signal.aborted, false);
  await clock.advance(1900);
  assert.equal((await pending).ok, false);
});

test('a healthy 1300ms primary survives its old timeout and cancels slower hedges', async () => {
  const clock = translationClock();
  const attempts = [];
  const translate = translator((url, {signal}) => {
    const primary = url.includes('googleapis');
    attempts.push({signal, primary});
    return clock.responseAfter(primary ? 1300 : 2000,
      {ok:true, json:async () => [[['Медленно, но верно']], null, 'en']}, signal);
  }, clock.globals);
  const pending = translate('Slow healthy primary', 'ru', 'en');
  await clock.advance(1201);
  assert.equal(attempts[0].signal.aborted, false, 'the primary must receive more than 1200ms');
  await clock.advance(99);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'google');
  assert.equal(result.text, 'Медленно, но верно');
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(attempt => attempt.signal.aborted), 'all request resources must be released after success');
});

test('a 1500ms MyMemory response survives the old fallback timeout after immediate primary failure', async () => {
  const clock = translationClock();
  const started = [];
  const translate = translator((url, {signal}) => {
    started.push(clock.now());
    if (!url.includes('mymemory')) return Promise.reject(new Error('Google unavailable'));
    return clock.responseAfter(1500, {ok:true, json:async () => ({
      responseData:{translatedText:'Доброе утро'}, responseStatus:200, quotaFinished:false
    })}, signal);
  }, clock.globals);
  const pending = translate('Good morning', 'ru', 'en');
  await clock.advance(1500);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'mymemory');
  assert.equal(result.text, 'Доброе утро');
  assert.deepEqual(started, [0, 0, 0], 'primary errors must bypass the hedge delay');
});

test('the overall deadline stops waiting even if every transport ignores cancellation', async () => {
  const clock = translationClock();
  const signals = [];
  let result;
  const translate = translator((url, {signal}) => {
    signals.push(signal);
    return new Promise(() => {});
  }, clock.globals);
  translate('Stalled requests', 'ru', 'en').then(value => { result = value; });
  await clock.advance(2399);
  assert.equal(result, undefined);
  await clock.advance(1);
  assert.equal(result?.ok, false, 'a stalled transport must not keep the caption pending past 2400ms');
  assert.equal(result.error, 'freeTranslationUnavailable');
  assert.equal(result.cancelled, undefined);
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
});

test('a winning hedge aborts a still healthy primary and the other fallback', async () => {
  const clock = translationClock();
  const signals = [];
  const translate = translator((url, {signal}) => {
    signals.push(signal);
    return clock.responseAfter(url.includes('translate.google.com') ? 100 : 1700,
      {ok:true, json:async () => [[['Первый результат']], null, 'en']}, signal);
  }, clock.globals);
  let result;
  translate('Hedge wins', 'ru', 'en').then(value => { result = value; });
  await clock.advance(700);
  assert.equal(result?.text, 'Первый результат');
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
});

test('caller cancellation aborts the primary and both hedges even if fetch ignores it', async () => {
  const clock = translationClock();
  const controller = new AbortController();
  const signals = [];
  let result;
  const translate = translator((url, {signal}) => {
    signals.push(signal);
    return new Promise(() => {});
  }, clock.globals);
  translate('Cancel all requests', 'ru', 'en', controller.signal).then(value => { result = value; });
  await clock.advance(600);
  controller.abort();
  await clock.advance(0);
  assert.equal(result?.cancelled, true);
  assert.equal(result.ok, false);
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
  await clock.advance(3000);
  assert.equal(signals.length, 3);
});
