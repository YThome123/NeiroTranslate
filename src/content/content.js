// NeiroTranslate — content script: subtitle overlay, caption reader, original-audio ducking.
(() => {
  if (window.__neiroTranslateLoaded) return;
  window.__neiroTranslateLoaded = true;

  const HOST_ID = 'neirotranslate-root';
  const HIDE_STYLE_ID = 'neirotranslate-hide-native';
  const isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
  const isNetflix = /(^|\.)netflix\.com$/.test(location.hostname);

  let active = false;
  let cfg = {};
  let sessionId = null;
  // Speaking pace of the original, measured from rolling captions.
  const pace = new NtSourcePace();

  // A new media version invalidates all text/audio from before pause or seek.
  const playback = {
    video: null, version: 0, paused: false, buffering: false, rate: 1, timer: 0,
    events: ['pause', 'playing', 'seeking', 'seeked', 'ended', 'waiting', 'emptied', 'ratechange'],
    start(version = 0) {
      this.version = version;
      this.video = null;
      this.buffering = false;
      this.onEvent = event => {
        if (!active || event.target !== this.video) return;
        if (['waiting', 'emptied'].includes(event.type)) {this.buffering = true; this.bufferedAt = this.video.currentTime;}
        if (event.type === 'seeking') this.bufferedAt = this.video.currentTime;
        if (event.type === 'playing') this.buffering = false;
        this.sync(true, ['pause', 'seeking', 'ended', 'waiting', 'emptied'].includes(event.type));
      };
      this.events.forEach(event => document.addEventListener(event, this.onEvent, true));
      this.sync(true);
      this.timer = setInterval(() => this.sync(), 150);
    },
    sync(force = false, blocked = false) {
      if (!active) return;
      const video = findVideo();
      if (video !== this.video) this.buffering = false;
      // Some players resume their media clock without another playing event.
      // Ready metadata alone is insufficient: require real forward progress.
      if (this.buffering && video && !video.paused && !video.seeking && !video.ended && video.readyState >= 3 &&
          video.currentTime > this.bufferedAt + 0.1) this.buffering = false;
      const paused = !!(video && (blocked || this.buffering || video.paused || video.seeking || video.ended));
      const rate = video?.playbackRate || 1;
      if (!force && video === this.video && paused === this.paused && rate === this.rate) return;
      this.video = video; this.paused = paused; this.rate = rate;
      this.version++;
      if (reader.seg) reader.seg.reset();
      pace.lastAt = 0;
      reader.lastCue = ''; reader.lastPrefetch = ''; reader.currentSnapshot=''; reader.sourceLang = '';
      overlay.show('', '', true); duck.reset();
      chrome.runtime.sendMessage({type:'NT_MEDIA_STATE',sessionId,version:this.version,paused}).catch(() => {});
    },
    deadline() {
      const remaining = reader.cueEnd != null && this.video
        ? Math.max(0, (reader.cueEnd - this.video.currentTime) / this.rate * 1000) : 2500;
      return Date.now() + remaining;
    },
    stop() {
      clearInterval(this.timer);
      this.events.forEach(event => document.removeEventListener(event, this.onEvent, true));
      this.video = null;
    }
  };

  // Live streams carry ASR captions that trail the audio; VOD captions do not.
  function isLive(video) {
    if (video && video.duration === Infinity) return true;
    return !!document.querySelector('.ytp-live, .ytp-live-badge[disabled]');
  }

  /**
   * Timing for one caption, all wall-clock ms:
   *   spokenFrom/spokenTo — when the original said it (for speaker detection);
   *   syncEnd — by when the voice-over should be finished to stay in sync.
   */
  function captionTiming(text, meta) {
    const now = Date.now();
    const video = playback.video;
    const rate = playback.rate || 1;
    if (reader.cueEnd != null && video) {
      // Timed cues: the media clock says exactly when the line is spoken.
      const toWall = t => now + (t - video.currentTime) / rate * 1000;
      const spokenFrom = toWall(reader.cueStart ?? video.currentTime), spokenTo = toWall(reader.cueEnd);
      return {spokenFrom, spokenTo, syncEnd: spokenTo + NT_TIMING.VTT_SYNC_GRACE_MS};
    }
    // Rolling captions: the text is final only after it was said, so the voice
    // gets as long as the speaker took (measured pace), starting from now.
    const at = meta && Number.isFinite(meta.at) ? meta.at : now;
    const since = meta && Number.isFinite(meta.since) ? Math.min(meta.since, at) : at;
    pace.observe(text, at);
    const slot = Math.max(at - since, pace.durationMs(text));
    const lag = isLive(video) ? NT_TIMING.CAPTION_LAG_LIVE_MS : NT_TIMING.CAPTION_LAG_VOD_MS;
    const spokenTo = at - lag;
    return {spokenFrom: spokenTo - slot, spokenTo, syncEnd: at + slot + NT_TIMING.DOM_SYNC_GRACE_MS};
  }

  // ─── Video detection ──────────────────────────────────────
  function findVideo() {
    let best = null;
    let bestScore = 0;
    document.querySelectorAll('video').forEach((v) => {
      const r = v.getBoundingClientRect();
      if (r.width < 120 || r.height < 70) return;
      const score = r.width * r.height * (v.paused ? 1 : 4);
      if (score > bestScore) { best = v; bestScore = score; }
    });
    return best;
  }

  // ─── Overlay ──────────────────────────────────────────────
  const overlay = {
    host: null, box: null, line: null, orig: null, notice: null, hideTimer: null, noticeTimer: null, raf: 0, interval: 0,

    mount() {
      if (this.host) return;
      const host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .box { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:flex-end;
                 padding: 0 4% 7%; box-sizing:border-box; font-family: "Segoe UI", Inter, Roboto, system-ui, sans-serif; }
          .box.top { justify-content:flex-start; padding-top:5%; }
          .subs { display:flex; flex-direction:column; align-items:center; gap:6px; max-width: 92%;
                  transition: opacity .25s ease, transform .25s ease; }
          .subs.hidden { opacity:0; transform: translateY(6px); }
          .line, .orig { text-align:center; line-height:1.3; border-radius:9px; padding: .26em .65em;
                         background: rgba(20, 24, 30, .86); backdrop-filter: blur(6px); -webkit-box-decoration-break: clone;
                         box-decoration-break: clone; text-shadow: 0 1px 2px rgba(0,0,0,.8); }
          .line { color:#fff; font-weight:600; font-size: var(--nt-size, 26px); }
          .line.partial { color:#ffe0c6; }
          .orig { color: rgba(235,235,245,.78); font-weight:500; font-size: calc(var(--nt-size, 26px) * .62); }
          .orig:empty, .line:empty { display:none; }
          .notice { position:absolute; top:14px; left:50%; transform:translateX(-50%); max-width:80%;
                    background: #e95e20; color:#fff;
                    font: 600 13px/1.35 "Segoe UI", Inter, system-ui, sans-serif; padding:8px 14px; border-radius:999px;
                    box-shadow: 0 6px 24px rgba(0,0,0,.35); transition: opacity .3s; }
          .notice.hidden { opacity:0; }
        </style>
        <div class="box"><div class="notice hidden"></div><div class="subs hidden"><div class="orig"></div><div class="line"></div></div></div>`;
      this.host = host;
      this.box = root.querySelector('.box');
      this.subs = root.querySelector('.subs');
      this.line = root.querySelector('.line');
      this.orig = root.querySelector('.orig');
      this.notice = root.querySelector('.notice');
      this.attach();
      this.applyStyle();
      this.position();
      this.onResize = () => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.position()); };
      this.onFs = () => { this.attach(); this.position(); };
      window.addEventListener('resize', this.onResize, true);
      window.addEventListener('scroll', this.onResize, true);
      document.addEventListener('fullscreenchange', this.onFs);
      document.addEventListener('webkitfullscreenchange', this.onFs);
      this.interval = setInterval(() => this.position(), 1000);
    },

    attach() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
      if (this.host.parentNode !== parent) parent.appendChild(this.host);
    },

    position() {
      if (!this.host) return;
      const v = findVideo();
      const s = this.host.style;
      if (v) {
        const r = v.getBoundingClientRect();
        s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px';
        const size = Math.max(14, Math.min(Number(cfg.subtitleSize) || 26, r.height / 10));
        this.box.style.setProperty('--nt-size', size + 'px');
      } else {
        s.left = '0px'; s.top = '0px'; s.width = innerWidth + 'px'; s.height = innerHeight + 'px';
        this.box.style.setProperty('--nt-size', (Number(cfg.subtitleSize) || 26) + 'px');
      }
    },

    applyStyle() {
      if (!this.box) return;
      this.box.classList.toggle('top', cfg.subtitlePosition === 'top');
      this.box.style.display = cfg.showSubtitles === false ? 'none' : '';
      if (cfg.showOriginal === false) this.orig.textContent = '';
      this.position();
    },

    show(text, original, final, deadline) {
      if (!this.host) return;
      this.line.textContent = text || '';
      this.line.classList.toggle('partial', !final);
      this.orig.textContent = cfg.showOriginal === false ? '' : (original || '');
      this.subs.classList.toggle('hidden', !text && !original);
      clearTimeout(this.hideTimer);
      const duration = deadline ? Math.max(0, deadline - Date.now()) : final ? 6500 : 9000;
      this.hideTimer = setTimeout(() => this.subs.classList.add('hidden'), duration);
    },

    toast(text, ms = 6000) {
      if (!this.notice) return;
      this.notice.textContent = text;
      this.notice.classList.remove('hidden');
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => this.notice.classList.add('hidden'), ms);
    },

    unmount() {
      if (!this.host) return;
      clearInterval(this.interval);
      clearTimeout(this.hideTimer);
      clearTimeout(this.noticeTimer);
      window.removeEventListener('resize', this.onResize, true);
      window.removeEventListener('scroll', this.onResize, true);
      document.removeEventListener('fullscreenchange', this.onFs);
      document.removeEventListener('webkitfullscreenchange', this.onFs);
      this.host.remove();
      this.host = null;
    }
  };

  // ─── Caption readers ──────────────────────────────────────
  const reader = {
    timer: 0, seg: null, startedAt: 0, everFound: false, everText: false, reported: '',
    touchedTracks: [], ytTurnedOn: false, navTimer: 0, cueEnd: null, lastCue: '', lastPrefetch: '',

    start() {
      const id = sessionId;
      this.seg = new NtSegmenter((text, meta) => this.emit(text, id, meta));
      this.startedAt = Date.now();
      this.everFound = this.everText = false;
      this.reported = '';
      if (isYouTube) this.enableYouTubeCC();
      this.timer = setInterval(() => this.tick(), 100);
      this.onNav = () => {
        playback.sync(true, true);
        this.seg.reset();
        clearTimeout(this.navTimer);
        this.navTimer = setTimeout(() => { if (active) this.enableYouTubeCC(); }, 1500);
      };
      window.addEventListener('yt-navigate-finish', this.onNav);
      this.tick();
    },

    emit(text, id = sessionId, meta = null) {
      if (!active || playback.paused) return;
      chrome.runtime.sendMessage(Object.assign({type:'NT_CAPTION',text,sessionId:id,sourceLang:cfg.sourceLang || this.sourceLang || '',
        mediaVersion:playback.version,deadline:playback.deadline()}, captionTiming(text, meta))).catch(() => {});
    },

    stop() {
      clearInterval(this.timer);
      clearTimeout(this.navTimer);
      window.removeEventListener('yt-navigate-finish', this.onNav);
      if (this.seg) this.seg.flush();
      this.touchedTracks.forEach(({ track, mode }) => { try { track.mode = mode; } catch (e) { /* ignore */ } });
      this.touchedTracks = [];
      if (this.ytTurnedOn) {
        const btn = document.querySelector('.ytp-subtitles-button');
        if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click();
        this.ytTurnedOn = false;
      }
    },

    enableYouTubeCC() {
      const btn = document.querySelector('#movie_player .ytp-subtitles-button, .ytp-subtitles-button');
      if (btn && btn.getAttribute('aria-pressed') === 'false' && btn.offsetParent !== null) {
        btn.click();
        this.ytTurnedOn = true;
      }
    },

    snapshot() {
      this.cueEnd = null;
      this.cueStart = null;
      this.upcoming = null;
      if (isYouTube) {
        const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
        if (!player) return this.trackSnapshot();
        this.sourceLang = player.querySelector('.caption-window[lang]')?.getAttribute('lang') || cfg.sourceLang || '';
        const lines = player.querySelectorAll('.caption-visual-line');
        const nodes = lines.length ? lines : player.querySelectorAll('.ytp-caption-segment');
        const btn = player.querySelector('.ytp-subtitles-button');
        if (!nodes.length && (!btn || btn.getAttribute('aria-pressed') !== 'true')) return null;
        return Array.from(nodes).map((n) => n.textContent).join(' ');
      }
      if (isNetflix) {
        const el = document.querySelector('.player-timedtext');
        return el ? ntMarkCaptionTurns(el.innerText) : null;
      }
      const dom = document.querySelector('.vjs-text-track-display, .jw-captions, .jw-text-track-container, .shaka-text-container, .plyr__captions, .mejs__captions-layer');
      if (dom && dom.textContent.trim()) return ntMarkCaptionTurns(dom.innerText || dom.textContent);
      return this.trackSnapshot();
    },

    trackSnapshot() {
      const v = findVideo() || document.querySelector('video');
      if (!v || !v.textTracks || !v.textTracks.length) return null;
      const tracks = Array.from(v.textTracks).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
      if (!tracks.length) return null;
      let track = tracks.find((t) => t.mode === 'showing') || tracks.find((t) => t.mode === 'hidden') || tracks[0];
      this.sourceLang = track.language || '';
      const original = this.touchedTracks.find(t => t.track === track);
      if (track.mode === 'hidden' && original?.mode === 'showing' && (!cfg.hideNativeCaptions || cfg.showSubtitles === false)) {
        track.mode = 'showing';
      }
      if (track.mode === 'disabled') {
        if (!original) this.touchedTracks.push({ track, mode: 'disabled' });
        track.mode = 'hidden';
      }
      if (track.mode === 'showing' && cfg.hideNativeCaptions && cfg.showSubtitles !== false) {
        if (!original) this.touchedTracks.push({ track, mode: 'showing' });
        track.mode = 'hidden';
      }
      const cues = track.activeCues ? Array.from(track.activeCues) : [];
      // Native tracks may already contain the next finalized cue. Prepare just
      // one, up to four seconds ahead, without displaying or speaking it early.
      let left = 0, right = track.cues?.length || 0;
      while (left < right) {
        const mid = (left + right) >>> 1;
        if (track.cues[mid].startTime <= v.currentTime) left = mid + 1;
        else right = mid;
      }
      const next = track.cues?.[left];
      if (next) {
        const ahead = (next.startTime - v.currentTime) / playback.rate * 1000;
        const text = ntMarkCaptionTurns(next.text);
        const key = next.startTime + '\u0000' + text;
        if (ahead <= 4000 && text && text.length <= 600 && key !== this.lastPrefetch) {
          this.lastPrefetch = key;
          this.upcoming = {type:'NT_CAPTION_PREFETCH',text,sourceLang:cfg.sourceLang || this.sourceLang,
            sessionId,mediaVersion:playback.version,startAt:Date.now()+ahead};
        }
      }
      this.cueEnd = cues.length ? Math.max(...cues.map(cue => cue.endTime)) : null;
      this.cueStart = cues.length ? Math.min(...cues.map(cue => cue.startTime)) : null;
      // Keep speaker markup (<v Name>, dialogue dashes) as ">>" turns.
      return cues.map((c) => ntMarkCaptionTurns(c.text)).join(' ');
    },

    tick() {
      if (!active || playback.paused) return;
      let snap = null;
      try { snap = this.snapshot(); } catch (e) { snap = null; }
      this.currentSnapshot=NtSegmenter.norm(snap || '');
      if (snap !== null) this.everFound = true;
      if (snap && snap.trim()) this.everText = true;
      // WebVTT cues are already finalized: no sentence/stability wait is needed.
      if (this.cueEnd != null) {
        const key = this.cueEnd + '\u0000' + snap;
        if (key !== this.lastCue && snap) { this.lastCue = key; this.emit(snap); }
      } else this.seg.feed(snap || '');
      if (this.upcoming) chrome.runtime.sendMessage(this.upcoming).catch(() => {});

      const age = Date.now() - this.startedAt;
      let code = '';
      if (this.everText) code = 'captions_ok';
      else if (!this.everFound && age > 6000) code = 'captions_none';
      else code = 'captions_wait';
      if (code !== this.reported) {
        this.reported = code;
        chrome.runtime.sendMessage({ type: 'NT_CONTENT_STATUS', code, sessionId }).catch(() => {});
        if (code === 'captions_none') overlay.toast(t('captionsNone'), 9000);
      }
    }
  };
  function t(key) {
    const ru = /^ru|^uk|^be|^kk/i.test(cfg.uiLang || navigator.language);
    const dict = {
      captionsNone: ru ? 'NeiroTranslate: субтитры не найдены — включите CC в плеере или режим «ИИ слушает звук»'
                       : 'NeiroTranslate: no subtitles found — turn on CC or use “AI listens to audio”'
    };
    return dict[key] || key;
  }

  // ─── Native caption hiding ────────────────────────────────
  function setHideNative(on) {
    let style = document.getElementById(HIDE_STYLE_ID);
    if (!on) { if (style) style.remove(); return; }
    if (style) return;
    style = document.createElement('style');
    style.id = HIDE_STYLE_ID;
    style.textContent = '.ytp-caption-window-container, .player-timedtext, .vjs-text-track-display, .jw-captions, .shaka-text-container, .plyr__captions { opacity: 0 !important; }';
    (document.head || document.documentElement).appendChild(style);
  }

  // ─── Ducking (captions mode only) ─────────────────────────
  const duck = {
    on: false, base: new Map(), releaseTimer: 0, ramps: new Map(), expected: new WeakMap(),

    set(on) {
      clearTimeout(this.releaseTimer);
      if (on) this.apply(true);
      else this.releaseTimer = setTimeout(() => this.apply(false), 500);
    },

    apply(on, force = false) {
      if (on === this.on && !force) return;
      this.on = on;
      const factor = Math.max(0, Math.min(1, Number(cfg.originalVolume)));
      document.querySelectorAll('video, audio').forEach((m) => {
        if (on) {
          if (!this.base.has(m)) this.base.set(m, m.volume);
          this.ramp(m, this.base.get(m) * factor);
        } else if (this.base.has(m)) {
          this.ramp(m, this.base.get(m));
        }
      });
      if (!on) setTimeout(() => { if (!this.on) this.base.clear(); }, 400);
    },

    ramp(m, target) {
      clearInterval(this.ramps.get(m));
      const from = m.volume;
      let step = 0;
      const steps = 6;
      const timer = setInterval(() => {
        step++;
        const value = Math.max(0, Math.min(1, from + (target - from) * (step / steps)));
        this.expected.set(m, value);
        try { m.volume = value; } catch (e) { /* ignore */ }
        if (step >= steps) { clearInterval(timer); this.ramps.delete(m); }
      }, 25);
      this.ramps.set(m, timer);
    },

    reset() {
      clearTimeout(this.releaseTimer);
      this.on = false;
      this.ramps.forEach(clearInterval); this.ramps.clear();
      this.base.forEach((volume, media) => { this.expected.set(media, volume); media.volume = volume; });
      this.base.clear();
    }
  };

  document.addEventListener('volumechange', (e) => {
    // User moved the volume slider while ducked: remember it as the new base level.
    if (!duck.on || !(e.target instanceof HTMLMediaElement)) return;
    if (Math.abs(e.target.volume - (duck.expected.get(e.target) ?? -1)) < 0.0001) return;
    clearInterval(duck.ramps.get(e.target)); duck.ramps.delete(e.target);
    duck.base.set(e.target, e.target.volume);
  }, true);

  // ─── Lifecycle ────────────────────────────────────────────
  function start(settings, resume, id, version = 0) {
    if (active) stop();
    cfg = Object.assign({}, settings);
    sessionId = id;
    active = true;
    overlay.mount();
    playback.start(version);
    if (cfg.source === 'captions') {
      setHideNative(cfg.hideNativeCaptions && cfg.showSubtitles !== false);
      reader.start();
    }
  }

  function stop() {
    active = false;
    playback.stop();
    reader.stop();
    duck.reset();
    setHideNative(false);
    overlay.unmount();
  }

  function applySettings(patch) {
    const previous = cfg;
    cfg = Object.assign({}, cfg, patch);
    if (previous.originalVolume !== cfg.originalVolume && duck.on) duck.apply(true, true);
    if (['voice','targetLang','sourceLang'].some(key => previous[key] !== cfg[key])) reader.lastPrefetch = '';
    overlay.applyStyle();
    if (cfg.source === 'captions') setHideNative(cfg.hideNativeCaptions && cfg.showSubtitles !== false);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !active) return;
    applySettings(Object.fromEntries(Object.entries(changes).map(([key,change]) => [key,change.newValue])));
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case 'NT_PING': sendResponse({ ok: true }); break;
      case 'NT_C_START': start(msg.settings, msg.resume, msg.sessionId, msg.mediaVersion); sendResponse({ ok: true }); break;
      case 'NT_C_STOP': stop(); sendResponse({ ok: true }); break;
      case 'NT_C_SETTINGS':
        if (active && msg.sessionId === sessionId) applySettings(msg.settings);
        sendResponse({ok:true});break;
      case 'NT_C_REFRESH':
        if (active && cfg.source === 'captions') {reader.lastCue='';reader.lastPrefetch='';reader.seg?.reset();reader.tick();}
        sendResponse({ok:true});break;
      case 'NT_C_CHECK_CAPTION': {
        const text=NtSegmenter.norm(msg.text);
        const present=text && (' '+(reader.currentSnapshot || '')+' ').includes(' '+text+' ');
        const current=!!(active && !playback.paused && msg.sessionId===sessionId && msg.mediaVersion===playback.version && present &&
          (reader.cueEnd==null || reader.cueEnd>playback.video?.currentTime));
        sendResponse({current,deadline:current?playback.deadline():0});break;
      }
      case 'NT_C_SUBTITLE':
        if (active && msg.sessionId === sessionId && msg.mediaVersion === playback.version && !playback.paused) overlay.show(msg.text, msg.original, msg.final, msg.deadline);
        break;
      case 'NT_C_DUCK': if (active && !playback.paused && cfg.source === 'captions') duck.set(!!msg.on); break;
      default: break;
    }
    return false;
  });
})();
