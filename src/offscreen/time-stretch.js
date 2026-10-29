// NeiroTranslate — WSOLA time stretching for whole phrases of synthesized speech.
// playbackRate alone speeds speech up by raising its pitch ("chipmunk"). WSOLA
// changes duration while keeping pitch; combined with playbackRate it can also
// shift pitch at constant duration, which is how speakers share one TTS voice.

// Frame/tolerance sizes suit speech (pitch periods 2.5–14 ms). Longer frames
// smear consonants; shorter ones lose low voices.
const NT_STRETCH = { FRAME_SEC: 0.03, TOLERANCE_SEC: 0.008, EPSILON: 0.015, MAX_SECONDS: 30,
  // Correlation is evaluated on every Nth sample and offset; ~16x cheaper with
  // no audible difference for speech.
  CORR_STRIDE: 4, SEARCH_STEP: 2 };

/**
 * @param {Float32Array} input mono samples
 * @param {number} ratio output length / input length (0.4..2.5)
 * @param {number} sampleRate
 * @returns {Float32Array}
 */
function ntTimeStretch(input, ratio, sampleRate) {
  const n = input.length;
  if (!n || !(ratio > 0) || !(sampleRate > 0)) return new Float32Array(0);
  const r = Math.max(0.4, Math.min(2.5, ratio));
  if (Math.abs(r - 1) < NT_STRETCH.EPSILON) return input.slice();
  const frame = 2 * Math.max(8, Math.round(sampleRate * NT_STRETCH.FRAME_SEC / 2));
  const hop = frame / 2;
  const tolerance = Math.max(1, Math.round(sampleRate * NT_STRETCH.TOLERANCE_SEC));
  const outLength = Math.max(1, Math.round(n * r));
  const out = new Float32Array(outLength + frame);
  const weight = new Float32Array(outLength + frame);
  const window = new Float32Array(frame);
  for (let i = 0; i < frame; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / frame);
  const at = i => (i >= 0 && i < n ? input[i] : 0);
  const analysisHop = hop / r;
  let previous = 0;
  const frames = Math.ceil(outLength / hop) + 1;
  for (let k = 0; k < frames; k++) {
    const outPos = k * hop;
    let pos = Math.round(k * analysisHop);
    if (k > 0) {
      // Pick the offset whose start best continues the previous frame's
      // natural successor, so overlapping waveforms add in phase.
      const natural = previous + hop;
      let best = 0, bestScore = -Infinity;
      for (let d = -tolerance; d <= tolerance; d += NT_STRETCH.SEARCH_STEP) {
        const start = pos + d;
        if (start < 0 || start >= n) continue;
        let score = 0;
        for (let j = 0; j < hop; j += NT_STRETCH.CORR_STRIDE) score += at(natural + j) * at(start + j);
        if (score > bestScore) { bestScore = score; best = d; }
      }
      pos = Math.max(0, Math.min(n - 1, pos + best));
    }
    for (let i = 0; i < frame; i++) {
      const o = outPos + i;
      if (o >= out.length) break;
      out[o] += at(pos + i) * window[i];
      weight[o] += window[i];
    }
    previous = pos;
  }
  const result = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) result[i] = weight[i] > 1e-3 ? out[i] / weight[i] : out[i];
  return result;
}

/**
 * Returns a mono AudioBuffer whose duration is `ratio` times the input's.
 * Falls back to the original buffer when stretching is pointless or too long.
 */
function ntStretchAudioBuffer(ctx, buffer, ratio) {
  if (!buffer || Math.abs(ratio - 1) < NT_STRETCH.EPSILON || buffer.duration > NT_STRETCH.MAX_SECONDS) return buffer;
  const channels = buffer.numberOfChannels || 1;
  let mono = buffer.getChannelData(0);
  if (channels > 1) {
    mono = new Float32Array(buffer.length);
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / channels;
    }
  }
  const stretched = ntTimeStretch(mono, ratio, buffer.sampleRate);
  if (!stretched.length) return buffer;
  const result = ctx.createBuffer(1, stretched.length, buffer.sampleRate);
  result.getChannelData(0).set(stretched);
  return result;
}

if (typeof self !== 'undefined') { self.ntTimeStretch = ntTimeStretch; self.ntStretchAudioBuffer = ntStretchAudioBuffer; self.NT_STRETCH = NT_STRETCH; }
if (typeof module !== 'undefined' && module.exports) module.exports = { ntTimeStretch, ntStretchAudioBuffer, NT_STRETCH };
