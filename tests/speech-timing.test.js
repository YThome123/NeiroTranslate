const test = require('node:test');
const assert = require('node:assert/strict');
const {ntEstimateSpeechMs, ntPlanTempo, ntSpeechUnits, NtVoiceCalibration, NtSourcePace, NT_TIMING} = require('../src/shared/speech-timing.js');

test('speech length estimates scale with text and script', () => {
  const short = ntEstimateSpeechMs('Привет');
  const long = ntEstimateSpeechMs('Привет, как у тебя дела сегодня вечером?');
  assert.ok(long > short * 4);
  // CJK packs far more speech per character than alphabetic scripts.
  assert.ok(ntEstimateSpeechMs('今日はいい天気ですね') > ntEstimateSpeechMs('Good weather'));
});

test('tempo fits speech into its window within the user floor and ceiling', () => {
  assert.equal(ntPlanTempo({speechMs: 2000, availableMs: 4000, base: 1.1, max: 1.6}), 1.1);
  assert.equal(ntPlanTempo({speechMs: 3000, availableMs: 2000, base: 1, max: 1.6}), 1.5);
  assert.equal(ntPlanTempo({speechMs: 9000, availableMs: 2000, base: 1, max: 1.6}), 1.6);
  // Already late: as fast as allowed, never Infinity or NaN.
  assert.equal(ntPlanTempo({speechMs: 2000, availableMs: -500, base: 1, max: 1.6}), 1.6);
  assert.equal(ntPlanTempo({speechMs: NaN, availableMs: 1000, base: 1.2, max: 1.6}), 1.2);
  // A user rate above the ceiling is respected rather than slowed down.
  assert.equal(ntPlanTempo({speechMs: 100, availableMs: 9000, base: 1.8, max: 1.6}), 1.8);
});

test('voice calibration converges on the measured speed and rejects junk samples', () => {
  const calibration = new NtVoiceCalibration();
  const text = 'Это достаточно длинная фраза для измерения скорости голоса.';
  const before = calibration.cps('v', text);
  for (let i = 0; i < 12; i++) calibration.observe('v', text, 2000, 1);
  const measured = calibration.cps('v', text);
  assert.ok(Math.abs(measured - ntSpeechUnits(text) / 2) < 0.5, String(measured));
  assert.notEqual(measured, before);
  calibration.observe('v', text, 10, 1);           // implausibly fast
  calibration.observe('v', 'short', 5000, 1);      // too short to measure
  assert.equal(calibration.cps('v', text), measured);
  // Rate-normalised: the same voice heard at 2x reports the same base speed.
  const other = new NtVoiceCalibration();
  for (let i = 0; i < 12; i++) other.observe('v', text, 1000, 2);
  assert.ok(Math.abs(other.cps('v', text) - measured) < 0.5);
});

test('source pace follows caption flow and ignores silences', () => {
  const pace = new NtSourcePace();
  let at = 0;
  for (let i = 0; i < 20; i++) { at += 1000; pace.observe('x'.repeat(20), at); }
  assert.ok(Math.abs(pace.cps - 20) < 1, String(pace.cps));
  pace.observe('x'.repeat(20), at + 20000);   // after a long pause
  assert.ok(Math.abs(pace.cps - 20) < 1);
  assert.ok(Math.abs(pace.durationMs('x'.repeat(40)) - 2000) < 150);
});

test('timing constants are bounded and ordered', () => {
  assert.ok(NT_TIMING.CAPTION_LAG_LIVE_MS > NT_TIMING.CAPTION_LAG_VOD_MS);
  assert.ok(NT_TIMING.REALTIME_START_BUDGET_MS > 0 && NT_TIMING.OVERRUN_CUT_MS > 0);
});
