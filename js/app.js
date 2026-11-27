import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { evaluateCycle, isLongGap, CYCLE_FLAG_DEFAULTS } from './cycleFlag.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const LS_ENTRIES = 'cycle-tracker:entries';
const LS_SETTINGS = 'cycle-tracker:settings';

// Where Google sends her back to. Deliberately built from origin + pathname
// rather than location.href: after a sign-in the URL carries the auth payload
// (#access_token=... or ?code=...), and reusing it as the redirect target on a
// later sign-in sends that stale payload along, which is then parsed instead
// of the fresh one — landing straight back on the login screen.
const APP_URL = `${window.location.origin}${window.location.pathname}`;

const state = {
  session: null,
  entries: [],
  settings: { average_override: null, sd_multiplier: CYCLE_FLAG_DEFAULTS.SD_MULT },
  graphMode: 'months',
  weeksCount: 12,
};

// ---------------------------------------------------------------- Bootstrap

async function init() {
  registerServiceWorker();
  wireListeners();
  render();

  const callbackError = readAuthCallbackError();

  // getSession() resolves after the client has consumed any auth payload in
  // the URL, so this is the point at which it's safe to tidy the address bar.
  const { data: { session } } = await sb.auth.getSession();
  stripAuthParamsFromUrl();

  state.session = session;
  render();
  if (!session && callbackError) showAuthError(callbackError);
  if (session) await loadData();

  sb.auth.onAuthStateChange(async (_event, session) => {
    state.session = session;
    render();
    if (session) { clearAuthError(); await loadData(); }
  });
}

// Supabase reports a failed callback as error params on either the hash or the
// query string, depending on the flow. Without this the page just shows the
// login screen again with no explanation.
function readAuthCallbackError() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const pick = (k) => hash.get(k) || query.get(k);
  const code = pick('error_code');
  const description = pick('error_description');
  if (!code && !description && !pick('error')) return null;

  // Almost always a sign-in that was left half-finished, or one started in
  // another tab. Retrying from a clean URL fixes it, which is what the button
  // now does.
  if (code === 'bad_oauth_state' || /state/i.test(description || '')) {
    return 'That sign-in attempt had expired. Tap the button to try again.';
  }
  return (description || 'Sign-in failed.').replace(/\+/g, ' ');
}

function stripAuthParamsFromUrl() {
  const dirty = window.location.hash.includes('access_token') ||
                window.location.hash.includes('error') ||
                window.location.search.includes('code=') ||
                window.location.search.includes('error');
  // Access tokens have no business sitting in the address bar or in history.
  if (dirty && window.history && window.history.replaceState) {
    window.history.replaceState({}, document.title, APP_URL);
  }
}

function showAuthError(message) {
  const el = document.getElementById('login-error');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearAuthError() {
  document.getElementById('login-error')?.classList.add('hidden');
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function render() {
  document.getElementById('login-view').classList.toggle('hidden', !!state.session);
  document.getElementById('app-view').classList.toggle('hidden', !state.session);
}

// --------------------------------------------------------------- Data sync

async function loadData() {
  if (!navigator.onLine) {
    loadFromCache();
    setConnectionStatus('offline');
    renderAll();
    return;
  }
  try {
    const [entriesRes, settingsRes] = await Promise.all([
      sb.from('cycle_entries').select('*').order('occurred_at', { ascending: true }),
      // Post-migration: cycle_settings is per-user, no id column; RLS
      // scopes to the caller's one row, so no filter needed.
      sb.from('cycle_settings').select('*').single(),
    ]);
    if (entriesRes.error) throw entriesRes.error;
    if (settingsRes.error) throw settingsRes.error;
    state.entries = entriesRes.data ?? [];
    state.settings = settingsRes.data ?? state.settings;
    localStorage.setItem(LS_ENTRIES, JSON.stringify(state.entries));
    localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
    setConnectionStatus('ok');
  } catch (err) {
    // A failed query is NOT the same as being offline. Reporting every error
    // as "you're offline" hides real problems (a bad key, a broken policy)
    // behind a message that tells Mary to check her wifi.
    console.error('loadData failed', err);
    loadFromCache();
    setConnectionStatus('error', describeError(err));
  }
  renderAll();
}

// Turn a Supabase/Postgres error into something worth reading. Anything we
// haven't seen before falls through to its own message rather than a generic
// shrug, so an unexpected failure is still diagnosable from the screen.
function describeError(err) {
  const code = err?.code;
  const message = err?.message || '';

  if (code === '42P17') {
    return 'The database security rules are misconfigured (infinite recursion). Re-run supabase/schema.sql.';
  }
  if (code === 'PGRST301' || err?.status === 401) {
    return 'Your sign-in expired. Sign out and back in.';
  }
  if (code === 'PGRST116') {
    return 'This account is not on the allow-list, so there is nothing it can read.';
  }
  if (code === '42501' || /permission denied/i.test(message)) {
    // Table names and column privileges are internal details; don't echo them
    // into the UI where a shoulder-surfer or a screenshot could pick them up.
    return "This account can't do that. Check the allow-list or the database privileges.";
  }
  if (code === '23514' || /check constraint|violates check/i.test(message)) {
    // The one CHECK constraint a user can realistically trip is the notes
    // length cap, so name that; otherwise stay generic.
    return /notes/i.test(message)
      ? 'That note is too long. Keep it under 2000 characters.'
      : "That value isn't valid.";
  }
  if (message.includes('Failed to fetch')) {
    return "Couldn't reach the database. Check your connection.";
  }
  // Unknown failure. Log the details to the console for developer diagnosis,
  // but never surface a raw Postgres message to the UI.
  console.error('unhandled describeError case:', err);
  return 'Something went wrong talking to the database. If this keeps happening, sign out and back in.';
}

function loadFromCache() {
  try {
    state.entries = JSON.parse(localStorage.getItem(LS_ENTRIES) || '[]');
    const cachedSettings = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
    if (cachedSettings) state.settings = cachedSettings;
  } catch (err) {
    console.error('cache read failed', err);
  }
}

// status: 'ok' | 'offline' | 'error'
function setConnectionStatus(status, detail) {
  const banner = document.getElementById('connection-banner');
  const blocked = status !== 'ok';

  if (status === 'ok') {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    banner.classList.toggle('is-error', status === 'error');
    banner.textContent = status === 'offline'
      ? "You're offline — showing your last synced data. Editing resumes once you're back online."
      : detail;
  }

  document.querySelectorAll('.quick-add button').forEach((el) => { el.disabled = blocked; });
  document.getElementById('avg-override-input').disabled = blocked;
}

window.addEventListener('online', () => { if (state.session) loadData(); });
window.addEventListener('offline', () => setConnectionStatus('offline'));

// ----------------------------------------------------------------- Writes

async function saveEntry(entry) {
  if (entry.id) {
    const { error } = await sb.from('cycle_entries')
      .update({ occurred_at: entry.occurred_at, entry_type: entry.entry_type, notes: entry.notes })
      .eq('id', entry.id);
    if (error) throw error;
  } else {
    const { error } = await sb.from('cycle_entries')
      .insert({ occurred_at: entry.occurred_at, entry_type: entry.entry_type, notes: entry.notes });
    if (error) throw error;
  }
  await loadData();
}

async function deleteEntry(id) {
  const { error } = await sb.from('cycle_entries').delete().eq('id', id);
  if (error) throw error;
  await loadData();
}

async function saveSettings(patch) {
  // RLS restricts the update to the caller's own row; no need for a WHERE.
  const { error } = await sb.from('cycle_settings').update(patch).not('user_id', 'is', null);
  if (error) throw error;
  await loadData();
}

// -------------------------------------------------------------- Derived data

function periodStarts() {
  return state.entries
    .filter((e) => e.entry_type === 'period_start')
    .map((e) => new Date(e.occurred_at))
    .sort((a, b) => a - b);
}

// [{date: Date of the cycle's start, lengthDays: number}], oldest -> newest
function cycleLengthsWithDates() {
  const starts = periodStarts();
  const out = [];
  for (let i = 1; i < starts.length; i++) {
    const days = Math.round((starts[i] - starts[i - 1]) / 86400000);
    out.push({ date: starts[i], lengthDays: days });
  }
  return out;
}

function daysSinceLastStart() {
  const starts = periodStarts();
  if (!starts.length) return null;
  return daysSince(starts[starts.length - 1]);
}

// The most recent entry of ANY type — what the hero counter counts from, so
// logging a period end moves the number too.
function latestEntry() {
  if (!state.entries.length) return null;
  return state.entries.reduce((newest, e) =>
    new Date(e.occurred_at) > new Date(newest.occurred_at) ? e : newest);
}

function daysSince(date) {
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

// Would a period_end at this moment have no period_start to close? Walks the
// log in order and tracks whether a period is open at that point in time,
// ignoring the entry being edited so re-saving it doesn't flag itself.
function isOrphanedEnd(occurredAtIso, excludeId) {
  const at = new Date(occurredAtIso);
  const earlier = state.entries
    .filter((e) => e.id !== excludeId && new Date(e.occurred_at) <= at)
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));

  let open = false;
  for (const e of earlier) {
    if (e.entry_type === 'period_start') open = true;
    else if (e.entry_type === 'period_end') open = false;
  }
  return !open;
}

// The start of a period that is still running — i.e. the most recent
// period_start with no period_end logged after it. Returns null once the
// period has been closed out, which is what suppresses the "Day N" line.
function openPeriodStart() {
  const ordered = [...state.entries].sort(
    (a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  let open = null;
  for (const e of ordered) {
    if (e.entry_type === 'period_start') open = new Date(e.occurred_at);
    else if (e.entry_type === 'period_end') open = null;
  }
  return open;
}

function computedAverage() {
  const lengths = cycleLengthsWithDates().map((c) => c.lengthDays);
  if (!lengths.length) return null;
  const windowed = lengths.slice(-CYCLE_FLAG_DEFAULTS.WINDOW);
  return windowed.reduce((a, b) => a + b, 0) / windowed.length;
}

function displayedAverage() {
  return state.settings.average_override != null ? state.settings.average_override : computedAverage();
}

function currentFlag() {
  const lengths = cycleLengthsWithDates().map((c) => c.lengthDays);
  const gap = daysSinceLastStart();
  const longGap = gap != null && isLongGap(gap);

  if (!lengths.length) return longGap ? { longGap, gap, flagged: false } : null;

  const newLength = lengths[lengths.length - 1];
  const history = lengths.slice(0, -1);
  const sdMult = state.settings.sd_multiplier || CYCLE_FLAG_DEFAULTS.SD_MULT;

  let result;
  try {
    result = evaluateCycle(history, newLength, { SD_MULT: sdMult });
  } catch (err) {
    console.error('evaluateCycle failed', err);
    result = { flagged: false };
  }
  return { ...result, longGap, gap };
}

// -------------------------------------------------------------------- Render

function renderAll() {
  renderDayCount();
  renderBanner();
  renderAverage();
  renderEntries();
  renderGraph();
}

const ENTRY_COUNTER_LABEL = {
  period_start: 'Days since period started',
  period_end: 'Days since period ended',
  note: 'Days since last note',
};

function renderDayCount() {
  const el = document.getElementById('day-count');
  const label = document.getElementById('day-count-label');
  const sub = document.getElementById('day-count-sub');
  const latest = latestEntry();

  if (!latest) {
    label.textContent = 'Days since last entry';
    el.textContent = '—';
    sub.textContent = 'Log a start date to begin.';
    return;
  }

  const days = daysSince(new Date(latest.occurred_at));
  label.textContent = ENTRY_COUNTER_LABEL[latest.entry_type] || 'Days since last entry';
  el.textContent = String(days);

  // "Day N" only means something while a period is actually running. Once an
  // end is logged the period is over, so the line disappears until the next
  // start opens a new one at Day 1.
  const open = openPeriodStart();
  sub.textContent = open ? `Day ${daysSince(open) + 1} of this period` : '';
}

function renderBanner() {
  const slot = document.getElementById('flag-banner-slot');
  const flag = currentFlag();
  if (!flag) { slot.innerHTML = ''; return; }

  if (flag.longGap) {
    slot.innerHTML = bannerHTML('critical', 'Worth a check-in',
      `It's been ${flag.gap} days since the last logged start — log a new one if it's arrived, or check in with a doctor if that feels off.`);
    return;
  }
  if (flag.flagged) {
    slot.innerHTML = bannerHTML('warning', 'This cycle looks a little different', flag.reason);
    return;
  }
  slot.innerHTML = '';
}

function bannerHTML(kind, title, body) {
  return `<div class="banner ${kind}"><span class="bicon" aria-hidden="true">${kind === 'critical' ? '!' : '·'}</span>` +
    `<div><strong>${escapeHTML(title)}</strong>${escapeHTML(body)}</div></div>`;
}

function renderAverage() {
  const avg = displayedAverage();
  document.getElementById('avg-display').textContent = avg != null ? `${Math.round(avg * 10) / 10} days` : 'Not enough data yet';
  const input = document.getElementById('avg-override-input');
  if (document.activeElement !== input) {
    input.value = state.settings.average_override != null ? state.settings.average_override : '';
  }
}

function renderEntries() {
  const list = document.getElementById('entries-list');
  const sorted = [...state.entries].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
  if (!sorted.length) {
    list.innerHTML = '<div class="empty-state">No entries yet. Log a start date to begin.</div>';
    return;
  }
  list.innerHTML = sorted.map((e) => `
    <div class="entry" data-id="${e.id}" role="button" tabindex="0"
         aria-label="Edit ${typeLabel(e.entry_type)} on ${formatDate(e.occurred_at)}">
      <div>
        <span class="etype ${e.entry_type}">${typeLabel(e.entry_type)}</span>
        <div class="edate">${formatDate(e.occurred_at)}</div>
        ${e.notes ? `<div class="enote">${escapeHTML(e.notes)}</div>` : ''}
      </div>
      <div class="eedit" aria-hidden="true">Edit</div>
    </div>
  `).join('');
  list.querySelectorAll('.entry').forEach((el) => {
    const edit = () => {
      const entry = state.entries.find((e) => e.id === el.dataset.id);
      if (entry) openSheet(entry, true);
    };
    el.addEventListener('click', edit);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); edit(); }
    });
  });
}

function typeLabel(t) {
  return { period_start: 'Start', period_end: 'End', note: 'Note' }[t] || t;
}
function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function escapeHTML(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

// ------------------------------------------------------------------- Chart

function filteredCycleData() {
  const all = cycleLengthsWithDates();
  const now = Date.now();
  if (state.graphMode === 'weeks') {
    const cutoff = now - state.weeksCount * 7 * 86400000;
    return all.filter((c) => c.date.getTime() >= cutoff);
  }
  if (state.graphMode === 'months') {
    const cutoff = now - 182 * 86400000; // ~6 months
    return all.filter((c) => c.date.getTime() >= cutoff);
  }
  return all; // 'year' = full logged history
}

function renderGraph() {
  const svg = document.getElementById('chart');
  const wrap = svg.parentElement;
  wrap.querySelector('.chart-empty')?.remove();

  const data = filteredCycleData();
  if (data.length < 2) {
    // Hide the <svg> outright rather than just emptying it — it keeps its
    // viewBox aspect ratio otherwise, leaving a tall blank card.
    svg.innerHTML = '';
    svg.classList.add('hidden');
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = data.length === 0
      ? 'Log at least two start dates to see a trend.'
      : 'One more cycle and the trend line will appear here.';
    wrap.appendChild(empty);
    return;
  }
  svg.classList.remove('hidden');

  const W = 400, H = 200, padL = 30, padR = 12, padT = 16, padB = 22;
  const values = data.map((d) => d.lengthDays);
  const minV = Math.min(...values), maxV = Math.max(...values);
  const yMin = Math.max(0, Math.floor((minV - 3) / 5) * 5);
  const yMax = Math.ceil((maxV + 3) / 5) * 5;
  const span = yMax - yMin || 1;

  const x = (i) => padL + (data.length === 1 ? 0 : (i / (data.length - 1)) * (W - padL - padR));
  const y = (v) => H - padB - ((v - yMin) / span) * (H - padT - padB);

  let svgContent = '';
  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const v = yMin + (s / steps) * span;
    const yy = y(v).toFixed(1);
    svgContent += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--line)" stroke-width="1"/>`;
    svgContent += `<text x="${padL - 6}" y="${(Number(yy) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">${Math.round(v)}</text>`;
  }

  let path = '';
  data.forEach((d, i) => { path += (i ? ' L ' : 'M ') + x(i).toFixed(1) + ' ' + y(d.lengthDays).toFixed(1); });
  svgContent += `<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

  data.forEach((d, i) => {
    svgContent += `<circle cx="${x(i).toFixed(1)}" cy="${y(d.lengthDays).toFixed(1)}" r="4" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>`;
  });

  const labelIdx = new Set([0, Math.floor((data.length - 1) / 2), data.length - 1]);
  labelIdx.forEach((i) => {
    svgContent += `<text x="${x(i).toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="var(--muted)">${shortDate(data[i].date)}</text>`;
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = svgContent;

  wireChartTooltip(svg, data, x, y, W, H);
}

function shortDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function wireChartTooltip(svg, data, x, y, W, H) {
  const tooltip = document.getElementById('chart-tooltip');

  function handleMove(clientX) {
    const rect = svg.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * W;
    let nearest = 0, best = Infinity;
    data.forEach((d, i) => {
      const dx = Math.abs(x(i) - relX);
      if (dx < best) { best = dx; nearest = i; }
    });
    const d = data[nearest];
    tooltip.textContent = `${shortDate(d.date)} · ${d.lengthDays}d`;
    tooltip.style.left = `${(x(nearest) / W) * rect.width}px`;
    tooltip.style.top = `${(y(d.lengthDays) / H) * rect.height}px`;
    tooltip.classList.add('show');
  }

  svg.onmousemove = (e) => handleMove(e.clientX);
  svg.onmouseleave = () => tooltip.classList.remove('show');
  svg.ontouchstart = (e) => handleMove(e.touches[0].clientX);
  svg.ontouchmove = (e) => handleMove(e.touches[0].clientX);
}

// -------------------------------------------------------------- Edit sheet

function openSheet(entry, isExisting) {
  const slot = document.getElementById('sheet-slot');
  const d = new Date(entry.occurred_at);

  slot.innerHTML = `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <div class="sheet">
        <h3>${isExisting ? 'Edit entry' : 'New entry'}</h3>
        <div class="field">
          <label for="f-type">Type</label>
          <select id="f-type">
            <option value="period_start" ${entry.entry_type === 'period_start' ? 'selected' : ''}>Period start</option>
            <option value="period_end" ${entry.entry_type === 'period_end' ? 'selected' : ''}>Period end</option>
            <option value="note" ${entry.entry_type === 'note' ? 'selected' : ''}>Note</option>
          </select>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="f-date">Date</label>
            <input type="date" id="f-date" value="${toDateInputValue(d)}">
          </div>
          <div class="field">
            <label for="f-time">Time</label>
            <input type="time" id="f-time" value="${toTimeInputValue(d)}">
          </div>
        </div>
        <!-- Getting the day wrong is the most common correction, so make it
             one tap rather than a trip through the date picker. -->
        <div class="day-nudge">
          <button type="button" id="f-day-minus" class="btn-nudge">− 1 day</button>
          <button type="button" id="f-day-today" class="btn-nudge">Today</button>
          <button type="button" id="f-day-plus" class="btn-nudge">+ 1 day</button>
        </div>
        <div class="field">
          <label for="f-notes">Notes (optional)</label>
          <textarea id="f-notes" maxlength="2000">${escapeHTML(entry.notes || '')}</textarea>
        </div>
        <div class="sheet-actions">
          ${isExisting ? '<button id="f-delete" class="btn-danger">Delete</button>' : ''}
          <button id="f-cancel" class="btn-secondary">Cancel</button>
          <button id="f-save" class="btn-primary">Save</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('sheet-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'sheet-backdrop') closeSheet();
  });
  document.getElementById('f-cancel').addEventListener('click', closeSheet);

  const dateInput = document.getElementById('f-date');
  const nudgeDay = (delta) => {
    const base = dateInput.value ? new Date(`${dateInput.value}T12:00`) : new Date();
    base.setDate(base.getDate() + delta);
    dateInput.value = toDateInputValue(base);
  };
  document.getElementById('f-day-minus').addEventListener('click', () => nudgeDay(-1));
  document.getElementById('f-day-plus').addEventListener('click', () => nudgeDay(1));
  document.getElementById('f-day-today').addEventListener('click', () => {
    dateInput.value = toDateInputValue(new Date());
  });

  document.getElementById('f-save').addEventListener('click', async () => {
    const entry_type = document.getElementById('f-type').value;
    const dateVal = dateInput.value;
    const timeVal = document.getElementById('f-time').value || '00:00';
    const notes = document.getElementById('f-notes').value.trim();
    if (!dateVal) { showToast('Pick a date first.'); return; }

    const occurred_at = new Date(`${dateVal}T${timeVal}`).toISOString();

    // A period end with no start open before it can't close anything. That's
    // usually a mistyped date or a missing start — worth saying out loud
    // rather than silently accepting.
    if (entry_type === 'period_end' &&
        isOrphanedEnd(occurred_at, isExisting ? entry.id : null)) {
      const proceed = await confirmDialog(
        'No period is open on that date',
        "There's no period start before this end date, so there's nothing for it to close. " +
        'That usually means the date is off by a bit, or the matching start date hasn\'t been logged yet.',
        'Save it anyway');
      if (!proceed) return;
    }

    try {
      await saveEntry({ id: isExisting ? entry.id : undefined, occurred_at, entry_type, notes });
      closeSheet();
      showToast('Saved.');
    } catch (err) {
      console.error('save failed', err);
      // Route through the same sanitized message layer as the connection
      // banner so a CHECK-constraint or permission error names the actual
      // problem instead of blaming the network.
      showToast(describeError(err));
    }
  });

  if (isExisting) {
    document.getElementById('f-delete').addEventListener('click', async () => {
      if (!confirm('Delete this entry? This cannot be undone.')) return;
      try {
        await deleteEntry(entry.id);
        closeSheet();
        showToast('Deleted.');
      } catch (err) {
        console.error('delete failed', err);
        showToast(describeError(err));
      }
    });
  }
}

function closeSheet() {
  document.getElementById('sheet-slot').innerHTML = '';
}

// A styled stand-in for window.confirm, so an explanation can be a paragraph
// rather than a cramped one-liner in a browser chrome dialog.
function confirmDialog(title, body, confirmLabel) {
  return new Promise((resolve) => {
    const slot = document.getElementById('dialog-slot');
    slot.innerHTML = `
      <div class="sheet-backdrop" id="dialog-backdrop">
        <div class="sheet dialog" role="alertdialog" aria-labelledby="dlg-title">
          <h3 id="dlg-title">${escapeHTML(title)}</h3>
          <p class="dialog-body">${escapeHTML(body)}</p>
          <div class="sheet-actions">
            <button id="dlg-cancel" class="btn-secondary">Go back</button>
            <button id="dlg-ok" class="btn-primary">${escapeHTML(confirmLabel)}</button>
          </div>
        </div>
      </div>
    `;
    const done = (value) => { slot.innerHTML = ''; resolve(value); };
    document.getElementById('dlg-ok').addEventListener('click', () => done(true));
    document.getElementById('dlg-cancel').addEventListener('click', () => done(false));
    document.getElementById('dialog-backdrop').addEventListener('click', (e) => {
      if (e.target.id === 'dialog-backdrop') done(false);
    });
    document.getElementById('dlg-ok').focus();
  });
}

function toDateInputValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toTimeInputValue(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ Export

function exportCSV() {
  const rows = [['date_time', 'type', 'notes']];
  [...state.entries]
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at))
    .forEach((e) => rows.push([e.occurred_at, e.entry_type, (e.notes || '').replace(/\n/g, ' ')]));
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  downloadBlob(csv, 'text/csv', `cycle-log-${todayStamp()}.csv`);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildReport() {
  const view = document.getElementById('report-view');
  const avg = displayedAverage();
  const days = daysSinceLastStart();
  const cycles = cycleLengthsWithDates();
  const sorted = [...state.entries].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));

  view.innerHTML = `
    <h1>Mary's Cycle Report</h1>
    <div class="meta">Generated ${new Date().toLocaleDateString(undefined, { dateStyle: 'long' })}</div>
    <div class="stats">
      <div class="stat"><div class="k">Average cycle</div><div class="v">${avg != null ? `${Math.round(avg * 10) / 10} days` : '—'}</div></div>
      <div class="stat"><div class="k">Days since last start</div><div class="v">${days ?? '—'}</div></div>
      <div class="stat"><div class="k">Cycles logged</div><div class="v">${cycles.length}</div></div>
    </div>
    <table>
      <thead><tr><th>Date</th><th>Type</th><th>Notes</th></tr></thead>
      <tbody>
        ${sorted.map((e) => `<tr><td>${formatDate(e.occurred_at)}</td><td>${typeLabel(e.entry_type)}</td><td>${escapeHTML(e.notes || '')}</td></tr>`).join('')}
      </tbody>
    </table>
  `;
}

// -------------------------------------------------------------------- Toast

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ----------------------------------------------------------------- Wiring

function wireListeners() {
  document.getElementById('google-signin').addEventListener('click', async () => {
    clearAuthError();
    // Start every attempt from a clean URL, so a leftover payload from an
    // earlier sign-in can never be carried into this one.
    stripAuthParamsFromUrl();
    try {
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: APP_URL },
      });
      if (error) throw error;
    } catch (err) {
      console.error('sign-in failed', err);
      showAuthError(err?.message || 'Sign-in failed — try again.');
    }
  });

  document.getElementById('signout-btn').addEventListener('click', async () => {
    try {
      await sb.auth.signOut();
    } catch (err) {
      console.error('sign-out failed', err);
    }
    // Leave the address bar clean so the next sign-in starts from scratch.
    stripAuthParamsFromUrl();
    clearAuthError();
  });

  document.getElementById('log-start-btn').addEventListener('click', () => {
    openSheet({ entry_type: 'period_start', occurred_at: new Date().toISOString(), notes: '' }, false);
  });
  document.getElementById('log-other-btn').addEventListener('click', () => {
    openSheet({ entry_type: 'note', occurred_at: new Date().toISOString(), notes: '' }, false);
  });

  document.querySelectorAll('#graph-mode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.graphMode = btn.dataset.mode;
      document.querySelectorAll('#graph-mode button').forEach((b) => b.classList.toggle('on', b === btn));
      document.getElementById('weeks-stepper').classList.toggle('hidden', state.graphMode !== 'weeks');
      renderGraph();
    });
  });
  document.getElementById('weeks-count').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    state.weeksCount = Number.isFinite(v) && v > 0 ? v : 12;
    renderGraph();
  });

  document.getElementById('avg-override-input').addEventListener('change', async (e) => {
    const raw = e.target.value.trim();
    const value = raw === '' ? null : parseFloat(raw);
    try {
      await saveSettings({ average_override: Number.isFinite(value) ? value : null });
      showToast('Average updated.');
    } catch (err) {
      console.error('settings save failed', err);
      showToast(describeError(err));
    }
  });

  document.getElementById('export-csv-btn').addEventListener('click', exportCSV);
  document.getElementById('export-report-btn').addEventListener('click', () => {
    buildReport();
    window.print();
  });
}

init();
