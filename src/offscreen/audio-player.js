// NeiroTranslate — gapless PCM player with lag control and "speaking" detection.
class NtAudioPlayer {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination
   * @param {(speaking: boolean) => void} onSpeaking
   */
  constructor(ctx, destination, onSpeaking) {
    this.ctx = ctx;
    this.destination = destination;
    this.onSpeaking = onSpeaking || (() => {});
    this.endTime = 0;
    this.deadline = Infinity;
    this.startBy = Infinity; // wall time: applies only to the first source
    this.started = false;
    this.generation = 0;
    this.shaping = new Set();
    this.work = Promise.resolve();
    this.shaper = null;
    this.resumeWaiters = new Set();
    this.sources = new Set();
    this.idleWaiters = new Set();
    this.speaking = false;
    this.releaseMs = 450;
    this.catchUp = false;   // enabled for continuous streams only (Gemini voice)
    this.dropAfterSec = 5;  // with catchUp: backlog beyond this is discarded
    this.carry = null; // odd trailing byte between streamed chunks
    this.pcmPending = null; // optional fixed-size blocks for streamed stretching
    this.pcmJoinSource = null;
    this.timer = setInterval(() => this._tick(), 100);
  }

  /** Seconds of audio already scheduled after "now". */
  get aheadSec() {
    return Math.max(0, this.endTime - this.ctx.currentTime);
  }

  /** Enqueue little-endian Int16 mono PCM. Handles odd byte counts from streams. */
  enqueuePcm16(arrayBuffer, sampleRate, shape) {
    let bytes = new Uint8Array(arrayBuffer);
    if (shape?.stream) {
      if (this.pcmPending && this.pcmPending.sampleRate !== sampleRate) this.flushPcm16();
      const pending = this.pcmPending || { sampleRate, shape: { ...shape, stream: false, pcmJoin: true }, bytes: new Uint8Array(0) };
      const merged = new Uint8Array(pending.bytes.length + bytes.length);
      merged.set(pending.bytes); merged.set(bytes, pending.bytes.length);
      // Use the same 120ms WSOLA blocks regardless of HTTP/WebSocket packet
      // boundaries. 40ms of following audio keeps WSOLA's 30ms analysis window
      // away from a synthetic zero-padded edge. Only the first block waits.
      const blockBytes = Math.max(2, Math.round(sampleRate * 0.12) * 2);
      const lookaheadBytes = Math.max(2, Math.round(sampleRate * 0.04) * 2);
      let offset = 0, scheduled = false;
      while (offset + blockBytes + lookaheadBytes <= merged.length) {
        scheduled = this.enqueuePcm16(merged.slice(offset, offset + blockBytes + lookaheadBytes).buffer,
          sampleRate, { ...pending.shape, pcmCoreSamples: blockBytes / 2 }) || scheduled;
        offset += blockBytes;
      }
      pending.bytes = merged.slice(offset);
      this.pcmPending = pending;
      return scheduled;
    }
    if (this.carry) {
      const merged = new Uint8Array(this.carry.length + bytes.length);
      merged.set(this.carry, 0);
      merged.set(bytes, this.carry.length);
      bytes = merged;
      this.carry = null;
    }
    if (bytes.length % 2 === 1) {
      this.carry = bytes.slice(bytes.length - 1);
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length < 2) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = bytes.length / 2;
    const audioBuffer = this.ctx.createBuffer(1, n, sampleRate);
    const ch = audioBuffer.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    return this.enqueueBuffer(audioBuffer, shape);
  }

  /** Deliver the short final tail once synthesis is finished. */
  flushPcm16() {
    const pending = this.pcmPending;
    this.pcmPending = null;
    if (!pending?.bytes.length) return false;
    const coreBytes = pending.bytes.length - pending.bytes.length % 2;
    if (!coreBytes) return false;
    const padded = new Uint8Array(coreBytes + Math.round(pending.sampleRate * 0.04) * 2);
    padded.set(pending.bytes.subarray(0, coreBytes));
    return this.enqueuePcm16(padded.buffer, pending.sampleRate, { ...pending.shape, pcmCoreSamples: coreBytes / 2 });
  }

  /** Wall-clock ms at which everything scheduled so far ends. */
  get endWall() {
    return Date.now() + Math.max(0, this.endTime - this.ctx.currentTime) * 1000;
  }

  /** Wall-clock ms at which newly enqueued audio would start playing. */
  get nextStartWall() {
    const now = this.ctx.currentTime;
    return Date.now() + Math.max(0.06, this.endTime - now) * 1000;
  }

  /** Serialized production path; clear invalidates both queued and active work. */
  _enqueueWork(run) {
    const generation = this.generation, ticket = {};
    this.shaping.add(ticket);
    const result = this.work.then(async () =>
      await this._ready(generation) && generation === this.generation ? run(generation) : false);
    this.work = result.catch(() => {});
    return result.finally(() => { this.shaping.delete(ticket); this._notifyIdle(); });
  }

  enqueueBufferAsync(audioBuffer, shape = {}) {
    return this._enqueueWork(generation => this._shapeAndSchedule(audioBuffer, shape, generation));
  }

  /** A frozen audio clock cannot establish an audible first start. */
  async _ready(generation) {
    const current = () => generation === this.generation &&
      (this.started || this.nextStartWall <= this.startBy);
    if (!current()) return false;
    if (this.ctx.state === 'running') return true;
    if (this.ctx.state !== 'suspended') return false;
    let cancel, timer;
    const cancelled = new Promise(resolve => {
      cancel = resolve;
      this.resumeWaiters.add(cancel);
      if (!this.started && Number.isFinite(this.startBy)) {
        timer = setTimeout(() => resolve(false), Math.max(0, this.startBy - this.nextStartWall));
      }
    });
    try {
      const resumed = await Promise.race([this.ctx.resume().then(() => true), cancelled]);
      return resumed && current() && this.ctx.state === 'running';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.resumeWaiters.delete(cancel);
    }
  }

  async _shapeAndSchedule(audioBuffer, shape, generation) {
    if (!this.started && this.nextStartWall > this.startBy) return false;
    let tempo = shape.resolveTempo ? shape.resolveTempo() : shape.tempo;
    tempo = Number.isFinite(tempo) && tempo > 0 ? tempo : 1;
    const pitch = Number.isFinite(shape.pitch) && shape.pitch > 0 ? shape.pitch : 1;
    // Tiny stream chunks keep their existing cheap synchronous path.
    if (audioBuffer.duration <= 0.24 || audioBuffer.duration > 30 || Math.abs(pitch / tempo - 1) <= 0.015) {
      return this.enqueueBuffer(audioBuffer, {...shape, tempo});
    }
    if (!this.shaper) this.shaper = new NtAudioShaper();
    let buffer;
    // Fit once more after processing; the audio clock and source start are
    // always recomputed by enqueueBuffer, including the 60ms jitter buffer.
    for (let attempt = 0; attempt < 2; attempt++) {
      const channels = audioBuffer.numberOfChannels || 1;
      const mono = new Float32Array(audioBuffer.length);
      for (let c = 0; c < channels; c++) {
        const data = audioBuffer.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] += data[i] / channels;
      }
      const samples = await this.shaper.stretch(mono, pitch / tempo, audioBuffer.sampleRate);
      if (!samples || generation !== this.generation) return false;
      buffer = this.ctx.createBuffer(1, samples.length, audioBuffer.sampleRate);
      buffer.getChannelData(0).set(samples);
      const updated = shape.resolveTempo ? shape.resolveTempo() : tempo;
      if (attempt || !(updated > tempo * 1.015)) break;
      tempo = updated;
    }
    if (!await this._ready(generation) || generation !== this.generation) return false;
    return this.enqueueBuffer(buffer, {...shape, tempo, prepared: true});
  }

  enqueuePcm16Async(arrayBuffer, sampleRate, shape = {}) {
    return this._enqueueWork(async generation => {
      if (shape.stream) {
        // A provider may deliver many seconds in a single packet. Keep the
        // fixed WSOLA joins, but let cancellation run between small batches.
        const bytes = new Uint8Array(arrayBuffer), batch = Math.max(2, Math.round(sampleRate * 0.12) * 2);
        let scheduled = false;
        for (let offset = 0; offset < bytes.length; offset += batch) {
          if (!await this._ready(generation) || generation !== this.generation) return false;
          scheduled = this.enqueuePcm16(bytes.slice(offset, offset + batch).buffer, sampleRate, shape) || scheduled;
          if (offset + batch < bytes.length) await new Promise(resolve => setTimeout(resolve, 0));
        }
        return scheduled;
      }
      let bytes = new Uint8Array(arrayBuffer);
      if (this.carry) {
        const merged = new Uint8Array(bytes.length + 1);
        merged.set(this.carry); merged.set(bytes, 1); bytes = merged; this.carry = null;
      }
      if (bytes.length % 2) { this.carry = bytes.slice(-1); bytes = bytes.subarray(0, bytes.length - 1); }
      if (!bytes.length) return false;
      const buffer = this.ctx.createBuffer(1, bytes.length / 2, sampleRate), samples = buffer.getChannelData(0);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      return this._shapeAndSchedule(buffer, shape, generation);
    });
  }

  /**
   * Schedule an AudioBuffer right after the previous one.
   * shape.tempo speeds speech up keeping its pitch; shape.pitch shifts pitch
   * keeping its duration. Both are factors where 1 means untouched.
   */
  enqueueBuffer(audioBuffer, shape = {}) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const now = this.ctx.currentTime;
    const fresh = this.endTime < now + 0.01;
    let startAt = fresh ? now + 0.06 : this.endTime; // small jitter buffer for streamed audio

    // Live streams (Gemini voice) cannot be re-timed per phrase: when audio piles
    // up, speed the backlog and finally drop it so the voice stays near real time.
    const ahead = startAt - now;
    let catchUp = 1;
    if (this.catchUp) {
      if (ahead > this.dropAfterSec) return;
      catchUp = ahead > 2.5 ? 1.25 : ahead > 1.2 ? 1.12 : 1;
    }
    const tempo = Number.isFinite(shape.tempo) && shape.tempo > 0 ? shape.tempo : 1;
    const pitch = Number.isFinite(shape.pitch) && shape.pitch > 0 ? shape.pitch : 1;
    const coreDuration = shape.pcmCoreSamples > 0 ? Math.min(audioBuffer.duration, shape.pcmCoreSamples / audioBuffer.sampleRate) : audioBuffer.duration;
    const canStretch = typeof ntStretchAudioBuffer === 'function' && coreDuration >= 0.12;
    const continuing = shape.pcmJoin && !fresh && this.pcmJoinSource && this.sources.has(this.pcmJoinSource);
    let overlap = continuing && canStretch ? Math.min(0.004, Math.max(0, (this.endTime - now - 0.01) / 2)) : 0;
    let ratio = pitch / tempo + overlap * pitch / coreDuration;
    // Account for the overlap in stretched duration so joining blocks never
    // silently increases the configured speed. Near unity the stretcher has a
    // no-op tolerance; use a faded, non-overlapped boundary in that case.
    if (overlap && Math.abs(ratio - 1) < 0.015) { overlap = 0; ratio = pitch / tempo; }
    startAt -= overlap;
    let buffer = audioBuffer, rate = catchUp, stretched = false;
    // playbackRate multiplies pitch and speed together; pre-stretching by
    // pitch/tempo leaves exactly `tempo` speed and `pitch` pitch. Without the
    // stretcher fall back to rate change, except when preservePitch requests
    // a natural-speed short tail rather than a pitch-shifted last syllable.
    if (shape.prepared) {
      rate *= pitch;
    } else if (Math.abs(ratio - 1) > 0.015 && canStretch) {
      buffer = ntStretchAudioBuffer(this.ctx, audioBuffer, ratio);
      stretched = true;
      rate *= pitch;
    } else rate *= shape.preservePitch ? pitch : tempo;
    if (shape.pcmCoreSamples > 0) {
      // Analysis context is not new speech. Crop it after stretching so it is
      // neither repeated nor added to the next phrase's playback time.
      const length = Math.max(1, Math.min(buffer.length, Math.round(coreDuration * buffer.sampleRate * (stretched ? ratio : 1))));
      const cropped = this.ctx.createBuffer(1, length, buffer.sampleRate);
      cropped.getChannelData(0).set(buffer.getChannelData(0).subarray(0, length));
      buffer = cropped;
    }
    // Synchronous shaping can also consume time: refresh the clock immediately
    // before scheduling, and apply the first-start limit to the audible start.
    startAt = Math.max(startAt, this.ctx.currentTime + (fresh ? 0.06 : 0));
    if (!this.started && Date.now() + Math.max(0, startAt - this.ctx.currentTime) * 1000 > this.startBy) return false;
    const endAt = Math.min(startAt + buffer.duration / rate, this.deadline);
    if (endAt <= startAt) return false;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    if (shape.pcmJoin) {
      const fade = Math.min(0.004, (endAt - startAt) / 4);
      g.gain.setValueAtTime(0, startAt);
      g.gain.linearRampToValueAtTime(1, startAt + fade);
      g.gain.setValueAtTime(1, endAt - fade);
      g.gain.linearRampToValueAtTime(0, endAt);
    } else if (fresh) {
      g.gain.setValueAtTime(0, startAt);
      g.gain.linearRampToValueAtTime(1, startAt + 0.01);
    }
    src.connect(g);
    g.connect(this.destination);
    src.start(startAt);
    this.started = true;
    // Schedule expiry on the audio clock so a throttled background JS timer cannot
    // let an old phrase continue playing after the cue has ended.
    if (Number.isFinite(this.deadline)) src.stop(endAt);
    this.endTime = endAt;
    this.sources.add(src);
    this.pcmJoinSource = shape.pcmJoin ? src : null;
    src.onended = () => {
      this.sources.delete(src);
      try { src.disconnect(); g.disconnect(); } catch (e) { /* ignore */ }
      this._notifyIdle();
    };
    this._setSpeaking(true);
    return true;
  }

  clear() {
    this.generation++;
    for (const cancel of this.resumeWaiters) cancel(false);
    this.resumeWaiters.clear();
    this.shaper?.cancel();
    this.shaping.clear();
    this.work = Promise.resolve();
    for (const s of this.sources) { try { s.stop(); } catch (e) { /* ignore */ } }
    this.sources.clear();
    this.endTime = 0;
    this.deadline = Infinity;
    this.startBy = Infinity;
    this.started = false;
    this.carry = null;
    this.pcmPending = null;
    this.pcmJoinSource = null;
    this._setSpeaking(false);
    this._notifyIdle();
  }

  whenIdle() {
    if (!this.sources.size && !this.shaping.size) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }
  _notifyIdle() {
    if (this.sources.size || this.shaping.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  destroy() {
    this.clear();
    this.shaper?.destroy();
    this.shaper = null;
    clearInterval(this.timer);
    this._setSpeaking(false);
  }

  /** External playback (e.g. <audio> element) can also mark speaking. */
  markExternal(active) {
    this.external = active;
    if (active) this._setSpeaking(true);
  }

  _tick() {
    const busy = this.external || this.ctx.currentTime < this.endTime + this.releaseMs / 1000;
    if (!busy) this._setSpeaking(false);
  }

  _setSpeaking(on) {
    if (on === this.speaking) return;
    this.speaking = on;
    this.onSpeaking(on);
  }
}

self.NtAudioPlayer = NtAudioPlayer;
