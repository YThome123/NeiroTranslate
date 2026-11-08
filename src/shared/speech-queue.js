// A single actual voice at a time. Realtime keeps recent captions; retained
// complete-mode work rejects overflow and stays queued until played or cleared.
// Playback owns its completion promise; pause/settings changes abort the owner.
// An item may carry `cutAt`: once that time has passed AND a newer item waits,
// the current item is aborted so the voice catches up with the picture.
// `remaining()` (ms of speech left, or null when unknown) lets a phrase that is
// about to end anyway finish its last word instead of being cut — once.
class NtSpeechQueue {
  constructor({play, onError = () => {}, now = () => Date.now(), maxPending = 2, remaining = () => null, nearEndMs = 0}) {
    this.play = play; this.onError = onError; this.now = now; this.maxPending = maxPending;
    this.remaining = remaining; this.nearEndMs = nearEndMs;
    this.pending = []; this.current = null; this.generation = 0; this.cutTimer = 0;
  }
  get active() { return !!this.current; }
  get pendingCount() { return this.pending.length; }
  peek() { return this.pending[0] || null; }
  enqueue(item) {
    if (!item || (!item.retain && (!Number.isFinite(item.startBy) || item.startBy <= this.now()))) return false;
    if (item.retain && this.pending.length >= Math.max(1, this.maxPending)) return false;
    this.pending.push(item);
    while (this.pending.length > Math.max(1, this.maxPending)) this.pending.shift();
    this.pump();
    this.watchOverrun();
    return true;
  }
  clear() {
    this.generation++;
    clearTimeout(this.cutTimer);
    const previous = this.current;
    this.current = null; this.pending.length = 0;
    if (previous) previous.controller.abort();
  }
  watchOverrun() {
    clearTimeout(this.cutTimer);
    const owner = this.current;
    // A waiting phrase that already expired must not cut the current one:
    // that would leave silence where the current phrase could have finished.
    while (this.pending.length && !this.pending[0].retain && this.pending[0].startBy <= this.now()) this.pending.shift();
    if (!owner || !this.pending.length || !Number.isFinite(owner.item.cutAt)) return;
    const wait = owner.item.cutAt - this.now();
    if (wait <= 0) {
      const left = owner.graced ? null : this.remaining(owner.item);
      if (Number.isFinite(left) && left > 0 && left <= this.nearEndMs) {
        owner.graced = true;
        this.cutTimer = setTimeout(() => { if (this.current === owner) this.watchOverrun(); }, left + 150);
        return;
      }
      owner.controller.abort();
      return;
    }
    // Bounded: one timer, re-armed only while the same owner is playing.
    this.cutTimer = setTimeout(() => { if (this.current === owner) this.watchOverrun(); }, Math.min(wait, 15000));
  }
  pump() {
    if (this.current) return;
    let item;
    while ((item = this.pending.shift())) {
      if (item.retain || item.startBy > this.now()) break;
    }
    if (!item) return;
    const generation = this.generation, controller = new AbortController();
    const owner = {item, controller}; this.current = owner;
    Promise.resolve().then(() => {
      if (!controller.signal.aborted && (item.retain || item.startBy > this.now())) return this.play(item, controller.signal);
    }).catch(error => {
      if (generation === this.generation && !controller.signal.aborted) {
        try { this.onError(error, item); } catch (ignored) { /* Do not strand the queue. */ }
      }
    }).finally(() => {
      if (generation !== this.generation || this.current !== owner) return;
      clearTimeout(this.cutTimer);
      this.current = null; this.pump(); this.watchOverrun();
    });
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = {NtSpeechQueue};
else globalThis.NtSpeechQueue = NtSpeechQueue;
