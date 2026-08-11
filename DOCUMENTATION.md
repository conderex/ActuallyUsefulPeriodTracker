# Mary's Cycle Tracker: Project Documentation

A single-purpose menstrual cycle tracker built for one specific user (Mary), because the mainstream apps she had tried were unreliable at the one thing she actually needed and cluttered with features she did not want. This document is the reference for anyone (human or AI) picking up the project.

- **Live app:** https://actually-useful-cycle-tracker.vercel.app
- **How-to page:** https://actually-useful-cycle-tracker.vercel.app/how-to.html
- **Repository:** https://github.com/conderex/ActuallyUsefulPeriodTracker (private)

---

## 1. Product intent

Three principles drive every decision in this codebase:

1. **Radical simplicity.** Fewer screens and taps than any app-store tracker Mary has tried. Logging today's start date is one glance and one tap.
2. **Editing is first-class.** The single loudest complaint about Apple Health was how hard it was to correct a start date. Every entry is tap-to-edit, with day-nudge buttons, and every field (date, time, type, notes) can be changed.
3. **Trust and privacy.** Two Google accounts (Mary and Roger) can read or write data. Nobody else can, at any layer.

Anything the app does should be justifiable against these three. If it is not, it should be removed.

---

## 2. Architecture at a glance

```
        Browser (PWA)                              Cloud
  +-----------------------+                  +------------------+
  |  index.html           |                  |                  |
  |  js/app.js            |  HTTPS + JWT     |    Supabase      |
  |  js/cycleFlag.js      |  <-------------> |  Postgres + Auth |
  |  js/config.js         |                  |  Google OAuth    |
  |  sw.js (offline)      |                  |  Row-level sec.  |
  |  localStorage mirror  |                  |                  |
  +-----------------------+                  +------------------+
             ^
             |  static hosting
             |
       +---------------+           push to main
       |    Vercel     | <---------------------------- GitHub repo
       +---------------+
```

- **No build step.** `index.html` is served as-is. Vanilla JS ES modules only.
- **No custom backend.** Supabase provides authentication, the Postgres database, and row-level security. The browser talks directly to it via the official JS SDK loaded from a CDN.
- **Static hosting on Vercel** deploys from `main` automatically. The repository stays private (Vercel's free plan supports this; GitHub Pages does not on the personal plan).
- **Offline behavior:** the service worker caches the app shell (HTML, JS, icons, and the Supabase SDK script). Cycle data itself is mirrored to `localStorage` on every successful load, so a signed-in returning user sees their last synced data even when offline. Writes require a live network connection so authentication and row-level security can enforce access.

This shape was chosen deliberately to match the pattern of DoingTheDoings (a sibling PWA in the same account), so a future maintainer already familiar with that project sees the same conventions.

---

## 3. Repository layout

```
.
+-- index.html              The whole application shell + all styles
+-- how-to.html             Standalone illustrated guide, same visual style
+-- manifest.json           PWA manifest (name, icons, theme color)
+-- sw.js                   Service worker: app-shell cache, no data cache
+-- vercel.json             Cache-Control: no-cache on sw.js
+-- .vercelignore           Keeps docs, tests, and SQL out of the deploy
+-- README.md               Setup instructions
+-- DOCUMENTATION.md        This file
|
+-- js/
|   +-- app.js              All UI logic, data sync, event wiring
|   +-- cycleFlag.js        Pure anomaly-detection function (no I/O)
|   +-- cycleFlag.test.js   Node test-runner unit tests for cycleFlag
|   +-- config.js           SUPABASE_URL and SUPABASE_ANON_KEY (public)
|
+-- icons/
|   +-- icon-192.png        PWA icon
|   +-- icon-512.png        PWA icon
|   +-- og-image.png        Open Graph preview card (1200x630)
|
+-- supabase/
|   +-- schema.sql          Tables, RLS policies, grants, trigger, function
|
+-- sql/
|   +-- cycle_flag.sql      Server-side equivalent of cycleFlag.js
|
+-- test/
|   +-- e2e.mjs             106 headless-browser checks
|   +-- mock-supabase.js    Stand-in Supabase client used by the tests
|
+-- .github/                (currently empty; PR templates could go here)
```

`.vercelignore` keeps `supabase/`, `sql/`, `test/`, `README.md`, `DOCUMENTATION.md`, and `.github/` out of the deployed bundle. Only what the browser needs actually ships.

---

## 4. Data model

Three tables live in a dedicated Supabase project. The schema is deliberately small: three columns of substance in the main table, and two supporting tables.

### `allowed_emails`

The access-control list. Adding or removing a person is a plain `INSERT` or `DELETE`, no code change and no redeploy.

| column | type | notes                                     |
|--------|------|-------------------------------------------|
| email  | text | primary key, matched against `auth.jwt() ->> 'email'` |

### `cycle_entries`

One row per logged event. Three semantic columns (`occurred_at`, `entry_type`, `notes`) so the model stays trivial to extend later.

| column       | type        | notes                                            |
|--------------|-------------|--------------------------------------------------|
| id           | uuid        | primary key, default `gen_random_uuid()`         |
| occurred_at  | timestamptz | when the event happened (editable)               |
| entry_type   | text        | `'period_start' \| 'period_end' \| 'note'`, CHECK constraint |
| notes        | text        | optional free text, `CHECK (length(notes) <= 2000)` |
| created_by   | text        | `auth.jwt() ->> 'email'`, default expression     |
| created_at   | timestamptz | audit                                            |
| updated_at   | timestamptz | audit, maintained by a trigger                   |

Index on `occurred_at DESC` because every read is time-ordered.

### `cycle_settings`

Single-row table (id is always 1). Kept as a table rather than a config file so Mary can edit her rolling-average override in the UI without a redeploy, following the same pattern DoingTheDoings uses for its settings.

| column           | type    | notes                                          |
|------------------|---------|------------------------------------------------|
| id               | int     | primary key, `CHECK (id = 1)`                  |
| average_override | numeric | nullable; NULL means "compute automatically"   |
| sd_multiplier    | numeric | default 2.0; the "how far outside is unusual" knob |
| updated_at       | timestamptz | audit                                       |

---

## 5. Authentication and authorization

Sign-in is Google-only, via Supabase Auth's `signInWithOAuth` flow.

### The allow-list

`allowed_emails` is the canonical source of who can use the app. The Google OAuth client is also configured in Testing mode with the same two emails listed under Test Users, which gives a second layer of blocking at the identity provider itself.

### Row-level security

Every table has RLS enabled and policies that reference a helper function:

```sql
create or replace function public.is_allowed_user()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.allowed_emails a
    where a.email = auth.jwt() ->> 'email'
  );
$$;
```

**Why the function is `SECURITY DEFINER`:** an earlier version inlined `exists (select 1 from allowed_emails ...)` directly in each policy. RLS applies to tables referenced inside a policy too, so `allowed_emails`' own policy re-triggered on that subquery, which re-ran the same subquery, forever. Postgres rejected it as infinite recursion (error 42P17) and every read and write failed. `SECURITY DEFINER` runs the lookup as the function owner, bypassing RLS for that one query and breaking the cycle.

### Table grants

Postgres checks two independent layers, and both must allow an operation: table-level `GRANT`s and row-level policies. The schema explicitly grants the `authenticated` role access to each table (SELECT/INSERT/UPDATE/DELETE on `cycle_entries`, SELECT/UPDATE on `cycle_settings`, SELECT on `allowed_emails`). Without this the request is refused before RLS is even consulted, with a "permission denied for table" error. This was a real bug in an earlier version; the grants block is now part of the schema.

### The anon key is public by design

`js/config.js` ships the anon key in the browser. This is expected: the anon key only grants what the RLS policies allow. The secrecy that actually protects the data is Mary's Google credentials plus her presence in `allowed_emails`, not the anon key.

---

## 6. Anomaly detection: `cycleFlag.js`

`js/cycleFlag.js` is a pure, dependency-free function that decides whether a just-completed cycle should be gently flagged as outside the user's own normal range. It is exercised by 12 unit tests (`node --test js/cycleFlag.test.js`) and duplicated in SQL (`sql/cycle_flag.sql`) for server-side jobs.

### Design choices

**Robust statistics, not mean and standard deviation.** The baseline uses the median and Median Absolute Deviation (MAD), scaled by 1.4826 to be SD-equivalent. A single outlier cycle in the history cannot poison the baseline and let a genuinely off cycle slip through. Mean and stdev are still computed and returned for telemetry.

**Two regimes based on history length.** With few cycles the computed spread is unreliable, so the rule shifts:

| cycles of history | threshold formula                       |
|-------------------|-----------------------------------------|
| less than 3       | feature inactive                         |
| 3 to 6            | fixed 7 days                             |
| 7 or more         | `max(SD_MULT * spread, FLOOR_DAYS)`      |

**Absolute backstops.** Independently of the personal band, any cycle length under 21 days or over 35 flags. These are the general healthy-range bounds; a cycle outside them warrants attention even if it happens to fit that person's personal variability.

**Separate long-gap check.** A period that has not arrived within 90 days is flagged with a firmer "worth a check-in" message, escalated from `gentle` to `check_in`. This is a check on elapsed time, not cycle length, so it lives in its own function (`isLongGap`).

**Copy is never diagnostic.** Every reason string reads as observation, not medical advice. Example: "This cycle ran a few days longer than her usual pattern, probably nothing, just noting it."

### Configurable defaults

```js
export const CYCLE_FLAG_DEFAULTS = Object.freeze({
  WINDOW: 12,           // rolling baseline: last N cycles
  MIN_HISTORY: 3,       // below this, feature is inactive
  EARLY_MAX: 6,         // 3..6 cycles = early regime
  FLOOR_DAYS: 5.0,      // band never tighter than this
  EARLY_FIXED_DAYS: 7.0,
  SD_MULT: 2.0,         // multiplier on the robust spread
  ABS_MIN: 21,
  ABS_MAX: 35,
  LONG_GAP_DAYS: 90,
  PLAUSIBLE_MIN: 10,    // bogus data below this is dropped
  PLAUSIBLE_MAX: 90,    // and above this too
});
```

`sd_multiplier` in `cycle_settings` overrides `SD_MULT` per user at runtime, so the "how sensitive" knob is editable without a code change.

### Return shape

```js
{
  flagged: boolean,
  severity: 'none' | 'gentle' | 'check_in',
  deviation: number | null,
  threshold: number | null,
  center: number | null,     // robust median
  spread: number | null,     // 1.4826 * MAD
  mean: number | null,       // for display only
  stdev: number | null,      // for display only
  band: [lo, hi] | null,
  rule_used: 'early_fixed' | 'established' | 'insufficient_history',
  reason: string,
}
```

---

## 7. UX / UI design

### Design language: the Overworld

The visual identity is a hand-authored pixel-art Minecraft-inspired scene rendered inline as SVG rectangles. Waterfall on the left, stepped volcano with flowing lava on the right, a stepped-pyramid mountain range with snow caps between them, oak trees, a plunge-pool lake, and a plesiosaur (Mary's favourite dinosaur) swimming across it.

This choice is intentional. A period tracker's default look is either aggressively feminine or aggressively clinical; both were things Mary said she disliked in the apps she had abandoned. A blocky game-world backdrop feels personal and low-stakes without being cute, and the whole scene is decorative rather than functional: cycle data always sits on opaque panels, never over scenery.

### Design tokens

The palette is expressed as CSS custom properties on `:root`, redefined for dark mode under both `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]` (with a `:root[data-theme="light"]` override so a light preference wins over an OS-dark setting). Two families:

- **UI tokens** (`--page`, `--surface`, `--ink`, `--accent`, ...) drive the app chrome.
- **Scene tokens** (`--grass`, `--stone`, `--lava`, `--dino`, ...) drive the pixel-art backdrop.

The accent is a dark teal in light mode and a soft mint in dark mode. Status colors (`warning`, `critical`) sit alongside as their own semantic slots and never double as accent hues.

### Layout

**Mobile-first.** Everything below 900px is a single vertical column. The reading order was chosen so the log sits directly under the logging buttons: tap "+ Log start date", save, and the new entry appears immediately below without scrolling. The header shrinks its label and buttons at very narrow widths so it always fits on one line.

**Desktop.** At 900px and above, the layout becomes a named CSS grid:

```
+-------- header -----------+
+-- connection banner ------+  (only when errored)
+---- flag banner ----------+  (only when flagged)
+-- hero ---+---------------+
+-- quick --|   log         |
+-- trend --|               |
+-- avg  ---+---- export ---+
```

Named `grid-template-areas` (not per-item column assignments) so auto-placement cannot leave holes. The log occupies the full right column at natural height instead of being crammed between other cards.

### Component vocabulary

Everything blocky, matching the scene:

- 3px solid borders on all interactive surfaces.
- Hard offset shadow (`4px 4px 0`) with no blur, in the ink color.
- Buttons "press in" with `transform: translate(2px, 2px)` and a reduced shadow.
- No rounded corners anywhere; the design language commits to right angles.

### The hero counter

The single most-glanced-at element. Its label and body update based on the most recent entry of any type:

- No entries: "Days since last entry", em dash placeholder, prompt to log a start.
- Latest is a period start: "Days since period started", number, `Day N of this period` beneath.
- Latest is a period end: "Days since period ended", number, no second line.
- Latest is a note: "Days since last note", number, no second line.

The `Day N of this period` line intentionally disappears once a period is closed, because "Day 10 of this cycle" while the period is over is misleading. It reappears at "Day 1 of this period" the moment a new start is logged.

### The entry log

Each row shows:

- A colored pill labelling the type (Start / End / Note).
- The date and time in the user's locale.
- Any notes, if present.
- An "Edit" affordance on the right, visible without needing hover, so it is obvious the row is tappable.

Rows are keyboard-reachable (`tabindex="0"`, `role="button"`, Enter opens the sheet).

### The edit sheet

A bottom sheet on mobile, a centered card on desktop. Fields:

- **Type** dropdown (Start, End, Note).
- **Date** and **Time** inputs.
- **Day nudge buttons** (`- 1 day`, `Today`, `+ 1 day`) directly under the date pickers, since being one or two days off is by far the most common correction Mary makes.
- **Notes** textarea.
- **Delete / Cancel / Save** actions.

Saving a `period_end` when no period is open before that date opens a styled confirm dialog explaining the situation, with Go back and Save it anyway buttons. It never silently rejects, because backfilling old data legitimately needs the "save anyway" path.

### The trend chart

A simple line chart rendered as inline SVG. Three time-range modes controlled by a segmented control:

- **Weeks:** last N weeks (user-adjustable, 4 to 52, default 12).
- **Months:** rolling six months.
- **Year:** the full logged history.

Below two points of data the chart collapses (hidden `<svg>` plus a prompt to log more), otherwise the card would stretch to hundreds of empty pixels because SVG preserves aspect ratio.

The line is the accent color, points are hollow circles anchored to the baseline. A single-hue palette, thin marks, and a recessive grid: the chart follows the dataviz guidance in `.claude/skills/dataviz`. A crosshair tooltip on hover and touch shows the date and length for the nearest point.

### Banners

Three kinds of message stack above the main content when relevant:

- **Connection banner** (grey when offline, red when a database error). Reports the real cause instead of blanket "you're offline" so a permission error surfaces as a permission error.
- **Flag banner (warning):** "This cycle looks a little different." Populated by `cycleFlag.js`.
- **Flag banner (critical):** "Worth a check-in." Populated by `isLongGap`.

### Accessibility

- Every interactive element has a visible focus state (3px accent outline).
- Every icon in a banner is `aria-hidden`; the banner text itself carries the message.
- Entry rows expose `aria-label` and respond to Enter.
- The whole scene, and every one of its animations, respects `prefers-reduced-motion`. When it is set, the waterfall stops falling, the plesiosaur stops swimming, the volcano stops flickering, and the clouds stop drifting.
- The report view is print-optimized: at print time, everything is hidden except `#report-view`, which renders as a clean black-on-white page.

---

## 8. Feature walkthrough

### Log an entry

Tap `+ Log start date` (defaults to Period start, today, no notes) or `Other` (defaults to Note, editable). Adjust fields as needed, tap Save. On success the sheet closes, a toast confirms, and the log updates.

### Edit an entry

Tap the row. The same sheet opens, prefilled with the entry's values, plus a Delete button. Every field is editable, including the type (a mislogged Start can become an End without deleting and re-creating).

### Day-count

Automatically computed from the most recent entry regardless of type. Labels itself accordingly.

### Trend graph

Renders cycle length (start to start) over the selected range. Points are anchored to their period-start date. No dual axis, no rainbow, no averaging line yet.

### Editable rolling average

Displayed on the "Your average" card. Auto-computed as the mean of the last twelve cycle lengths. If `average_override` is set it wins and displays with the same label. Setting the field to blank clears the override and reverts to auto.

### CSV export

`Download CSV` produces `cycle-log-YYYY-MM-DD.csv` with header `date_time,type,notes`, one row per entry, oldest first, notes properly quoted per RFC 4180.

### Printable report

`Report` builds a printable view containing the app title, generation date, three summary stats (average, days since last start, cycles logged), and a table of every entry (newest first). Then it calls `window.print()`. The `@media print` block in the stylesheet hides everything else.

### Gentle out-of-range flag

Fires when a just-completed cycle falls outside the personal band and there are at least 3 cycles of history. Copy is observational, not diagnostic. Suppressed while the feature is inactive.

### Long-gap check-in

Fires when the most recent period start was more than 90 days ago. Phrased more firmly ("Worth a check-in") but still not diagnostic.

### Sign-in and sign-out

`signInWithOAuth({ provider: 'google', options: { redirectTo: APP_URL } })`, where `APP_URL` is `origin + pathname` with no query string or hash. This is critical: reusing `location.href` for `redirectTo` sends any leftover `#access_token=...` payload from a previous sign-in along as the redirect target, which Supabase parses instead of the fresh token, silently returning to the login screen. The current code strips the payload from the address bar after the session resolves, again on sign-out, and again before every attempt.

A failed callback (e.g. `bad_oauth_state` from a stale attempt) is shown to the user with actionable text ("That sign-in attempt had expired. Tap the button to try again.") instead of a silent re-render.

### Offline

The service worker caches the app shell. On startup, if `navigator.onLine` is false the app reads entries and settings from `localStorage` and shows a grey "You're offline" banner. Buttons that would write are disabled. On reconnection the data is refetched.

---

## 9. Deployment

**Vercel** deploys from `main`. Framework preset: Other. No build command. Output directory is the repo root. `.vercelignore` keeps docs, tests, SQL, and the schema files out of the deployed bundle. `vercel.json` sets `Cache-Control: no-cache` on `sw.js` so the service worker itself is never served stale; if it were, users would be stuck on old app versions after every deploy.

**Supabase** is a dedicated project used only by this app. Google OAuth is enabled on the Authentication providers page. The Google OAuth client (created in Google Cloud Console) is a Web Application with the Supabase callback URL as the sole Authorized Redirect URI. The OAuth consent screen is left in Testing mode with both real emails listed as Test Users.

**Site URL** in Supabase must be set to the Vercel URL, and the deployed URL must also appear under **Redirect URLs** with a `/**` wildcard. Without this, Supabase falls back to `http://localhost:3000` after sign-in and the callback lands on a dead local address.

---

## 10. Testing

Two suites, both dependency-light and runnable from the command line:

```
node --test js/cycleFlag.test.js   # 12 unit tests on the pure function
node test/e2e.mjs                  # 106 headless-browser checks on the whole UI
```

The end-to-end runner:

- Boots a tiny Node HTTP server on a random port and serves the repo.
- Writes a throwaway `index-test.html` that swaps the Supabase CDN script for `test/mock-supabase.js`.
- Drives the page in headless Chromium (Playwright, resolved from either a local install or the global one at `/opt/node22/lib/node_modules/playwright`).
- Cleans up the harness file and shuts the server down when done.

Coverage includes: the day counter in every state (empty, active, ended, note-only, reset after logging), add / edit / delete, all three trend graph ranges plus the weeks stepper, CSV structure and dated filename, printable report rows, the gentle and long-gap banners, the honest failure banner (denied vs. recursion vs. offline), the orphaned-end dialog, the day-nudge buttons, keyboard-reachable rows, the how-to flyer's structure, the link-preview metadata and the actual image being reachable, the sign-in-after-sign-out regression, mobile-vs-desktop layout, dark mode tokens, and `prefers-reduced-motion` disabling the plesiosaur.

Fixtures are generated relative to the current date, so the suite does not rot as time passes.

**Verified against the old code:** every regression test was checked by temporarily reverting the fix and confirming the test fails. So a green suite is meaningful, not vacuous.

---

## 11. How to make common changes

### Add a new allowed user

```sql
insert into allowed_emails (email) values ('someone@gmail.com');
```

That is it. Nothing else needs to change. Removal is the same with `delete`.

### Change the "how unusual is unusual" threshold

Either edit `SD_MULT` in `CYCLE_FLAG_DEFAULTS`, or (better, no redeploy) update the single row in `cycle_settings`:

```sql
update cycle_settings set sd_multiplier = 2.5 where id = 1;
```

### Add a new entry type

Two places: the `CHECK` constraint in `supabase/schema.sql`, and the `<select>` options plus `ENTRY_COUNTER_LABEL` map in `js/app.js`. Also add a color rule for `.etype.<new_type>` in the stylesheet.

### Change the visual style

All tokens live at the top of `<style>` in `index.html`, grouped by theme scope. UI and scene are separate token families; changing the accent has no effect on the landscape and vice versa. All three scopes (`:root`, `prefers-color-scheme: dark`, `[data-theme=...]`) must be kept in sync.

### Extend the app UI

`js/app.js` is one file, ~800 lines, sectioned by comment banners. Add derived state as a pure function alongside `latestEntry` / `openPeriodStart`, add a `renderX` function, add a wiring call in `wireListeners`.

---

## 12. Known limitations and future work

Documented so the next maintainer does not have to rediscover them.

- **No email notifications yet.** The original brief mentioned email alerts (upcoming period, log the end, out-of-range cycle, missed check-in). The math to trigger them is done (`cycleFlag.js`, `sql/cycle_flag.sql`) but no scheduled job wires it into Supabase Edge Functions or an equivalent. This is the next feature.
- **No timezone handling for `daysSince`.** It uses the browser's local time, which is fine because the app has one user. If it ever gains a second user in a different timezone, dates near midnight could disagree.
- **`period_end` counts do not currently affect the anomaly detection.** Only starts drive cycle length. Period duration could become its own signal but is not one today.
- **The service worker caches the Supabase SDK across versions.** Bumping `@supabase/supabase-js@2` will not pick up automatically; the `CACHE_NAME` string in `sw.js` has to be bumped alongside.
- **CSV export always dumps everything.** No date-range filter yet. Small enough dataset that this has never been a problem.
- **Google OAuth stays in Testing mode.** This is deliberate (it hard-caps sign-in to the two Test Users) but the tradeoff is that Google expires the session about every seven days.

---

## 13. Model of "how the pieces talk"

For quick reference when debugging.

1. Browser loads `index.html`. Service worker installs on first visit; on subsequent visits serves the shell from cache.
2. `js/app.js` imports `js/config.js` and `js/cycleFlag.js`, then creates a Supabase client with the URL and anon key.
3. `init()` runs: reads any auth error from the URL, calls `sb.auth.getSession()`, strips auth params from the URL, and renders the login or app view accordingly.
4. If signed in, `loadData()` fetches both tables in parallel, mirrors them to `localStorage`, and calls `renderAll()`.
5. Every user action (log, edit, delete, override, sign out) writes through the Supabase client, then re-runs `loadData()` so the UI reflects authoritative server state.
6. Supabase enforces access on every write and read: JWT is parsed, `is_allowed_user()` is evaluated, RLS policies allow or deny per row. Failures come back with a Postgres error code, which `describeError()` translates into readable copy in the banner.

That is the whole loop. There is no hidden state, no background worker, no queue. Everything the user sees can be traced back to a Supabase query and a render function.

---

*Last updated alongside the Vercel deployment. If this file drifts from the code, treat the code as the source of truth and update this document to match.*
