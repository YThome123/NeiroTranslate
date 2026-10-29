// Real-network check of the shipped free translation path.
// Loads src/shared/translate.js in a VM with the global fetch, so it exercises exactly
// the code the service worker runs — not a reimplementation.
//
//   node tools/live-translate-check.mjs
//
// Includes real calls to each free host and forced fallback paths. Blocked/stalled
// hosts are simulated locally; other requests use the real network without keys.
// Exit code 0 when translations and expected failures match; 1 on any mismatch.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/shared/translate.js'), 'utf8');

function load(blockedHosts, stalledHosts, attempts) {
  let firstRequest;
  const tracedFetch = async (url, options) => {
    const host = new URL(url).host;
    firstRequest ??= Date.now();
    const attempt = {host, outcome:'pending', ms:0, startMs:Date.now() - firstRequest};
    attempts.push(attempt);
    if (blockedHosts.includes(host)) {
      attempt.outcome = 'blocked locally';
      throw new Error('Simulated unavailable host: ' + host);
    }
    const started = Date.now();
    try {
      if (stalledHosts.includes(host)) {
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true});
        });
      }
      const response = await fetch(url, options);
      attempt.outcome = String(response.status);
      return {
        ok:response.ok, status:response.status,
        async json() {
          try {
            return await response.json();
          } catch (error) {
            attempt.outcome = response.status + ' body ' + error.name + ': ' + error.message;
            throw error;
          } finally {
            attempt.ms = Date.now() - started;
          }
        }
      };
    } catch (error) {
      attempt.outcome = error.name + ': ' + error.message;
      throw error;
    } finally {
      attempt.ms = Date.now() - started;
    }
  };
  const ctx = vm.createContext({ self: {}, fetch:tracedFetch, AbortSignal, AbortController, TextEncoder, setTimeout, clearTimeout, console });
  vm.runInContext(source, ctx);
  return ctx.self.ntTranslate;
}

const cases = [
  { text: 'Hello world', target: 'ru', source: 'en', note: 'short line, source known' },
  { text: 'Hello world', target: 'ru', source: '', note: 'short line, autodetect' },
  { text: 'The quick brown fox jumps over the lazy dog.', target: 'ru', source: 'en', note: 'longer line' },
  { text: 'Good morning everyone and welcome to the stream.', target: 'de', source: 'auto', note: 'other target language' },
  { text: 'Привет, как дела?', target: 'en', source: '', note: 'non-latin source' },
  { text: 'Hello world', target: 'ru', source: '', note: 'Google web fallback',
    blocked:['translate.googleapis.com'], provider:'google', host:'translate.google.com' },
  { text: 'Good morning', target: 'ru', source: 'en', note: 'MyMemory fallback',
    blocked:['translate.googleapis.com', 'translate.google.com'], provider:'mymemory', host:'api.mymemory.translated.net' },
  { text: 'Good morning', target: 'ru', source: 'en-US', note: 'MyMemory regional source',
    blocked:['translate.googleapis.com', 'translate.google.com'], provider:'mymemory', host:'api.mymemory.translated.net' },
  { text: 'Good morning', target: 'ru', source: 'en', note: 'hedge to MyMemory',
    stalled:['translate.googleapis.com', 'translate.google.com'], provider:'mymemory', host:'api.mymemory.translated.net', maxMs:2500 },
  { text: 'Hello world', target: 'ru', source: '', note: 'hedge to Google web',
    stalled:['translate.googleapis.com'], provider:'google', host:'translate.google.com', maxMs:2500 },
  { text: 'Hello world', target: 'ru', source: '', note: 'outage, no source hint',
    blocked:['translate.googleapis.com', 'translate.google.com'], unavailable:true, noNetwork:true },
  { text: 'Hello world', target: 'ru', source: 'auto', note: 'outage, auto source hint',
    blocked:['translate.googleapis.com', 'translate.google.com'], unavailable:true, noNetwork:true },
  { text: 'Hello world', target: undefined, source: 'en', note: 'missing target language', unavailable:true, noNetwork:true },
  { text: 'я'.repeat(251), target: 'en', source: 'ru', note: 'MyMemory byte limit',
    blocked:['translate.googleapis.com', 'translate.google.com'], unavailable:true, noNetwork:true },
  { text: 'Hello world', target: 'en', source: 'en', note: 'same-language identity', identity:true }
];

let failed = 0;
for (const c of cases) {
  // Isolate caches so repeated inputs cannot hide a provider or fallback failure.
  const attempts = [];
  const translate = load(c.blocked || [], c.stalled || [], attempts);
  const started = Date.now();
  let result;
  try {
    result = await translate(c.text, c.target, c.source, AbortSignal.timeout(8000));
  } catch (e) {
    result = { ok: false, error: 'threw', detail: e.message };
  }
  const ms = Date.now() - started;
  const matches = c.unavailable
    ? !result.ok && result.error === 'freeTranslationUnavailable'
    : result.ok && result.text.trim() && (c.identity ? result.text === c.text : result.text !== c.text)
      && (!c.provider || result.provider === c.provider) && (!c.host || attempts.at(-1)?.host === c.host);
  const noNetwork = !c.noNetwork || attempts.every(attempt => attempt.outcome === 'blocked locally');
  const inBudget = ms <= (c.maxMs || 2500);
  const status = matches && noNetwork && inBudget ? 'OK  ' : 'FAIL';
  if (status === 'FAIL') failed++;
  const detail = result.ok
    ? `${result.provider} det=${result.detected || '?'} "${String(result.text).slice(0, 60)}"`
    : `${result.error || 'error'} ${result.detail ? '(' + result.detail + ')' : ''}`;
  console.log(`${status} ${String(ms).padStart(5)}ms  ${c.note.padEnd(26)} ${detail}`);
  if (attempts.length) console.log('      ' + attempts.map(attempt => `${attempt.host} +${attempt.startMs}ms: ${attempt.outcome} (${attempt.ms}ms)`).join(' | '));
}

console.log(failed ? `\n${failed}/${cases.length} free-translation checks failed` : `\nall ${cases.length} free-translation checks passed`);
process.exitCode = failed ? 1 : 0;
