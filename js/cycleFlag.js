// Pure anomaly-detection logic for "this cycle looks unusual" notifications.
// No I/O, no side effects — wire delivery (email, in-app banner) elsewhere.

export const CYCLE_FLAG_DEFAULTS = Object.freeze({
  WINDOW: 12,          // rolling baseline: use at most the last 12 cycles
  MIN_HISTORY: 3,       // below this, feature is inactive
  EARLY_MAX: 6,          // 3..6 cycles = "early" regime
  FLOOR_DAYS: 5.0,        // band never tighter than this
  EARLY_FIXED_DAYS: 7.0,  // fixed band while SD is not yet trustworthy
  SD_MULT: 2.0,           // multiplier on the robust spread once established
  ABS_MIN: 21,            // absolute backstop, days
  ABS_MAX: 35,            // absolute backstop, days
  LONG_GAP_DAYS: 90,      // no period at all -> firmer "check in"
  PLAUSIBLE_MIN: 10,      // cycle lengths outside this range are treated as bad data
  PLAUSIBLE_MAX: 90,
});

function isPlausibleLength(value, min, max) {
  return Number.isFinite(value) && value > 0 && value >= min && value <= max;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Sample standard deviation (n-1), for display/telemetry only — not used for flagging.
function sampleStdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Decide whether a just-completed cycle should be gently flagged as outside
 * this person's normal range, using a robust (median/MAD) personal baseline
 * plus fixed absolute backstops.
 *
 * @param {number[]} history - prior COMPLETED cycle lengths in days, oldest -> newest.
 * @param {number} newLength - the just-completed cycle length in days.
 * @param {Partial<typeof CYCLE_FLAG_DEFAULTS>} [options]
 */
export function evaluateCycle(history, newLength, options = {}) {
  const cfg = { ...CYCLE_FLAG_DEFAULTS, ...options };

  if (!Array.isArray(history)) {
    throw new TypeError('history must be an array of cycle lengths in days');
  }
  if (!isPlausibleLength(newLength, cfg.PLAUSIBLE_MIN, cfg.PLAUSIBLE_MAX)) {
    throw new RangeError(
      `newLength must be a plausible cycle length in days (${cfg.PLAUSIBLE_MIN}-${cfg.PLAUSIBLE_MAX}), got ${newLength}`
    );
  }

  // Bad data in history (bogus imports, typos) is dropped rather than poisoning the baseline.
  const plausibleHistory = history.filter((v) => isPlausibleLength(v, cfg.PLAUSIBLE_MIN, cfg.PLAUSIBLE_MAX));
  const baseline = plausibleHistory.slice(-cfg.WINDOW);
  const n = baseline.length;

  if (n < cfg.MIN_HISTORY) {
    return {
      flagged: false,
      severity: 'none',
      deviation: null,
      threshold: null,
      center: null,
      spread: null,
      mean: null,
      stdev: null,
      band: null,
      rule_used: 'insufficient_history',
      reason: `Not enough history yet — need at least ${cfg.MIN_HISTORY} completed cycles.`,
    };
  }

  const center = median(baseline);
  const mad = median(baseline.map((v) => Math.abs(v - center)));
  const spread = 1.4826 * mad;
  const plainMean = mean(baseline);
  const stdev = sampleStdev(baseline);

  const ruleUsed = n <= cfg.EARLY_MAX ? 'early_fixed' : 'established';
  const threshold = ruleUsed === 'early_fixed'
    ? cfg.EARLY_FIXED_DAYS
    : Math.max(cfg.SD_MULT * spread, cfg.FLOOR_DAYS);

  const deviation = Math.abs(newLength - center);
  const personalFlag = deviation > threshold;
  const backstopFlag = newLength < cfg.ABS_MIN || newLength > cfg.ABS_MAX;
  const flagged = personalFlag || backstopFlag;

  let reason;
  if (backstopFlag) {
    reason = 'This cycle length is outside the general healthy range.';
  } else if (personalFlag) {
    reason = `This cycle ran a few days ${newLength > center ? 'longer' : 'shorter'} than her usual pattern — probably nothing, just noting it.`;
  } else {
    reason = 'Within her normal range.';
  }

  return {
    flagged,
    severity: flagged ? 'gentle' : 'none',
    deviation,
    threshold,
    center,
    spread,
    mean: plainMean,
    stdev,
    band: [center - threshold, center + threshold],
    rule_used: ruleUsed,
    reason,
  };
}

/**
 * Separate check on elapsed time, not cycle length: has it been too long
 * since the last logged period at all? Caller escalates severity to "check_in".
 */
export function isLongGap(daysSinceLastPeriod, longGapDays = CYCLE_FLAG_DEFAULTS.LONG_GAP_DAYS) {
  if (!Number.isFinite(daysSinceLastPeriod) || daysSinceLastPeriod < 0) {
    throw new RangeError(`daysSinceLastPeriod must be a non-negative number, got ${daysSinceLastPeriod}`);
  }
  return daysSinceLastPeriod >= longGapDays;
}
