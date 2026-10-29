// NeiroTranslate — local usage stats.
const $ = (id) => document.getElementById(id);
const L = {
  ru: { title: 'Статистика', subtitle: 'Хранится только на этом устройстве', time: 'переведено', sessions: 'сессий', days: 'активных дней', langs: 'языков',
        heat: 'Активность за год', hours: 'По часам', langsH: 'Языки', sites: 'Сайты', modes: 'Режимы', peak: 'Чаще всего около', empty: 'Пока нет данных',
        captions: 'Субтитры', gemini: 'Gemini Live' },
  en: { title: 'Stats', subtitle: 'Stored only on this device', time: 'translated', sessions: 'sessions', days: 'active days', langs: 'languages',
        heat: 'Activity this year', hours: 'By hour', langsH: 'Languages', sites: 'Sites', modes: 'Modes', peak: 'Most active around', empty: 'No data yet',
        captions: 'Subtitles', gemini: 'Gemini Live' }
};
const VOICE = { browser: 'Browser voice', google: 'Google', gemini: 'Gemini', elevenlabs: 'ElevenLabs', yandex: 'Yandex' };
let sessions = [];
let s = L.en;
let selectedDays = 'all';
let sessionsRevision = 0;

function showError(error) {
  $('error').textContent = ntT('testFail') + ': ' + ntExplainError(error?.message || String(error));
  $('error').hidden = false;
}

function updateSessions(value) {
  sessions = Array.isArray(value) ? value : [];
  $('error').hidden = true;
  render(selectedDays);
}

function fmt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

function bars(el, counts, label) {
  el.innerHTML = '';
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!rows.length) { el.innerHTML = `<div class="empty">${s.empty}</div>`; return; }
  const max = rows[0][1] || 1;
  rows.forEach(([k, v]) => {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = '<div class="bar-head"><span></span><span></span></div><div class="bar-track"><div></div></div>';
    row.querySelector('.bar-head span').textContent = label(k);
    row.querySelector('.bar-head span:last-child').textContent = fmt(v);
    row.querySelector('.bar-track div').style.width = Math.max(3, (v / max) * 100) + '%';
    el.appendChild(row);
  });
}

function render(days) {
  const cutoff = days === 'all' ? 0 : Date.now() - Number(days) * 864e5;
  const list = sessions.filter((x) => x && x.startTime >= cutoff);
  let total = 0;
  const daySet = new Set();
  const langs = {}; const sites = {}; const modes = {}; const hours = new Array(24).fill(0);
  list.forEach((x) => {
    const sec = x.durationSec || 0;
    const d = new Date(x.startTime);
    total += sec;
    daySet.add(dayKey(d));
    hours[d.getHours()] += sec;
    langs[x.lang || '?'] = (langs[x.lang || '?'] || 0) + sec;
    sites[x.domain || '?'] = (sites[x.domain || '?'] || 0) + sec;
    const mode = (x.source === 'gemini' ? s.gemini : s.captions) + (x.voice && x.voice !== 'off' ? ' + ' + (VOICE[x.voice] || x.voice) : '');
    modes[mode] = (modes[mode] || 0) + sec;
  });
  $('kTime').textContent = fmt(total);
  $('kSessions').textContent = list.length;
  $('kDays').textContent = daySet.size;
  $('kLangs').textContent = Object.keys(langs).length;

  // Heatmap: last 53 weeks, aligned to weekday rows.
  const perDay = {};
  sessions.forEach((x) => { const k = dayKey(new Date(x.startTime)); perDay[k] = (perDay[k] || 0) + (x.durationSec || 0); });
  const heat = $('heat');
  heat.innerHTML = '';
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 364 - today.getDay());
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const sec = perDay[dayKey(d)] || 0;
    const i = document.createElement('i');
    i.className = sec > 3600 ? 'l4' : sec > 1800 ? 'l3' : sec > 600 ? 'l2' : sec > 0 ? 'l1' : '';
    i.title = `${d.toLocaleDateString()} · ${fmt(sec)}`;
    heat.appendChild(i);
  }

  const max = Math.max(...hours, 1);
  $('hours').innerHTML = '';
  hours.forEach((sec, h) => {
    const i = document.createElement('i');
    i.style.height = Math.max(3, (sec / max) * 100) + '%';
    if (!sec) i.className = 'zero';
    i.title = `${String(h).padStart(2, '0')}:00 · ${fmt(sec)}`;
    $('hours').appendChild(i);
  });
  const peak = hours.indexOf(Math.max(...hours));
  $('peak').textContent = total ? `${s.peak} ${String(peak).padStart(2, '0')}:00` : s.empty;

  bars($('langs'), langs, (k) => { const l = NT_LANGUAGES.find((x) => x.code === k); return l ? l.native : k; });
  bars($('sites'), sites, (k) => k);
  bars($('modes'), modes, (k) => k);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.hasOwn(changes, 'nt_sessions')) return;
  ++sessionsRevision;
  updateSessions(changes.nt_sessions.newValue);
});

ntGetSettings().then((cfg) => {
  s = L[ntSetLang(cfg.uiLang)] || L.en;
  $('title').textContent = s.title; $('subtitle').textContent = s.subtitle;
  $('lTime').textContent = s.time; $('lSessions').textContent = s.sessions; $('lDays').textContent = s.days; $('lLangs').textContent = s.langs;
  $('hHeat').textContent = s.heat; $('hHours').textContent = s.hours; $('hLangs').textContent = s.langsH; $('hSites').textContent = s.sites; $('hModes').textContent = s.modes;
  const revision = sessionsRevision;
  chrome.storage.local.get({ nt_sessions: [] }, (r) => {
    const error = chrome.runtime.lastError;
    if (revision !== sessionsRevision) return;
    if (error) { showError(error); return; }
    updateSessions(r.nt_sessions);
  });
}).catch(showError);

$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#filters button').forEach((x) => x.classList.toggle('active', x === b));
  selectedDays = b.dataset.days;
  render(selectedDays);
});
