// NeiroTranslate — popup controller.
const $ = (id) => document.getElementById(id);

let settings = null;
let state = { active: false, status: 'idle' };
let timerInterval = 0;
let activeTab = null;
let savedSettings = null;
let settingsRevision = 0;
let settingsError = '';
const pendingSaves = [];
let saveQueue = Promise.resolve();

function statusLabel(st) {
  if (!st || st.status === 'idle') return ntT('idle');
  if (['error', 'voice_error', 'translation_error'].includes(st.status)) return ntT('st_' + st.status) + ': ' + explainDetail(st.detail);
  return ntT('st_' + st.status);
}

function explainDetail(detail) {
  return ntExplainError(detail);
}

function renderState() {
  const hero = $('hero');
  const live = !!state.active;
  hero.classList.toggle('live', live && state.status !== 'error');
  hero.classList.toggle('error', ['error', 'voice_error', 'translation_error'].includes(state.status));
  hero.classList.toggle('busy', live && ['starting', 'connecting', 'reconnecting', 'captions_wait'].includes(state.status));
  $('statusText').textContent = statusLabel(state);
  // Optional speaker capture failing is not an error; name it on hover.
  $('statusText').title = $('statusText').textContent +
    (live && state.captureError ? ' — ' + ntT('captureOff') + ' (' + state.captureError + ')' : '');
  $('toggleLabel').textContent = live ? ntT('stop') : ntT('start');

  clearInterval(timerInterval);
  const tick = () => {
    const sec = live && state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
    $('timer').textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };
  tick();
  if (live) timerInterval = setInterval(tick, 1000);
  renderProblems();
}

function renderProblems() {
  const problems = settings ? ntValidate(settings) : [];
  const badPage = !state.active && activeTab && !/^(https?|file):/i.test(activeTab.url || '');
  const msg = settingsError ? ntT('testFail') + ': ' + explainDetail(settingsError) : problems.length ? ntT(problems[0]) : badPage ? ntT('badPage') : '';
  $('problem').classList.toggle('hidden', !msg);
  $('problemText').textContent = msg;
  $('problemFix').classList.toggle('hidden', !!settingsError || !problems.length || problems[0] === 'geminiVoiceNeedsGeminiSource');
  $('toggleBtn').disabled = !state.active && (!settings || !!msg || pendingSaves.length > 0);
}

function renderSettings() {
  document.querySelectorAll('input[name=source]').forEach((r) => { r.checked = r.value === settings.source; });
  $('voiceSelect').value = settings.voice;
  $('voiceSelect').querySelector('[value="gemini"]').disabled = settings.source !== 'gemini';
  const free = NT_FREE_VOICES.includes(settings.voice);
  $('voiceCost').textContent = ntT(free ? 'noKey' : 'ownKey');
  $('voiceCost').classList.toggle('keyed', !free);
  $('targetLang').value = settings.targetLang;
  const o = Math.round(settings.originalVolume * 100);
  const d = Math.round(settings.dubVolume * 100);
  $('origVol').value = o; $('origVolVal').textContent = o + '%';
  $('dubVol').value = d; $('dubVolVal').textContent = d + '%';
  $('mixSummary').textContent = o + '% / ' + d + '%';
  $('uiLangBtn').textContent = ntGetLang().toUpperCase();
  renderProblems();
}

function renderSubtitle(sub) {
  if (!sub || !sub.text) {
    $('subsText').textContent = ntT('waiting');
    $('subsText').classList.remove('has');
    $('subsOrig').textContent = '';
    return;
  }
  $('subsText').textContent = sub.text;
  $('subsText').classList.add('has');
  $('subsOrig').textContent = sub.original || '';
}

function showSettings() {
  if (!savedSettings) return renderProblems();
  settings = Object.assign({}, savedSettings, ...pendingSaves.map(entry => entry.patch));
  const previousLang = ntGetLang();
  ntSetLang(settings.uiLang);
  if (previousLang !== ntGetLang()) {
    ntApplyI18n(document);
    if (!$('subsText').classList.contains('has')) $('subsText').textContent = ntT('waiting');
    renderState();
  }
  renderSettings();
}

function showError(error) {
  settingsError = error?.message || String(error);
  renderProblems();
}

async function refreshSettings() {
  const revision = ++settingsRevision;
  try {
    const fresh = await ntGetSettings();
    if (revision !== settingsRevision) return;
    savedSettings = fresh;
    showSettings();
  } catch (error) {
    if (revision === settingsRevision) showError(error);
  }
}

function save(patch) {
  const entry = { patch };
  pendingSaves.push(entry);
  ++settingsRevision;
  settingsError = '';
  showSettings();
  saveQueue = saveQueue.then(async () => {
    try {
      await ntSetSettings(patch);
      savedSettings = Object.assign({}, savedSettings, patch);
      settingsError = '';
    } catch (error) {
      settingsError = error?.message || String(error);
    }
    ++settingsRevision;
    pendingSaves.splice(pendingSaves.indexOf(entry), 1);
    showSettings();
    if (!pendingSaves.length) await refreshSettings();
  });
  return saveQueue;
}

async function init() {
  savedSettings = settings = await ntGetSettings();
  ntSetLang(settings.uiLang);
  ntApplyI18n(document);

  const select = $('targetLang');
  NT_LANGUAGES.forEach((l) => {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.native === l.name ? l.native : l.native + ' — ' + l.name;
    select.appendChild(opt);
  });

  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  activeTab = forced ? await chrome.tabs.get(forced).catch(() => null) : null;
  if (!activeTab) [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  renderSettings();

  const res = await chrome.runtime.sendMessage({ type: 'NT_GET_STATE' }).catch(() => null);
  if (res) { state = res.state; renderSubtitle(res.subtitle); }
  renderState();

  select.addEventListener('change', () => save({ targetLang: select.value }));

  document.querySelectorAll('input[name=source]').forEach((r) => r.addEventListener('change', () => {
    const patch = { source: r.value };
    if (r.value !== 'gemini' && settings.voice === 'gemini') patch.voice = 'browser';
    return save(patch);
  }));

  $('voiceSelect').addEventListener('change', () => {
    const patch = { voice: $('voiceSelect').value };
    if (NT_FREE_VOICES.includes(patch.voice) && settings.source === 'gemini' &&
        !(typeof settings.geminiApiKey === 'string' && settings.geminiApiKey.trim())) patch.source = 'captions';
    return save(patch);
  });

  $('origVol').addEventListener('input', (e) => save({ originalVolume: e.target.value / 100 }));
  $('dubVol').addEventListener('input', (e) => save({ dubVolume: e.target.value / 100 }));

  $('toggleBtn').addEventListener('click', async () => {
    $('toggleBtn').disabled = true;
    try {
    if (state.active) {
      await chrome.runtime.sendMessage({ type: 'NT_STOP' });
    } else {
      state = Object.assign({}, state, { active: true, status: 'starting', startedAt: Date.now() });
      renderState();
      const r = await chrome.runtime.sendMessage({ type: 'NT_START', tabId: activeTab.id });
      if (!r || !r.ok) {
        state = { active: false, status: 'error', detail: r ? (r.error === 'raw' ? 'raw|' + r.detail : r.error) : 'raw|no response' };
        renderState();
      }
    }
    } catch (e) {
      state = { active: false, status: 'error', detail: 'raw|' + e.message };
      renderState();
    } finally { $('toggleBtn').disabled = false; renderProblems(); }
  });

  $('problemFix').addEventListener('click', () => chrome.runtime.openOptionsPage().catch(showError));
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage().catch(showError));
  $('statsBtn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/stats/stats.html') }).catch(showError));
  $('overlayBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'NT_OPEN_OVERLAY' }).catch(showError));
  $('uiLangBtn').addEventListener('click', async () => {
    const next = ntGetLang() === 'ru' ? 'en' : 'ru';
    await save({ uiLang: next });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'NT_STATE') { state = msg.state; renderState(); }
    if (msg.type === 'NT_SUBTITLE') renderSubtitle(msg);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(key => Object.hasOwn(NT_DEFAULTS, key))) refreshSettings();
  });
  // Catch settings changed in another page while the tab/runtime queries were pending.
  await refreshSettings();
}

init().catch(showError);
