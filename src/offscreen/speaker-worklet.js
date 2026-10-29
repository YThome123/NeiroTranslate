// NeiroTranslate — AudioWorklet: per-20ms pitch/loudness of the original tab audio.
// Requires ../shared/speakers.js to be added to the same worklet scope first
// (addModule order), which provides ntDetectPitch.

// Analysis runs at ~16 kHz: enough for voice pitch, and cheap. 1024-sample
// frames cover two periods of a 70 Hz voice.
const NT_ANALYSIS_RATE = 16000;
const NT_ANALYSIS_FRAME = 1024;
const NT_ANALYSIS_HOP = 320;     // 20 ms
const NT_ANALYSIS_BATCH = 10;    // post every 200 ms

class NtSpeakerAnalyser extends AudioWorkletProcessor {
  constructor() {
    super();
    // Integer decimation keeps this cheap when the context could not run at 16 kHz.
    this.decimate = Math.max(1, Math.round(sampleRate / NT_ANALYSIS_RATE));
    this.rate = sampleRate / this.decimate;
    this.ring = new Float32Array(NT_ANALYSIS_FRAME);
    this.frame = new Float32Array(NT_ANALYSIS_FRAME);
    this.write = 0;
    this.filled = 0;
    this.sinceHop = 0;
    this.acc = 0;
    this.accCount = 0;
    this.batch = new Float32Array(NT_ANALYSIS_BATCH * 3);
    this.batched = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channels = input.length, length = input[0].length;
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input[c][i];
      this.acc += sample / channels;
      if (++this.accCount < this.decimate) continue;
      this.ring[this.write] = this.acc / this.decimate;
      this.write = (this.write + 1) % NT_ANALYSIS_FRAME;
      this.acc = 0; this.accCount = 0;
      if (this.filled < NT_ANALYSIS_FRAME) this.filled++;
      if (++this.sinceHop >= NT_ANALYSIS_HOP && this.filled === NT_ANALYSIS_FRAME) {
        this.sinceHop = 0;
        this.analyse(currentTime + i / sampleRate);
      }
    }
    return true;
  }

  analyse(time) {
    let energy = 0;
    for (let i = 0; i < NT_ANALYSIS_FRAME; i++) {
      const v = this.ring[(this.write + i) % NT_ANALYSIS_FRAME];
      this.frame[i] = v; energy += v * v;
    }
    const rms = Math.sqrt(energy / NT_ANALYSIS_FRAME);
    // Silence never has a pitch; skip the expensive search.
    const f0 = rms > 0.002 && typeof ntDetectPitch === 'function' ? ntDetectPitch(this.frame, this.rate) : 0;
    const o = this.batched * 3;
    this.batch[o] = time; this.batch[o + 1] = f0; this.batch[o + 2] = rms;
    if (++this.batched === NT_ANALYSIS_BATCH) {
      this.port.postMessage(this.batch.slice(0));
      this.batched = 0;
    }
  }
}

registerProcessor('nt-speaker-analyser', NtSpeakerAnalyser);
