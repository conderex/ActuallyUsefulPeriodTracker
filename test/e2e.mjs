// End-to-end checks for the app UI, run against a stand-in Supabase client
// (test/mock-supabase.js) so no real project or network is involved.
//
//   node test/e2e.mjs
//
// Builds a throwaway harness page, serves the repo on a local port, drives it
// in headless Chromium, then cleans up after itself.

import { createServer } from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'index-test.html');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // Fall back to a global install when the package isn't a local dependency.
    for (const p of ['/opt/node22/lib/node_modules/playwright/index.mjs',
                     '/usr/lib/node_modules/playwright/index.mjs']) {
      if (existsSync(p)) return import(p);
    }
    throw new Error('playwright not found — install it, or run against a global install');
  }
}

const { chromium } = await loadPlaywright();

// Swap the Supabase CDN script for the mock; everything else is the real page.
const page_html = (await readFile(join(ROOT, 'index.html'), 'utf8')).replace(
  '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
  '<script src="test/mock-supabase.js"></script>');
await writeFile(HARNESS, page_html);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

async function cleanup() {
  server.close();
  await unlink(HARNESS).catch(() => {});
}

const BASE = `http://localhost:${PORT}/index-test.html`;
const results = [];
let browser;

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function open(fixture, opts = {}) {
  const page = await browser.newPage({
    viewport: opts.viewport || { width: 1280, height: 900 },
    colorScheme: opts.colorScheme || 'light',
    isMobile: opts.isMobile || false,
    hasTouch: opts.isMobile || false,
    reducedMotion: opts.reducedMotion,
  });
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.__errors.push('console: ' + m.text()); });
  const q = [`f=${fixture}`];
  if (opts.fail) q.push(`fail=${opts.fail}`);
  await page.goto(`${BASE}?${q.join('&')}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(450);
  return page;
}

const txt = (p, sel) => p.locator(sel).textContent();

browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

// ── 1. Empty state ────────────────────────────────────────────────────
{
  const p = await open('empty');
  check('empty: counter shows dash', (await txt(p, '#day-count')).trim() === '—');
  check('empty: prompts to log', (await txt(p, '#day-count-sub')).includes('Log a start date'));
  check('empty: log list empty state', (await txt(p, '#entries-list')).includes('No entries yet'));
  check('empty: chart hidden', await p.locator('#chart').evaluate((e) => e.classList.contains('hidden')));
  check('empty: average unavailable', (await txt(p, '#avg-display')).includes('Not enough'));
  check('empty: no console errors', p.__errors.length === 0, p.__errors.join('; '));
  await p.close();
}

// ── 2. Active period → "Day N of this period" is shown ────────────────
{
  const p = await open('activePeriod');
  check('active: label names a start', (await txt(p, '#day-count-label')) === 'Days since period started');
  check('active: counts 3 days', (await txt(p, '#day-count')).trim() === '3');
  check('active: shows Day 4 of this period', (await txt(p, '#day-count-sub')) === 'Day 4 of this period');
  check('active: no console errors', p.__errors.length === 0, p.__errors.join('; '));
  await p.close();
}

// ── 3. Ended period → the Day-N line must disappear ───────────────────
{
  const p = await open('endedPeriod');
  check('ended: label names an end', (await txt(p, '#day-count-label')) === 'Days since period ended');
  check('ended: counts 5 days', (await txt(p, '#day-count')).trim() === '5');
  check('ended: Day-N line is hidden', (await txt(p, '#day-count-sub')).trim() === '',
        `got "${await txt(p, '#day-count-sub')}"`);
  await p.close();
}

// ── 4. Note-only entry ────────────────────────────────────────────────
{
  const p = await open('noteOnly');
  check('note: label names a note', (await txt(p, '#day-count-label')) === 'Days since last note');
  check('note: no Day-N line without a start', (await txt(p, '#day-count-sub')).trim() === '');
  await p.close();
}

// ── 5. Many cycles: average, trend, graph modes ───────────────────────
{
  const p = await open('manyCycles');
  check('many: average ~29d', /29/.test(await txt(p, '#avg-display')), await txt(p, '#avg-display'));
  check('many: chart visible', !(await p.locator('#chart').evaluate((e) => e.classList.contains('hidden'))));
  const pts = await p.locator('#chart circle').count();
  check('many: 5 cycle points plotted', pts === 5, `${pts} points`);

  await p.click('#graph-mode >> text=Weeks');
  await p.waitForTimeout(200);
  check('many: weeks stepper appears', await p.locator('#weeks-stepper').isVisible());
  await p.fill('#weeks-count', '52');
  await p.dispatchEvent('#weeks-count', 'change');
  await p.waitForTimeout(200);
  check('many: 52-week window replots', (await p.locator('#chart circle').count()) === 5);

  await p.click('#graph-mode >> text=Year');
  await p.waitForTimeout(200);
  check('many: year view replots', (await p.locator('#chart circle').count()) === 5);

  await p.click('#graph-mode >> text=Months');
  await p.waitForTimeout(200);
  const monthPts = await p.locator('#chart circle').count();
  check('many: months window is narrower than year', monthPts <= 5 && monthPts >= 2, `${monthPts} points`);

  check('many: no banner for a normal cycle', (await p.locator('#flag-banner-slot').innerHTML()).trim() === '');
  check('many: no console errors', p.__errors.length === 0, p.__errors.join('; '));
  await p.close();
}

// ── 6. Out-of-range cycle raises the gentle banner ────────────────────
{
  const p = await open('flagged');
  const banner = await p.locator('#flag-banner-slot').innerText().catch(() => '');
  check('flagged: gentle banner shown', banner.includes('looks a little different'), banner.slice(0, 80));
  check('flagged: banner is not alarmist', !/abnormal|danger|warning:/i.test(banner));
  await p.close();
}

// ── 7. Long gap raises the firmer check-in ────────────────────────────
{
  const p = await open('longGap');
  const banner = await p.locator('#flag-banner-slot').innerText().catch(() => '');
  check('longGap: check-in banner shown', banner.includes('Worth a check-in'), banner.slice(0, 80));
  await p.close();
}

// ── 8. Add an entry through the sheet ─────────────────────────────────
{
  const p = await open('endedPeriod');
  const before = await p.locator('.entry').count();
  await p.click('#log-start-btn');
  await p.waitForTimeout(200);
  check('add: sheet opens', await p.locator('.sheet').isVisible());
  check('add: defaults to period start', (await p.locator('#f-type').inputValue()) === 'period_start');
  await p.click('#f-save');
  await p.waitForTimeout(400);
  check('add: sheet closes', (await p.locator('.sheet').count()) === 0);
  check('add: entry appears in log', (await p.locator('.entry').count()) === before + 1);
  check('add: counter resets to 0', (await txt(p, '#day-count')).trim() === '0');
  check('add: Day-N line returns at Day 1', (await txt(p, '#day-count-sub')) === 'Day 1 of this period');
  await p.close();
}

// ── 9. Edit an existing entry ─────────────────────────────────────────
{
  const p = await open('manyCycles');
  await p.click('.entry >> nth=0');
  await p.waitForTimeout(200);
  check('edit: sheet opens on tap', await p.locator('.sheet').isVisible());
  check('edit: prefilled with the entry type', (await p.locator('#f-type').inputValue()).length > 0);
  await p.fill('#f-notes', 'edited by the test');
  await p.click('#f-save');
  await p.waitForTimeout(400);
  check('edit: note persisted to the list', (await txt(p, '#entries-list')).includes('edited by the test'));
  await p.close();
}

// ── 10. Delete an entry ───────────────────────────────────────────────
{
  const p = await open('manyCycles');
  p.on('dialog', (d) => d.accept());
  const before = await p.locator('.entry').count();
  await p.click('.entry >> nth=0');
  await p.waitForTimeout(200);
  await p.click('#f-delete');
  await p.waitForTimeout(450);
  check('delete: row removed', (await p.locator('.entry').count()) === before - 1);
  await p.close();
}

// ── 11. Average override ──────────────────────────────────────────────
{
  const p = await open('manyCycles');
  await p.fill('#avg-override-input', '31');
  await p.dispatchEvent('#avg-override-input', 'change');
  await p.waitForTimeout(400);
  check('override: display follows the manual value', (await txt(p, '#avg-display')).includes('31'),
        await txt(p, '#avg-display'));
  const saved = await p.evaluate(() => window.__testState.settings.average_override);
  check('override: written back to settings', Number(saved) === 31, String(saved));
  await p.close();
}

// ── 12. CSV export ────────────────────────────────────────────────────
{
  const p = await open('manyCycles');
  const [download] = await Promise.all([
    p.waitForEvent('download'),
    p.click('#export-csv-btn'),
  ]);
  const name = download.suggestedFilename();
  check('csv: filename is dated', /^cycle-log-\d{4}-\d{2}-\d{2}\.csv$/.test(name), name);
  const stream = await download.createReadStream();
  let body = '';
  for await (const chunk of stream) body += chunk;
  const lines = body.trim().split('\r\n');
  check('csv: header row correct', lines[0] === 'date_time,type,notes', lines[0]);
  check('csv: one row per entry', lines.length === 12, `${lines.length} lines`);
  check('csv: notes with text survive', body.includes('a bit crampy'));
  check('csv: oldest row first', lines[1].includes('period_start'));
  await p.close();
}

// ── 13. Printable report ──────────────────────────────────────────────
{
  const p = await open('manyCycles');
  await p.evaluate(() => { window.print = () => {}; });
  await p.click('#export-report-btn');
  await p.waitForTimeout(300);
  const report = await p.locator('#report-view').innerText();
  check('report: titled', report.includes("Mary's Cycle Report"));
  check('report: carries the average', /Average cycle/i.test(report));
  check('report: lists entries', report.includes('a bit crampy'));
  const rows = await p.locator('#report-view tbody tr').count();
  check('report: one table row per entry', rows === 11, `${rows} rows`);
  await p.close();
}

// ── 14. Failure states are reported honestly ──────────────────────────
{
  const p = await open('manyCycles', { fail: 'denied' });
  const banner = await p.locator('#connection-banner').innerText();
  check('denied: banner visible', !(await p.locator('#connection-banner').evaluate((e) => e.classList.contains('hidden'))));
  check('denied: shows the real reason', banner.toLowerCase().includes('permission denied'), banner);
  check('denied: does NOT claim offline', !banner.toLowerCase().includes('offline'), banner);
  check('denied: logging disabled while broken', await p.locator('#log-start-btn').isDisabled());
  await p.close();
}
{
  const p = await open('manyCycles', { fail: 'recursion' });
  const banner = await p.locator('#connection-banner').innerText();
  check('recursion: explains the policy fault', banner.includes('security rules'), banner);
  await p.close();
}

// ── 15. Layout: mobile ────────────────────────────────────────────────
{
  const p = await open('manyCycles', { viewport: { width: 390, height: 844 }, isMobile: true });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('mobile: no horizontal overflow', overflow === 0, `${overflow}px`);
  const order = await p.$$eval('#app-view > *', (els) => els.map((e) => e.id || e.className.split(' ')[0]));
  check('mobile: log sits right under the buttons',
        order.indexOf('log-card') === order.indexOf('quick-add') + 1, order.join(','));
  const btn = await p.locator('#log-start-btn').boundingBox();
  check('mobile: primary button is a big target', btn.height >= 44, `${Math.round(btn.height)}px tall`);
  await p.click('.entry >> nth=0');
  await p.waitForTimeout(250);
  const sheet = await p.locator('.sheet').boundingBox();
  check('mobile: edit sheet fits the screen', sheet.width <= 390, `${Math.round(sheet.width)}px`);
  await p.close();
}

// ── 16. Layout: desktop grid places every card ────────────────────────
{
  const p = await open('manyCycles', { viewport: { width: 1440, height: 900 } });
  const boxes = await p.evaluate(() => {
    const g = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; };
    return { hero: g('.hero'), log: g('#log-card'), trend: g('#trend-card'), avg: g('#average-card'), exp: g('#export-card') };
  });
  check('desktop: log is in the right column', boxes.log.x > boxes.hero.x);
  check('desktop: log starts level with the hero (no hole)',
        Math.abs(boxes.log.y - boxes.hero.y) < 6, `hero ${boxes.hero.y} vs log ${boxes.log.y}`);
  check('desktop: trend under the hero on the left', boxes.trend.x === boxes.hero.x && boxes.trend.y > boxes.hero.y);
  check('desktop: average and export share a row', Math.abs(boxes.avg.y - boxes.exp.y) < 6);
  await p.close();
}

// ── 17. Dark mode ─────────────────────────────────────────────────────
{
  const p = await open('manyCycles', { colorScheme: 'dark' });
  const bg = await p.evaluate(() => getComputedStyle(document.querySelector('.hero')).backgroundColor);
  check('dark: panels use the dark surface', bg === 'rgb(34, 38, 27)', bg);
  const ink = await p.evaluate(() => getComputedStyle(document.body).color);
  check('dark: text is light on dark', ink === 'rgb(242, 243, 232)', ink);
  check('dark: no console errors', p.__errors.length === 0, p.__errors.join('; '));
  await p.close();
}

// ── 18. Reduced motion ────────────────────────────────────────────────
{
  const p = await open('manyCycles', { reducedMotion: 'reduce' });
  const anim = await p.evaluate(() => getComputedStyle(document.querySelector('.plesio')).animationName);
  check('reduced-motion: plesiosaur stops swimming', anim === 'none', anim);
  await p.close();
}

// ── 19. Scene renders ─────────────────────────────────────────────────
{
  const p = await open('manyCycles');
  check('scene: plesiosaur present', (await p.locator('.plesio').count()) === 1);
  check('scene: waterfall animates', (await p.locator('.water-fall').count()) >= 1);
  check('scene: volcano lava present', (await p.locator('.lava-glow').count()) >= 2);
  await p.close();
}


// ── 20. Orphaned period end explains itself ───────────────────────────
{
  const p = await open('empty');
  await p.click('#log-other-btn');
  await p.waitForTimeout(250);
  await p.selectOption('#f-type', 'period_end');
  await p.click('#f-save');
  await p.waitForTimeout(300);
  const dlg = await p.locator('.dialog').innerText().catch(() => '');
  // innerText reflects the CSS text-transform on the heading, so match loosely.
  check('orphan-end: dialog explains the problem',
        /no period is open/i.test(dlg) && /nothing for it to close/i.test(dlg), dlg.slice(0, 60));
  check('orphan-end: offers a way out', (await p.locator('#dlg-cancel').count()) === 1);
  await p.click('#dlg-cancel');
  await p.waitForTimeout(200);
  check('orphan-end: cancelling saves nothing', (await p.locator('.entry').count()) === 0);

  await p.click('#f-save');
  await p.waitForTimeout(250);
  await p.click('#dlg-ok');
  await p.waitForTimeout(400);
  check('orphan-end: can still save anyway', (await p.locator('.entry').count()) === 1);
  await p.close();
}

// ── 21. A legitimate end raises no dialog ─────────────────────────────
{
  const p = await open('activePeriod');
  await p.click('#log-other-btn');
  await p.waitForTimeout(250);
  await p.selectOption('#f-type', 'period_end');
  await p.click('#f-save');
  await p.waitForTimeout(400);
  check('valid-end: no dialog when a period is open', (await p.locator('.dialog').count()) === 0);
  check('valid-end: saved', (await txt(p, '#day-count-label')) === 'Days since period ended');
  await p.close();
}

// ── 22. Day nudge buttons ─────────────────────────────────────────────
{
  const p = await open('manyCycles');
  await p.click('.entry >> nth=0');
  await p.waitForTimeout(250);
  const before = await p.locator('#f-date').inputValue();
  await p.click('#f-day-minus');
  const minus = await p.locator('#f-date').inputValue();
  check('nudge: −1 day moves the date back',
        new Date(minus) - new Date(before) === -86400000, `${before} -> ${minus}`);
  await p.click('#f-day-plus');
  await p.click('#f-day-plus');
  const plus = await p.locator('#f-date').inputValue();
  check('nudge: +1 day moves it forward',
        new Date(plus) - new Date(before) === 86400000, `${before} -> ${plus}`);
  await p.click('#f-day-today');
  const today = await p.locator('#f-date').inputValue();
  const expected = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  check('nudge: Today jumps to today',
        today === `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}`, today);
  await p.close();
}

// ── 23. Entries are obviously editable, and keyboard-reachable ────────
{
  const p = await open('manyCycles');
  check('edit affordance: rows show an Edit control', (await p.locator('.entry .eedit').count()) > 0);
  check('edit affordance: rows are focusable',
        (await p.locator('.entry').first().getAttribute('tabindex')) === '0');
  await p.locator('.entry').first().focus();
  await p.keyboard.press('Enter');
  await p.waitForTimeout(250);
  check('edit affordance: Enter opens the sheet', await p.locator('.sheet').isVisible());
  await p.close();
}

// ── 24. How-to flyer ──────────────────────────────────────────────────
{
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`http://localhost:${PORT}/how-to.html`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  check('flyer: loads without errors', errs.length === 0, errs.join('; '));
  check('flyer: has all six steps', (await p.locator('.step').count()) === 6);
  check('flyer: uses the same scene', (await p.locator('.plesio').count()) === 1);
  check('flyer: links back to the app', (await p.locator('a[href="index.html"]').count()) >= 1);
  const ov = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('flyer: no horizontal overflow on a phone', ov === 0, `${ov}px`);
  await p.close();
}

// ── 25. Link preview metadata ─────────────────────────────────────────
{
  const p = await open('manyCycles');
  const meta = await p.evaluate(() => {
    const get = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
    return {
      title: get('meta[property="og:title"]'),
      image: get('meta[property="og:image"]'),
      desc: get('meta[property="og:description"]'),
      card: get('meta[name="twitter:card"]'),
      w: get('meta[property="og:image:width"]'),
    };
  });
  check('preview: og:title set', meta.title === "Mary's Cycle Tracker", String(meta.title));
  check('preview: og:image is absolute https', /^https:\/\//.test(meta.image || ''), String(meta.image));
  check('preview: og:description set', !!meta.desc);
  check('preview: large twitter card', meta.card === 'summary_large_image');
  check('preview: image dimensions declared', meta.w === '1200');
  const res = await p.request.get(`http://localhost:${PORT}/icons/og-image.png`);
  check('preview: image actually exists', res.status() === 200, `HTTP ${res.status()}`);
  const len = (await res.body()).length;
  check('preview: image small enough for WhatsApp', len < 300_000, `${Math.round(len / 1024)}KB`);
  await p.close();
}

// ── 26. How-to is reachable from the app ──────────────────────────────
{
  const p = await open('manyCycles');
  check('help link: present in the header', (await p.locator('.topbar-actions a[href="how-to.html"]').count()) === 1);
  await p.close();
}

await browser.close();
await cleanup();

const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(60)}`);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`));
  process.exitCode = 1;
}
