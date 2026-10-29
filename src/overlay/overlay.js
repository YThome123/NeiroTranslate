// NeiroTranslate — chroma-key subtitle window for OBS "Window Capture".
const line = document.getElementById('line');
const orig = document.getElementById('orig');
const bg = document.getElementById('bg');
const size = document.getElementById('size');
let hideTimer = 0;

function applyPrefs(p) {
  document.body.className = 'bg-' + (p.obsBg || 'green');
  bg.value = p.obsBg || 'green';
  size.value = p.obsSize || 40;
  document.body.style.setProperty('--size', size.value + 'px');
}

chrome.storage.local.get({ obsBg: 'green', obsSize: 40, uiLang: '', showOriginal: true }, (p) => {
  ntSetLang(p.uiLang);
  ntApplyI18n(document);
  applyPrefs(p);
  window.showOriginal = p.showOriginal;
});

bg.addEventListener('change', () => { chrome.storage.local.set({ obsBg: bg.value }); applyPrefs({ obsBg: bg.value, obsSize: size.value }); });
size.addEventListener('input', () => { chrome.storage.local.set({ obsSize: Number(size.value) }); document.body.style.setProperty('--size', size.value + 'px'); });
document.getElementById('clear').addEventListener('click', () => { line.textContent = ''; orig.textContent = ''; });

function show(msg) {
  line.textContent = msg.text || '';
  orig.textContent = window.showOriginal === false ? '' : (msg.original || '');
  clearTimeout(hideTimer);
  const duration = msg.deadline ? Math.max(0, msg.deadline - Date.now()) : 7000;
  hideTimer = setTimeout(() => { line.textContent = ''; orig.textContent = ''; }, duration);
}

chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'NT_SUBTITLE') show(msg); });
chrome.runtime.sendMessage({ type: 'NT_GET_STATE' }).then((r) => { if (r && r.subtitle) show(r.subtitle); }).catch(() => {});
