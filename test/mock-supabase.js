// Stand-in Supabase client. Fixtures are chosen with ?f=<name> and are
// generated relative to "now" so assertions stay stable whenever they run.
(function () {
  const DAY = 86400000;
  const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
  let nextId = 100;
  const mk = (days, type, notes) => ({
    id: String(nextId++), occurred_at: ago(days), entry_type: type, notes: notes || '',
  });

  const FIXTURES = {
    empty: () => [],
    oneStart: () => [mk(5, 'period_start')],
    activePeriod: () => [mk(30, 'period_start'), mk(26, 'period_end'), mk(3, 'period_start')],
    endedPeriod: () => [mk(10, 'period_start'), mk(5, 'period_end')],
    manyCycles: () => [
      mk(150, 'period_start'), mk(146, 'period_end'),
      mk(121, 'period_start'), mk(117, 'period_end'),
      mk(92, 'period_start'),  mk(88, 'period_end'),
      mk(63, 'period_start'),  mk(59, 'period_end'),
      mk(34, 'period_start'),  mk(30, 'period_end'),
      mk(5, 'period_start', 'a bit crampy'),
    ],
    flagged: () => [
      mk(160, 'period_start'), mk(131, 'period_start'), mk(102, 'period_start'),
      mk(73, 'period_start'),  mk(44, 'period_start'),
      mk(2, 'period_start', 'ran long this time'),
    ],
    longGap: () => [mk(220, 'period_start'), mk(120, 'period_start'), mk(118, 'period_end')],
    noteOnly: () => [mk(2, 'note', 'headache today')],
  };

  const params = new URLSearchParams(location.search);
  const which = params.get('f') || 'manyCycles';
  let signedOut = params.get('signedout') === '1';
  let authCallback = null;
  window.__authCalls = [];
  const entries = (FIXTURES[which] || FIXTURES.manyCycles)();
  // Post-migration shape: per-user rows, no id column. The mock pretends to
  // be a signed-in user by returning the one row that would belong to them.
  const MOCK_USER = { id: '00000000-0000-0000-0000-000000000001', email: 'mary@example.com' };
  let settings = { user_id: MOCK_USER.id, average_override: null, sd_multiplier: 2.0 };
  let profile  = { user_id: MOCK_USER.id, scene_preference: 'plesiosaur', scene_time_mode: 'auto' };
  const failMode = new URLSearchParams(location.search).get('fail');

  window.__testState = {
    entries,
    get settings() { return settings; },
    get profile()  { return profile; },
  };

  function selectResult() {
    if (failMode === 'denied') {
      return { data: null, error: { code: '42501', message: 'permission denied for table cycle_entries' } };
    }
    if (failMode === 'recursion') {
      return { data: null, error: { code: '42P17', message: 'infinite recursion detected in policy' } };
    }
    return { data: entries, error: null };
  }

  function chain(result) {
    const api = {
      order: () => api,
      eq: () => api,
      single: () => Promise.resolve(result),
      select: () => api,
      then: (resolve) => resolve(result),
    };
    return api;
  }

  window.supabase = {
    createClient: () => ({
      auth: {
        getSession: () => Promise.resolve({
          data: { session: signedOut ? null : { user: MOCK_USER, access_token: 'mock.jwt.token' } },
        }),
        onAuthStateChange: (cb) => { authCallback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        // Record what the app asked to be redirected to; the tests assert it
        // never carries an auth payload from a previous sign-in.
        signInWithOAuth: (opts) => {
          window.__authCalls.push({ provider: 'oauth', ...opts });
          return Promise.resolve({ data: {}, error: null });
        },
        signInWithPassword: ({ email, password }) => {
          window.__authCalls.push({ provider: 'password', email, password });
          signedOut = false;
          if (authCallback) authCallback('SIGNED_IN', { user: MOCK_USER, access_token: 'mock.jwt.token' });
          return Promise.resolve({ data: { user: MOCK_USER }, error: null });
        },
        signUp: ({ email, password, options }) => {
          window.__authCalls.push({ provider: 'signup', email, password, options });
          // Mirror Supabase's email-confirmation flow: no session until confirmed.
          return Promise.resolve({ data: { user: { email }, session: null }, error: null });
        },
        resetPasswordForEmail: (email, opts) => {
          window.__authCalls.push({ provider: 'reset', email, options: opts });
          return Promise.resolve({ data: {}, error: null });
        },
        updateUser: (patch) => {
          window.__authCalls.push({ provider: 'updateUser', ...patch });
          return Promise.resolve({ data: { user: MOCK_USER }, error: null });
        },
        signOut: () => { signedOut = true; if (authCallback) authCallback('SIGNED_OUT', null); return Promise.resolve({ error: null }); },
      },
      from(table) {
        if (table === 'cycle_entries') {
          return {
            select: () => chain(selectResult()),
            insert: (row) => {
              if (typeof row?.notes === 'string' && row.notes.length > 2000) {
                return Promise.resolve({ error: {
                  code: '23514',
                  message: 'new row for relation "cycle_entries" violates check constraint "cycle_entries_notes_length"',
                } });
              }
              entries.push({ id: String(nextId++), ...row });
              return Promise.resolve({ error: null });
            },
            update: (patch) => ({ eq: (_c, id) => { Object.assign(entries.find((x) => x.id === id), patch); return Promise.resolve({ error: null }); } }),
            delete: () => ({ eq: (_c, id) => { const i = entries.findIndex((x) => x.id === id); if (i >= 0) entries.splice(i, 1); return Promise.resolve({ error: null }); } }),
          };
        }
        if (table === 'cycle_settings') {
          const settingsResult = failMode
            ? { data: null, error: { code: '42501', message: 'permission denied for table cycle_settings' } }
            : { data: settings, error: null };
          // Post-migration: client calls .select('*').single() (no filter),
          // relying on RLS to return exactly the caller's row. The mock
          // supports either shape for backward compatibility.
          return {
            select: () => ({
              eq: () => ({ single: () => Promise.resolve(settingsResult) }),
              single: () => Promise.resolve(settingsResult),
            }),
            update: (patch) => {
              const applyAndResolve = () => { Object.assign(settings, patch); return Promise.resolve({ error: null }); };
              return {
                eq: applyAndResolve,
                not: applyAndResolve,
                then: (resolve) => applyAndResolve().then(resolve),
              };
            },
          };
        }
        if (table === 'user_profiles') {
          const profileResult = { data: profile, error: null };
          return {
            select: () => ({
              eq: () => ({ single: () => Promise.resolve(profileResult) }),
              single: () => Promise.resolve(profileResult),
            }),
            update: (patch) => ({
              eq: () => { Object.assign(profile, patch); return Promise.resolve({ error: null }); },
            }),
          };
        }
        throw new Error('unexpected table ' + table);
      },
    }),
  };
})();
