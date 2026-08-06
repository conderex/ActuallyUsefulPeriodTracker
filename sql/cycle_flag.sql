-- Server-side companion to js/cycleFlag.js.
--
-- Computes, per user and per completed cycle, a rolling median + MAD baseline
-- over the prior 12 completed cycles, then evaluates that cycle against the
-- same personal band + absolute backstops used client-side. Intended for a
-- scheduled job (e.g. a Supabase Edge Function on a cron trigger) that builds
-- the notification digest without pulling rows into app code.
--
-- Dialect: PostgreSQL (Supabase). Plain SQL has no built-in MEDIAN/MAD
-- aggregate, and PERCENTILE_CONT (the ordered-set aggregate PostgreSQL does
-- provide) cannot be used directly as a window function — so the rolling
-- baseline is built with array_agg() OVER (...) and the median/MAD are then
-- computed from that array via a LATERAL subquery. MySQL and SQLite lack
-- PERCENTILE_CONT entirely and would need a different approach (a
-- user-defined aggregate or client-side calculation).
--
-- Assumes a `completed_cycles` table with one row per finished cycle:
--   user_id      uuid/text
--   cycle_start  date/timestamptz  (start of the cycle being measured)
--   cycle_length int               (days; the length of that completed cycle)

WITH windows AS (
  SELECT
    user_id,
    cycle_start,
    cycle_length,
    array_agg(cycle_length) OVER (
      PARTITION BY user_id ORDER BY cycle_start
      ROWS BETWEEN 12 PRECEDING AND 1 PRECEDING
    ) AS baseline,
    count(*) OVER (
      PARTITION BY user_id ORDER BY cycle_start
      ROWS BETWEEN 12 PRECEDING AND 1 PRECEDING
    ) AS n
  FROM completed_cycles
),
stats AS (
  SELECT
    w.user_id,
    w.cycle_start,
    w.cycle_length,
    w.n,
    med.center,
    1.4826 * mad.mad_val AS spread
  FROM windows w
  CROSS JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS center
    FROM unnest(w.baseline) AS v
  ) med
  CROSS JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(v - med.center)) AS mad_val
    FROM unnest(w.baseline) AS v
  ) mad
)
SELECT
  user_id,
  cycle_start,
  cycle_length,
  n,
  center,
  spread,
  CASE
    WHEN n < 3 THEN NULL
    WHEN n <= 6 THEN 7.0
    ELSE GREATEST(2.0 * spread, 5.0)
  END AS threshold,
  CASE WHEN n <= 6 THEN 'early_fixed' ELSE 'established' END AS rule_used,
  CASE
    WHEN n < 3 THEN false
    ELSE
      abs(cycle_length - center) > (
        CASE WHEN n <= 6 THEN 7.0 ELSE GREATEST(2.0 * spread, 5.0) END
      )
      OR cycle_length < 21
      OR cycle_length > 35
  END AS flagged
FROM stats
ORDER BY user_id, cycle_start;
