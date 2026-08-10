# ActuallyUsefulPeriodTracker

A private, single-user cycle tracker: a self-contained `index.html` (vanilla JS,
no build step) backed by Supabase, in the spirit of DoingTheDoings.

**Live:** https://actually-useful-cycle-tracker.vercel.app
**How to use:** https://actually-useful-cycle-tracker.vercel.app/how-to.html — a
one-page illustrated guide, linked from inside the app and shareable on its own.

Deployed from `main` by Vercel. Sign-in is Google-only and restricted to the
addresses in the `allowed_emails` table.

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

## Tests

```
node --test js/cycleFlag.test.js   # the anomaly-detection maths
node test/e2e.mjs                  # the whole UI, in headless Chromium
```

The end-to-end run drives the real `index.html` against a stand-in Supabase
client (`test/mock-supabase.js`), so it needs no project, no network and no
credentials. It covers logging, editing and deleting entries, the day counter
in each of its states, the trend graph's three ranges, CSV and report export,
the gentle out-of-range and long-gap banners, failure reporting, the how-to
flyer, the link-preview metadata, and the mobile and desktop layouts in both
themes. Fixtures are generated relative to
the current date, so the suite doesn't rot.

## Manual setup (do this once, outside this repo)

The app's code is all here, but a few things only exist inside dashboards I
can't reach from this session — Roger needs to do these by hand.

### 1. Create a dedicated Supabase project

Create a **new** Supabase project used only by this app — don't reuse one from
another project. Note its Project URL and `anon` public API key (Project
Settings → API).

### 2. Run the schema

In the Supabase SQL editor, run `supabase/schema.sql`. Then seed the
allow-list with both Google accounts that should have access:

```sql
insert into allowed_emails (email) values
  ('mary@example.com'),
  ('roger@example.com');
```

(Swap in the real Google account addresses. Adding or removing someone later
is just an `insert`/`delete` on that table — no redeploy needed.)

### 3. Turn on Google sign-in

Supabase dashboard → Authentication → Providers → Google → enable it, and
follow Supabase's prompt to create a Google OAuth client in Google Cloud
Console (Google is the only sign-in method this app uses). Set the
**Authorized redirect URI** Google asks for to the callback URL Supabase
shows on that same screen. Under Authentication → URL Configuration, set the
**Site URL** to wherever the app will be hosted (see step 5).

### 4. Fill in `js/config.js`

Replace the two placeholder values with the Project URL and anon key from
step 1:

```js
export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';
```

The anon key is meant to be public — the `allowed_emails`-gated row-level
security policies in `supabase/schema.sql` are what actually protect the
data, not keeping this key secret.

### 5. Deploy with Vercel

Vercel's free plan deploys straight from a **private** GitHub repo — no need
to make anything public:

1. [vercel.com](https://vercel.com) → sign in with GitHub → **Add New… → Project**.
2. Import `conderex/ActuallyUsefulPeriodTracker`. Vercel needs read access to
   the repo via its GitHub App — grant it just for this repo if asked.
3. Framework Preset: **Other**. Leave the build command empty — there isn't
   one; this is a static site. Leave the output directory as the repo root.
4. Deploy. Vercel gives you a `*.vercel.app` URL and redeploys automatically
   on every push to `main` after that.

`.vercelignore` keeps `supabase/`, `sql/`, `README.md`, and the test file out
of the deployed output — only the app itself (`index.html`, `manifest.json`,
`sw.js`, `js/`, `icons/`) ships. `vercel.json` sets `sw.js` to
`Cache-Control: no-cache` so the service worker always re-checks for updates
instead of getting stuck on a stale version behind Vercel's CDN.

### 6. Point Supabase back at the deployed URL

This one is easy to miss and looks like a total failure when skipped: Supabase
ships with **Site URL** defaulting to `http://localhost:3000`, so sign-in
completes at Google and then redirects to a dead local address
(`ERR_CONNECTION_REFUSED`).

Under Authentication → URL Configuration:

- **Site URL** → `https://actually-useful-cycle-tracker.vercel.app`
- **Redirect URLs** → add `https://actually-useful-cycle-tracker.vercel.app/**`
  (the `/**` wildcard matters — `app.js` passes the current page as
  `redirectTo`, and Supabase silently falls back to Site URL for any target
  not on this allow-list)

If a sign-in attempt fails with `bad_oauth_state`, that's a stale attempt, not
a config problem — start over from the app itself rather than re-opening an old
Google URL.