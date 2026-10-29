// NeiroTranslate — AudioWorklet: mixes to mono, resamples to the target rate (16 kHz by default)
// and posts 100 ms Int16 PCM chunks. When the owning AudioContext already runs at 16 kHz the
// resampler is a no-op and the browser's high-quality resampling is used.
class NtPcmChunker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.targetRate = o.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate; // input samples per output sample
    this.pos = 0;                              // fractional read position into the current block
    this.prev = 0;                             // last sample of the previous block
    this.chunkSize = Math.round(this.targetRate * (o.chunkMs || 100) / 1000);
    this.buf = new Int16Array(this.chunkSize);
    this.len = 0;
  }

  push(s) {
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    this.buf[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.len === this.chunkSize) {
      const out = this.buf;
      this.port.postMessage(out.buffer, [out.buffer]);
      this.buf = new Int16Array(this.chunkSize);
      this.len = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0].length) return true;
    const channels = input.length;
    const frames = input[0].length;
    const mono = new Float32Array(frames);
    for (let c = 0; c < channels; c++) {
      const ch = input[c];
      for (let i = 0; i < frames; i++) mono[i] += ch[i] / channels;
    }

    if (Math.abs(this.ratio - 1) < 1e-6) {
      for (let i = 0; i < frames; i++) this.push(mono[i]);
      return true;
    }

    // Linear interpolation; position -1 refers to the previous block's last sample.
    while (this.pos < frames) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i - 1 < 0 ? this.prev : mono[i - 1];
      const b = mono[i];
      this.push(a + (b - a) * frac);
      this.pos += this.ratio;
    }
    this.pos -= frames;
    this.prev = mono[frames - 1];
    return true;
  }
}

registerProcessor('nt-pcm-chunker', NtPcmChunker);
