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
  let settings = { id: 1, average_override: null, sd_multiplier: 2.0 };
  const failMode = new URLSearchParams(location.search).get('fail');

  window.__testState = { entries, get settings() { return settings; } };

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
          data: { session: signedOut ? null : { user: { email: 'mary@example.com' } } },
        }),
        onAuthStateChange: (cb) => { authCallback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        // Record what the app asked to be redirected to; the tests assert it
        // never carries an auth payload from a previous sign-in.
        signInWithOAuth: (opts) => {
          window.__authCalls.push(opts);
          return Promise.resolve({ data: {}, error: null });
        },
        signOut: () => { signedOut = true; if (authCallback) authCallback('SIGNED_OUT', null); return Promise.resolve({ error: null }); },
      },
      from(table) {
        if (table === 'cycle_entries') {
          return {
            select: () => chain(selectResult()),
            insert: (row) => { entries.push({ id: String(nextId++), ...row }); return Promise.resolve({ error: null }); },
            update: (patch) => ({ eq: (_c, id) => { Object.assign(entries.find((x) => x.id === id), patch); return Promise.resolve({ error: null }); } }),
            delete: () => ({ eq: (_c, id) => { const i = entries.findIndex((x) => x.id === id); if (i >= 0) entries.splice(i, 1); return Promise.resolve({ error: null }); } }),
          };
        }
        if (table === 'cycle_settings') {
          return {
            select: () => ({ eq: () => ({ single: () => Promise.resolve(
              failMode ? { data: null, error: { code: '42501', message: 'permission denied for table cycle_settings' } }
                       : { data: settings, error: null }) }) }),
            update: (patch) => ({ eq: () => { Object.assign(settings, patch); return Promise.resolve({ error: null }); } }),
          };
        }
        throw new Error('unexpected table ' + table);
      },
    }),
  };
})();
