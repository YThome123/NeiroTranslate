// NeiroTranslate — who is speaking. Two independent signals:
//   1. caption markup: WebVTT <v Name>, ">>" turn markers, dialogue dashes, NAME: labels;
//   2. tab audio: pitch (F0) of the original speech, clustered online into speakers.
// Each speaker gets a stable voice profile, so different people get different voices.
// Loaded by the content script, worker, audio page and the analysis AudioWorklet,
// so it must not touch DOM or extension APIs.
(function (root) {
  const NT_SPEAKERS = {
    // Pitch search range covers adult and child speech; outside it is noise/music.
    MIN_HZ: 70, MAX_HZ: 400,
    YIN_THRESHOLD: 0.15,
    // Below this median F0 a speaker gets a low ("male-sounding") voice.
    LOW_PITCH_HZ: 165,
    // Distance in octaves that starts a new speaker. Same speaker phrases vary
    // ~1-2 semitones; different speakers of one gender ~2-6. Lower = more splits.
    NEW_SPEAKER_OCTAVES: 0.27,
    // Keep the previous speaker unless the new phrase is clearly elsewhere.
    STICKY_OCTAVES: 0.36,
    MAX_CLUSTERS: 6,
    // Minimum voiced analysis frames (20 ms each) before audio may name a speaker.
    MIN_VOICED_FRAMES: 6,
    MAX_PROFILES: 8
  };

  // ─── Caption markup ─────────────────────────────────────────
  /** Raw multi-line cue text → single line with ">>" before each new speaker. */
  function markCaptionTurns(raw) {
    const text = String(raw || '')
      .replace(/<v(?:\.[^\s>]*)?\s+([^>]+)>/gi, (m, name) => '\n>> ' + name.trim().slice(0, 40) + ': ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return text.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      // A line opening with a dash is a dialogue turn in subtitle convention.
      return /^[-‐–—]\s*\S/.test(trimmed) ? '>> ' + trimmed.replace(/^[-‐–—]\s*/, '') : trimmed;
    }).filter(Boolean).join(' ');
  }

  // "JOHN:" or, right after ">>", "John:" names a speaker. Mixed-case labels
  // elsewhere ("Note: ...") are ordinary text.
  const LABEL_ANY = /^\s*([\p{Lu}][\p{Lu}\p{N} .'’-]{2,30}):\s+(?=\S)/u;
  const LABEL_TURN = /^\s*([\p{Lu}][\p{L}\p{N} .'’-]{0,30}):\s+(?=\S)/u;

  /** Caption text → [{text, name, turn}] in spoken order. */
  function parseTurns(text) {
    const chunks = String(text || '').split(/\s*>{2,}\s*/);
    const parts = [];
    chunks.forEach((chunk, i) => {
      let body = chunk.replace(/\s+/g, ' ').trim();
      if (!body) return;
      const turn = i > 0;
      let name = null;
      const label = (turn ? LABEL_TURN : LABEL_ANY).exec(body);
      if (label && /[\p{L}]/u.test(label[1])) { name = label[1].trim(); body = body.slice(label[0].length).trim(); }
      if (body) parts.push({ text: body, name, turn });
    });
    return parts;
  }

  /** Text to actually speak: no [Music], (laughs), ♪ lyrics or asterisks. */
  function speakableText(text) {
    return String(text || '')
      .replace(/\[[^\]]{0,60}\]|\([^)]{0,40}\)|♪[^♪]{0,200}♪?|[♪♫*]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // ─── Pitch ──────────────────────────────────────────────────
  /** YIN fundamental frequency of `frame` in Hz, or 0 when unvoiced. */
  function detectPitch(frame, sampleRate, opts = {}) {
    const minHz = opts.minHz || NT_SPEAKERS.MIN_HZ, maxHz = opts.maxHz || NT_SPEAKERS.MAX_HZ;
    const threshold = opts.threshold || NT_SPEAKERS.YIN_THRESHOLD;
    const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
    const maxLag = Math.ceil(sampleRate / minHz);
    const width = frame.length - maxLag;
    if (width < minLag * 2 || maxLag <= minLag) return 0;
    const diff = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < width; i++) { const d = frame[i] - frame[i + lag]; sum += d * d; }
      diff[lag] = sum;
    }
    // Cumulative mean normalised difference from lag 1 so the threshold is meaningful.
    let running = 0;
    for (let lag = 1; lag < minLag; lag++) {
      let sum = 0;
      for (let i = 0; i < width; i++) { const d = frame[i] - frame[i + lag]; sum += d * d; }
      running += sum;
    }
    let best = -1;
    const cmnd = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      running += diff[lag];
      cmnd[lag] = running > 0 ? diff[lag] * lag / running : 1;
    }
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (cmnd[lag] < threshold) {
        while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++;
        best = lag; break;
      }
    }
    if (best < 0) return 0;
    // Parabolic interpolation for sub-sample period accuracy.
    let period = best;
    if (best > minLag && best < maxLag) {
      const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
      const den = a + c - 2 * b;
      if (Math.abs(den) > 1e-12) period = best + (a - c) / (2 * den);
    }
    const hz = sampleRate / period;
    return hz >= minHz && hz <= maxHz ? hz : 0;
  }

  /** Frames [{wall, f0, rms}] within [from, to] → median log2 F0 of voiced speech. */
  function summarizePitch(frames, from, to) {
    if (!Array.isArray(frames) || !(to > from)) return null;
    const inRange = frames.filter(f => f.wall >= from && f.wall <= to);
    if (!inRange.length) return null;
    // Adaptive floor: ignore quiet frames relative to this window's loud speech.
    const loud = inRange.map(f => f.rms).sort((a, b) => a - b);
    const floor = Math.max(0.004, loud[Math.floor(loud.length * 0.9)] * 0.12);
    const voiced = inRange.filter(f => f.f0 > 0 && f.rms >= floor).map(f => Math.log2(f.f0)).sort((a, b) => a - b);
    if (voiced.length < NT_SPEAKERS.MIN_VOICED_FRAMES) return null;
    return { log2: voiced[voiced.length >> 1], voiced: voiced.length };
  }

  /** Online 1-D clustering of phrase pitch into speakers. */
  class NtSpeakerClusters {
    constructor() { this.reset(); }
    reset() { this.items = []; this.nextId = 1; this.aliases = new Map(); }
    assign(log2, weight = 1, previousId = null) {
      if (!Number.isFinite(log2)) return null;
      let nearest = null, distance = Infinity;
      for (const item of this.items) {
        const d = Math.abs(item.mean - log2);
        if (d < distance) { nearest = item; distance = d; }
      }
      const previousKey = this.aliases.get(previousId) ?? previousId;
      const previous = this.items.find(item => item.id === previousKey);
      let target;
      if (previous && Math.abs(previous.mean - log2) < NT_SPEAKERS.STICKY_OCTAVES &&
          (nearest === previous || distance > NT_SPEAKERS.NEW_SPEAKER_OCTAVES * 0.5)) target = previous;
      else if (nearest && distance < NT_SPEAKERS.NEW_SPEAKER_OCTAVES) target = nearest;
      else if (this.items.length < NT_SPEAKERS.MAX_CLUSTERS) {
        target = { id: this.nextId++, mean: log2, n: 0 };
        this.items.push(target);
      } else target = nearest;
      // Bounded weight keeps a centroid adaptive across a long stream.
      const w = Math.min(weight, 40);
      target.n = Math.min(target.n + w, 200);
      target.mean += (log2 - target.mean) * (w / target.n);
      this.merge();
      const hz = Math.pow(2, target.mean);
      return { cluster: target.id, hz: Math.round(hz), pitchClass: hz < NT_SPEAKERS.LOW_PITCH_HZ ? 'low' : 'high' };
    }
    merge() {
      for (let i = 0; i < this.items.length; i++) {
        for (let j = i + 1; j < this.items.length; j++) {
          const a = this.items[i], b = this.items[j];
          if (Math.abs(a.mean - b.mean) >= NT_SPEAKERS.NEW_SPEAKER_OCTAVES * 0.5) continue;
          const keep = a.n >= b.n ? a : b, drop = keep === a ? b : a;
          keep.mean = (keep.mean * keep.n + drop.mean * drop.n) / Math.max(1, keep.n + drop.n);
          keep.n = Math.min(keep.n + drop.n, 200);
          this.items.splice(this.items.indexOf(drop), 1);
          for (const [from, to] of this.aliases) if (to === drop.id) this.aliases.set(from, keep.id);
          this.aliases.set(drop.id, keep.id);
          if (this.aliases.size > 64) this.aliases.delete(this.aliases.keys().next().value);
          return this.merge();
        }
      }
    }
  }

  /** Stable speaker → profile mapping for one session. */
  class NtSpeakerBook {
    constructor() { this.reset(); }
    reset() { this.profiles = new Map(); this.last = null; this.counter = 0; this.lastCluster = null; }
    get size() { return this.profiles.size; }
    /**
     * @param part {name, turn} from parseTurns
     * @param acoustic {cluster, pitchClass} for the phrase, or null
     * @param index position of the part in its caption
     */
    resolve(part, acoustic, index = 0) {
      let key;
      if (part && part.name) key = 'n:' + part.name.toLowerCase();
      else if (acoustic && acoustic.cluster != null && index === 0) key = 'a:' + acoustic.cluster;
      else if (part && part.turn) {
        // Turn marker without a name: the other recent speaker, else a new one.
        const others = [...this.profiles.values()].filter(p => p.key !== this.last).sort((a, b) => b.seen - a.seen);
        key = others.length ? others[0].key : 't:' + this.profiles.size;
      } else key = this.last || 't:0';
      let profile = this.profiles.get(key);
      if (!profile) {
        profile = { key, index: this.profiles.size ? Math.max(...[...this.profiles.values()].map(p => p.index)) + 1 : 0, pitchClass: null, voices: {} };
        this.profiles.set(key, profile);
        if (this.profiles.size > NT_SPEAKERS.MAX_PROFILES) {
          const oldest = [...this.profiles.values()].filter(p => p !== profile).sort((a, b) => a.seen - b.seen)[0];
          this.profiles.delete(oldest.key);
        }
      }
      if (acoustic && acoustic.pitchClass && index === 0) profile.pitchClass = acoustic.pitchClass;
      profile.seen = ++this.counter;
      this.last = key;
      if (acoustic && acoustic.cluster != null) this.lastCluster = acoustic.cluster;
      return profile;
    }
    /** Earlier speakers of the same pitch class; used to keep their voices apart. */
    rank(profile) {
      return [...this.profiles.values()].filter(p => p !== profile && p.index < profile.index && p.pitchClass === profile.pitchClass).length;
    }
    taken(provider, profile) {
      return new Set([...this.profiles.values()].filter(p => p !== profile && p.voices[provider]).map(p => p.voices[provider]));
    }
  }

  // ─── Voice choice per provider ─────────────────────────────
  const MALE = /\b(pavel|dmitry|dmitri|yuri|maxim|david|mark|guy|george|james|richard|ryan|eric|christopher|roger|steffan|brian|andrew|thomas|daniel|alex|fred|conrad|killian|henri|paul|pablo|alvaro|jorge|diego|raul|cosimo|stefan|filipp|ermil|zahar|madi|john|male|мужской)\b/i;
  const FEMALE = /\b(irina|svetlana|dariya|ekaterina|milena|katya|zira|aria|jenny|hazel|susan|libby|sonia|catherine|heera|samantha|karen|moira|tessa|victoria|anna|helena|laura|hedda|katja|amala|elsa|denise|julie|hortense|sabina|paulina|monica|lucia|isabella|marina|jane|omazh|alena|amira|nigora|lea|female|женский)\b/i;
  function guessGender(name) {
    const n = String(name || '');
    if (FEMALE.test(n)) return 'female';
    if (MALE.test(n)) return 'male';
    // Chrome's bundled "Google <language>" voices are female unless labelled.
    if (/^google\s/i.test(n)) return 'female';
    return null;
  }

  const YANDEX_BY_LANG = {
    ru: { female: ['marina', 'jane', 'omazh'], male: ['filipp', 'ermil', 'zahar', 'madi_ru'] },
    en: { female: [], male: ['john'] }, de: { female: ['lea'], male: [] },
    kk: { female: ['amira'], male: ['madi'] }, uz: { female: ['nigora'], male: [] }
  };

  // Pitch factors when two speakers must share one voice. 1 = untouched.
  const SHARED_PITCH = [1, 0.8, 1.16, 0.7, 1.3];
  const PITCH_FOR_CLASS = { low: 0.8, high: 1 };

  function wantedGender(profile) {
    return profile.pitchClass === 'low' ? 'male' : profile.pitchClass === 'high' ? 'female' : null;
  }

  // Pitch that pushes a voice of `voiceGender` toward the speaker's class.
  function correctivePitch(profile, voiceGender, rank) {
    const want = wantedGender(profile);
    let pitch = 1;
    if (want && voiceGender && want !== voiceGender) pitch = want === 'male' ? 0.82 : 1.18;
    if (rank) pitch *= rank % 2 ? 0.9 : 1.1;
    return pitch;
  }

  /**
   * Voice parameters for one speaker.
   * provider 'browser': opts {voices:[{voiceName,remote}], primary}
   * provider 'google'|'yandex'|'elevenlabs': opts {settings, lang}
   * Returns {voiceName?, yandexVoice?, elevenVoiceId?, pitch}.
   */
  function pickSpeakerVoice(provider, profile, book, opts = {}) {
    if (!profile) return { pitch: 1 };
    const rank = book ? book.rank(profile) : 0;
    if (provider === 'browser') {
      const primary = opts.primary;
      if (profile.index === 0) return { voiceName: primary, pitch: 1 };
      let name = profile.voices.browser;
      const voices = (opts.voices || []).map(v => v.voiceName).filter(Boolean);
      if (!name || !voices.includes(name)) {
        const taken = book ? book.taken('browser', profile) : new Set();
        const want = wantedGender(profile);
        const free = voices.filter(v => v !== primary && !taken.has(v));
        name = free.find(v => want && guessGender(v) === want) || free.find(v => !want || !guessGender(v)) || free[0] || null;
        if (name) profile.voices.browser = name;
      }
      if (name) return { voiceName: name, pitch: correctivePitch(profile, guessGender(name), 0) };
      // Only one voice installed: separate speakers by pitch alone.
      const pitch = profile.pitchClass ? correctivePitch(profile, guessGender(primary), rank) : SHARED_PITCH[profile.index % SHARED_PITCH.length];
      return { voiceName: primary, pitch };
    }
    if (provider === 'google') {
      // The Google Translate voice is a single (female) voice for every language.
      if (!profile.pitchClass) return { pitch: SHARED_PITCH[profile.index % SHARED_PITCH.length] };
      const base = PITCH_FOR_CLASS[profile.pitchClass];
      return { pitch: rank ? base * (rank % 2 ? 1.1 : 0.92) : base };
    }
    if (provider === 'yandex') {
      const s = opts.settings || {};
      const pools = YANDEX_BY_LANG[(opts.lang || 'ru').split('-')[0]] || YANDEX_BY_LANG.ru;
      const all = [...pools.female, ...pools.male];
      const primary = all.includes(s.yandexVoice) ? s.yandexVoice : all[0];
      if (profile.index === 0 || !all.length) return { yandexVoice: primary, pitch: 1 };
      const want = wantedGender(profile);
      const taken = book ? book.taken('yandex', profile) : new Set();
      let voice = profile.voices.yandex;
      if (!voice || !all.includes(voice)) {
        const ordered = want ? [...pools[want], ...pools[want === 'male' ? 'female' : 'male']] : all;
        voice = ordered.find(v => v !== primary && !taken.has(v)) || ordered.find(v => v !== primary) || primary;
        profile.voices.yandex = voice;
      }
      const gender = pools.male.includes(voice) ? 'male' : 'female';
      return { yandexVoice: voice, pitch: voice === primary ? correctivePitch(profile, gender, rank || 1) : correctivePitch(profile, gender, 0) };
    }
    if (provider === 'elevenlabs') {
      const s = opts.settings || {};
      const second = String(s.elevenVoiceId2 || '').trim();
      if (profile.index === 0 || !second) return { elevenVoiceId: s.elevenVoiceId, pitch: 1 };
      return { elevenVoiceId: profile.index % 2 ? second : s.elevenVoiceId, pitch: 1 };
    }
    return { pitch: 1 };
  }

  root.NT_SPEAKERS = NT_SPEAKERS;
  root.ntMarkCaptionTurns = markCaptionTurns;
  root.ntParseSpeakerTurns = parseTurns;
  root.ntSpeakableText = speakableText;
  root.ntDetectPitch = detectPitch;
  root.ntSummarizePitch = summarizePitch;
  root.ntGuessVoiceGender = guessGender;
  root.ntPickSpeakerVoice = pickSpeakerVoice;
  root.NtSpeakerClusters = NtSpeakerClusters;
  root.NtSpeakerBook = NtSpeakerBook;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NT_SPEAKERS, ntMarkCaptionTurns: markCaptionTurns, ntParseSpeakerTurns: parseTurns,
      ntSpeakableText: speakableText, ntDetectPitch: detectPitch, ntSummarizePitch: summarizePitch,
      ntGuessVoiceGender: guessGender, ntPickSpeakerVoice: pickSpeakerVoice, NtSpeakerClusters, NtSpeakerBook };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
