// NeiroTranslate — chroma-key subtitle window for OBS "Window Capture".
const line = document.getElementById('line');
const orig = document.getElementById('orig');
const bg = document.getElementById('bg');
const size = document.getElementById('size');
let hideTimer = 0;
let captionRevision = 0;
let currentOriginal = '';
const PREF_DEFAULTS = { obsBg: 'green', obsSize: 40, uiLang: '', showOriginal: true };
const prefs = {...PREF_DEFAULTS};
const changedPrefs = new Set();
let originalKnown = false;

function updateOriginal() {
  window.showOriginal = originalKnown && prefs.showOriginal !== false;
  orig.textContent = window.showOriginal ? currentOriginal : '';
}

function applyPrefs(p) {
  if (Object.prototype.hasOwnProperty.call(p, 'showOriginal')) originalKnown = true;
  Object.assign(prefs, p);
  document.body.className = 'bg-' + (prefs.obsBg || 'green');
  bg.value = prefs.obsBg || 'green';
  size.value = prefs.obsSize || 40;
  document.body.style.setProperty('--size', size.value + 'px');
  if (Object.prototype.hasOwnProperty.call(p, 'uiLang')) {ntSetLang(prefs.uiLang);ntApplyI18n(document);}
  updateOriginal();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const patch = {};
  for (const key of Object.keys(PREF_DEFAULTS)) {
    if (!(key in changes)) continue;
    changedPrefs.add(key);
    patch[key] = changes[key].newValue ?? PREF_DEFAULTS[key];
  }
  if (Object.keys(patch).length) applyPrefs(patch);
});

// Source text stays hidden until its stored preference is known.
applyPrefs({});
chrome.storage.local.get(PREF_DEFAULTS, (p) => {
  if (chrome.runtime.lastError) return;
  const patch = {};
  for (const key of Object.keys(PREF_DEFAULTS)) if (!changedPrefs.has(key)) patch[key] = p?.[key] ?? PREF_DEFAULTS[key];
  applyPrefs(patch);
});

function savePrefs(patch) {
  Object.keys(patch).forEach(key => changedPrefs.add(key));
  applyPrefs(patch);
  chrome.storage.local.set(patch);
}

bg.addEventListener('change', () => savePrefs({obsBg:bg.value}));
size.addEventListener('input', () => savePrefs({obsSize:Number(size.value)}));
function clearCaption() {
  captionRevision++;
  clearTimeout(hideTimer);
  currentOriginal = '';
  line.textContent = ''; orig.textContent = '';
}
document.getElementById('clear').addEventListener('click', clearCaption);

function show(msg) {
  captionRevision++;
  line.textContent = msg.text || '';
  currentOriginal = msg.original || '';
  updateOriginal();
  clearTimeout(hideTimer);
  const duration = msg.deadline ? Math.max(0, msg.deadline - Date.now()) : 7000;
  hideTimer = setTimeout(clearCaption, duration);
}

chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'NT_SUBTITLE') show(msg); });
const initialCaptionRevision = captionRevision;
chrome.runtime.sendMessage({ type: 'NT_GET_STATE' }).then((r) => {
  if (r?.subtitle && captionRevision === initialCaptionRevision) show(r.subtitle);
}).catch(() => {});
