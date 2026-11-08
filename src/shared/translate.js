// NeiroTranslate — free text translation (Google Translate web endpoint, MyMemory fallback).
// Runs in the service worker (host_permissions bypass CORS).
(function (root) {
  const cache = new Map();
  const CACHE_MAX = 400;
  const inflight = new Map();
  const MAX_INFLIGHT = 64;
  const cooldowns = new Map();

  function remember(key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function requestSignal(signal, timeout) {
    const deadline = AbortSignal.timeout(timeout);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
  }

  async function googleTranslate(text, target, source, origin, signal) {
    if ((cooldowns.get(origin) || 0) > Date.now()) throw new Error('Google Translate HTTP 429 (cooldown)');
    cooldowns.delete(origin);
    const url = origin + '/translate_a/single?client=gtx&sl=' + encodeURIComponent(source || 'auto') + '&dt=t'
      + '&tl=' + encodeURIComponent(target) + '&q=' + encodeURIComponent(text);
    const resp = await fetch(url, { credentials: 'omit', signal: requestSignal(signal, 1800) });
    if (!resp.ok) {
      if (resp.status === 429) {
        const retry = resp.headers?.get?.('Retry-After');
        let delay = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 30000;
        if (!Number.isFinite(delay) || delay <= 0) delay = 30000;
        cooldowns.set(origin, Date.now() + Math.max(1000, Math.min(120000, delay)));
      }
      throw new Error('Google Translate HTTP ' + resp.status);
    }
    const data = await resp.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])
      || data[0].some(seg => !Array.isArray(seg) || typeof seg[0] !== 'string')) {
      throw new Error('Google Translate: invalid result');
    }
    const translated = data[0].map(seg => seg[0]).join('').trim();
    if (!translated) throw new Error('Google Translate: empty result');
    const detected = (typeof data[2] === 'string' && data[2]) || (typeof source === 'string' ? source : '');
    return { text: translated, detected, provider: 'google' };
  }

  async function myMemoryTranslate(text, target, source, signal) {
    // MyMemory needs an explicit source for reliable results; autodetect can echo the input.
    // Only use this fallback when a caller supplied a reliable source hint.
    if (!source || source === 'auto') throw new Error('Fallback requires source language');
    if (new TextEncoder().encode(text).byteLength > 500) throw new Error('MyMemory fallback: text exceeds 500 bytes');
    const url = 'https://api.mymemory.translated.net/get?langpair=' + encodeURIComponent(source + '|' + target)
      + '&q=' + encodeURIComponent(text);
    const resp = await fetch(url, { credentials: 'omit', signal: requestSignal(signal, 1800) });
    if (!resp.ok) throw new Error('MyMemory HTTP ' + resp.status);
    const data = await resp.json();
    const value = data && data.responseData && data.responseData.translatedText;
    const translated = typeof value === 'string' ? value.trim() : '';
    const status = Number(data && data.responseStatus);
    if (!translated || status !== 200 || data.quotaFinished || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(translated)) {
      throw new Error('MyMemory: ' + (translated || 'empty result').slice(0, 80));
    }
    return { text: translated, detected: source, provider: 'mymemory' };
  }

  /** Translate into Google code `target`; unavailable providers return the original text with ok:false. */
  async function translate(text, target, source, signal) {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return { text: '', detected: '', ok: true };
    if (signal?.aborted) return {ok:false,cancelled:true,text:''};
    if (typeof target !== 'string' || !target.trim() || target.trim().toLowerCase() === 'auto') {
      return {text:clean,detected:'',ok:false,error:'freeTranslationUnavailable',detail:'Target language is required'};
    }
    const explicitSource = typeof source === 'string' ? source.trim().toLowerCase() : '';
    if (explicitSource && explicitSource !== 'auto' && explicitSource === target.trim().toLowerCase()) {
      return {text:clean,detected:explicitSource,provider:'identity',ok:true};
    }
    const key = target + '\u0000' + (source || '') + '\u0000' + clean;
    if (cache.has(key)) return cache.get(key);
    let entry = inflight.get(key);
    if (entry?.controller.signal.aborted) {inflight.delete(key); entry = null;}
    if (!entry) {
      if (inflight.size >= MAX_INFLIGHT) return {ok:false,text:clean,detected:'',error:'freeTranslationUnavailable',detail:'Too many pending translations'};
      entry = {controller:new AbortController(), users:0, settled:false};
      inflight.set(key, entry);
      entry.promise = requestTranslation(clean, target, source, entry.controller.signal).then(result => {
        if (result.ok && !entry.controller.signal.aborted) remember(key, result);
        return result;
      }).finally(() => {
        entry.settled = true;
        if (inflight.get(key) === entry) inflight.delete(key);
      });
    }
    entry.users++;
    return new Promise(resolve => {
      let done = false;
      const finish = result => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        if (--entry.users === 0 && !entry.settled) {
          entry.controller.abort();
          if (inflight.get(key) === entry) inflight.delete(key);
        }
        resolve(result);
      };
      const onAbort = () => finish({ok:false,cancelled:true,text:''});
      signal?.addEventListener('abort', onAbort, {once:true});
      entry.promise.then(finish);
      if (signal?.aborted) onAbort();
    });
  }

  async function requestTranslation(clean, target, source, signal) {
    const requests = new AbortController();
    const combined = signal ? AbortSignal.any([signal, requests.signal]) : requests.signal;
    let error, hedgeTimer, deadlineTimer, onAbort;
    try {
      const translated = await new Promise((resolve, reject) => {
        let remaining = 1, fallbacksStarted = false;
        onAbort = () => reject(combined.reason);
        combined.addEventListener('abort', onAbort, {once:true});
        function run(request, primary = false) {
          request().then(resolve, failure => {
            error ||= failure.message;
            if (primary) startFallbacks();
            if (--remaining === 0) reject(failure);
          });
        }
        function startFallbacks() {
          if (fallbacksStarted || combined.aborted) return;
          fallbacksStarted = true;
          clearTimeout(hedgeTimer);
          remaining += 2;
          run(() => googleTranslate(clean, target, source, 'https://translate.google.com', combined));
          run(() => myMemoryTranslate(clean, target, source, combined));
        }
        // Hedge slow primaries without cancelling them. The 600ms hedge plus
        // 1800ms request window fits inside the caption's 2500ms lifetime.
        hedgeTimer = setTimeout(startFallbacks, 600);
        // Bound the whole operation even if a transport/body ignores abort.
        deadlineTimer = setTimeout(() => requests.abort(new Error('Translation deadline exceeded')), 2400);
        run(() => googleTranslate(clean, target, source, 'https://translate.googleapis.com', combined), true);
      });
      if (signal?.aborted) return {ok:false,cancelled:true,text:''};
      const result = Object.assign({ok:true}, translated);
      return result;
    } catch (failure) {
      if (signal?.aborted) return {ok:false,cancelled:true,text:''};
      return {text:clean,detected:'',ok:false,error:'freeTranslationUnavailable',detail:error || failure.message};
    } finally {
      clearTimeout(hedgeTimer);
      clearTimeout(deadlineTimer);
      combined.removeEventListener('abort', onAbort);
      requests.abort();
    }
  }

  root.ntTranslate = translate;
})(typeof self !== 'undefined' ? self : this);
