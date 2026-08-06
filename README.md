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

Once deployed, go back to Supabase (step 3) and set **Site URL** to the
`*.vercel.app` URL Vercel gives you — Google OAuth redirects there after
sign-in.