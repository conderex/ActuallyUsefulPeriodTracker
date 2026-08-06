# ActuallyUsefulPeriodTracker

A private, single-user cycle tracker: a self-contained `index.html` (vanilla JS,
no build step) backed by Supabase, in the spirit of DoingTheDoings.

## Cycle anomaly detection

`js/cycleFlag.js` is a pure, dependency-free function that decides whether a
just-completed cycle should be gently flagged as outside someone's personal
normal range (robust median/MAD baseline + absolute backstops). Run its tests
with:

```
node --test js/cycleFlag.test.js
```

Call `evaluateCycle()` client-side right after a period-end is logged, and run
`sql/cycle_flag.sql` (the same logic in SQL) from the scheduled job that
builds the notification email digest.