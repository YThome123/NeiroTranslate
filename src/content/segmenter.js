// NeiroTranslate — caption segmenter (shared by the content script and unit tests).
// Turns successive snapshots of on-screen captions (rolling auto-captions or discrete cues)
// into clean, non-duplicated sentences. Each emitted sentence carries {since, at}: when
// its first words appeared and when its text became final — the voice-over is timed
// from these, and speaker detection listens to the audio between them.
class NtSegmenter {
  constructor(emit, options = {}) {
    this.emit = emit;
    this.stableMs = options.stableMs ?? 250;
    this.maxWaitMs = options.maxWaitMs ?? 700;
    this.reset();
  }

  reset() { this.committed = ''; this.pending = ''; this.last = ''; this.lastChange = 0; this.lastEmit = ''; this.pendingSince = null; }

  static norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

  overlap(text) {
    const tail = this.committed;
    const max = Math.min(tail.length, text.length);
    for (let k = max; k >= 3; k--) {
      if (text.startsWith(tail.slice(tail.length - k))) {
        const before = tail.length - k - 1;
        if (before < 0 || tail[before] === ' ') return k;
      }
    }
    return 0;
  }

  static sameStart(a, b) {
    const wa = a.toLowerCase().split(' ');
    const wb = b.toLowerCase().split(' ');
    let n = 0;
    while (n < wa.length && n < wb.length && wa[n] === wb[n]) n++;
    return n >= Math.max(1, Math.floor(wa.length * 0.6));
  }

  commit(text, at) {
    const t = NtSegmenter.norm(text);
    if (!t) return;
    const since = this.pendingSince ?? at;
    this.committed = (this.committed + ' ' + t).trim().slice(-500);
    if (t !== this.lastEmit && /[\p{L}\p{N}]/u.test(t)) { this.lastEmit = t; this.emit(t, { since: Math.min(since, at), at }); }
    // Whatever is still pending started no earlier than this commit.
    this.pendingSince = at;
  }

  feed(raw, now = Date.now()) {
    const text = NtSegmenter.norm(raw);
    if (text === this.last) {
      if (this.pending && now - this.lastChange >= this.stableMs) { this.commit(this.pending, this.lastChange); this.pending = ''; this.pendingSince = null; }
      return;
    }
    const previousChange = this.lastChange;
    this.last = text;
    this.lastChange = now;
    if (!text) { if (this.pending) this.commit(this.pending, previousChange); this.pending = ''; this.pendingSince = null; return; }

    let fresh = NtSegmenter.norm(text.slice(this.overlap(text)));
    if (this.pending && fresh && !fresh.startsWith(this.pending) && !NtSegmenter.sameStart(this.pending, fresh)) {
      this.commit(this.pending, previousChange); // previous cue was replaced by a new one
      this.pendingSince = now;
      fresh = NtSegmenter.norm(text.slice(this.overlap(text)));
    }
    if (!this.pending || this.pendingSince == null) this.pendingSince = now;
    // Commit finished sentences right away, keep the unfinished tail pending.
    const m = fresh.match(/^(.*[.!?…。！？]["»”')\]]?)\s+(.*)$/s);
    if (m && m[1].length > 2) { this.commit(m[1], now); fresh = m[2]; }
    while (fresh.length > 170) {
      const cut = fresh.lastIndexOf(' ', 150);
      this.commit(fresh.slice(0, cut > 40 ? cut : 150), now);
      fresh = fresh.slice(cut > 40 ? cut : 150).trim();
    }
    if (fresh && /[.!?…。！？]["»”')\]]?$/.test(fresh)) { this.commit(fresh, now); fresh = ''; }
    this.pending = fresh;
    if (!fresh) this.pendingSince = null;
    if (fresh && now - this.pendingSince >= this.maxWaitMs) { this.commit(fresh, now); this.pending = ''; this.pendingSince = null; }
  }

  flush() { if (this.pending) this.commit(this.pending, this.lastChange || Date.now()); this.pending = ''; this.pendingSince = null; }
}

if (typeof globalThis !== 'undefined') globalThis.NtSegmenter = NtSegmenter;
if (typeof module !== 'undefined') module.exports = { NtSegmenter };
