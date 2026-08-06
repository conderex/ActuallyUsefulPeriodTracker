import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCycle, isLongGap } from './cycleFlag.js';

function close(actual, expected, epsilon = 0.01) {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be close to ${expected}`);
}

test('fewer than 3 cycles: feature is inactive', () => {
  const result = evaluateCycle([28, 30], 29);
  assert.equal(result.flagged, false);
  assert.equal(result.rule_used, 'insufficient_history');
});

test('very regular cycler (center ~29, spread ~1.5): floor protects a 31-day cycle', () => {
  const history = [28, 29, 29, 30, 28, 29, 30, 28];
  const result = evaluateCycle(history, 31);
  assert.equal(result.rule_used, 'established');
  close(result.center, 29);
  close(result.threshold, 5); // floor active: 2*spread < 5
  assert.equal(result.flagged, false);
  assert.deepEqual(result.band.map((v) => Math.round(v * 100) / 100), [24, 34]);
});

test('very regular cycler: a 36-day cycle is flagged', () => {
  const history = [28, 29, 29, 30, 28, 29, 30, 28];
  const result = evaluateCycle(history, 36);
  assert.equal(result.flagged, true);
  assert.equal(result.severity, 'gentle');
});

test('variable cycler (spread ~4.4): band widens, 34-day cycle not flagged', () => {
  const history = [25, 33, 27, 31, 29, 29, 25, 33];
  const result = evaluateCycle(history, 34);
  close(result.center, 29);
  close(result.spread, 4.4478, 0.01);
  close(result.threshold, 8.8956, 0.01);
  assert.equal(result.flagged, false);
});

test('variable cycler: a 40-day cycle is flagged', () => {
  const history = [25, 33, 27, 31, 29, 29, 25, 33];
  const result = evaluateCycle(history, 40);
  assert.equal(result.flagged, true);
});

test('early regime (exactly 4 cycles) uses the fixed 7-day rule regardless of spread', () => {
  const history = [29, 29, 29, 29]; // spread is 0, but the fixed rule still applies
  const withinFixed = evaluateCycle(history, 35); // deviation 6 < 7
  assert.equal(withinFixed.rule_used, 'early_fixed');
  assert.equal(withinFixed.threshold, 7);
  assert.equal(withinFixed.flagged, false);
  assert.deepEqual(withinFixed.band, [22, 36]);

  const outsideFixed = evaluateCycle(history, 38); // deviation 9 > 7 (also trips the backstop)
  assert.equal(outsideFixed.rule_used, 'early_fixed');
  assert.equal(outsideFixed.flagged, true);
});

test('backstop: a 20-day cycle is flagged even when inside a wide personal band', () => {
  const history = [23, 35, 25, 33, 29, 29, 25, 33]; // established, threshold ~11.86
  const result = evaluateCycle(history, 20);
  assert.ok(result.deviation < result.threshold, 'expected the personal band to NOT flag this on its own');
  assert.equal(result.flagged, true); // backstop (< 21) still catches it
});

test('backstop: a 36-day cycle is flagged even when inside a wide personal band', () => {
  const history = [23, 35, 25, 33, 29, 29, 25, 33];
  const result = evaluateCycle(history, 36);
  assert.ok(result.deviation < result.threshold, 'expected the personal band to NOT flag this on its own');
  assert.equal(result.flagged, true); // backstop (> 35) still catches it
});

test('robustness: one outlier in history does not widen the band enough to hide a genuinely off cycle', () => {
  const history = [28, 29, 30, 29, 28, 30, 60]; // one fluke 60-day cycle sitting in history
  const result = evaluateCycle(history, 40);

  // The robust center/spread barely notice the outlier...
  close(result.center, 29);
  close(result.threshold, 5); // floor active — MAD-based spread stayed tight
  assert.equal(result.flagged, true, 'the 40-day cycle should still be flagged');

  // ...whereas the plain mean/stdev (returned for display only) are dragged way off,
  // which is exactly what would have happened had flagging used mean/SD instead of median/MAD.
  close(result.mean, 33.43, 0.01);
  assert.ok(result.stdev > 10, 'plain stdev should be inflated by the outlier');
  const naiveThreshold = 2 * result.stdev;
  const naiveDeviation = Math.abs(40 - result.mean);
  assert.ok(naiveDeviation < naiveThreshold, 'a naive mean/SD band would have let this cycle slip through unflagged');
});

test('invalid newLength raises a clear error', () => {
  assert.throws(() => evaluateCycle([28, 29, 30], -5), RangeError);
  assert.throws(() => evaluateCycle([28, 29, 30], 200), RangeError);
});

test('implausible entries in history are ignored, not thrown', () => {
  const history = [28, 29, 30, 5, 29, 30, 500]; // 5 and 500 are bogus data
  const result = evaluateCycle(history, 29);
  close(result.center, 29.5, 1); // unaffected by the bogus entries
});

test('isLongGap flags when the gap reaches the threshold', () => {
  assert.equal(isLongGap(95), true);
  assert.equal(isLongGap(80), false);
  assert.equal(isLongGap(90), true); // inclusive of the boundary
});
