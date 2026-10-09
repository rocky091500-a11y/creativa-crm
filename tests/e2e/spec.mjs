// Browser walkthrough of the CRM against the local stack started by run.sh.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = 'http://localhost:8787';
const SHOTS = path.join(process.env.E2E_TMP, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const errors = [];
let step = 0;
const ok = (label) => console.log(`ok ${++step} - ${label}`);

async function newPage(viewport = { width: 1360, height: 900 }, phone = false) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  // Serve the pinned supabase-js from disk so the test runs offline.
  await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
    (r) => r.fulfill({ path: process.env.SUPABASE_JS, contentType: 'text/javascript' }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Chose another school') : d.accept()));
  return page;
}
async function login(page, email, password) {
  await page.goto(BASE);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });

try {
  // ── auth gates ──
  let page = await newPage();
  await login(page, 'owner@creativaacademy.com', 'wrong');
  await page.waitForSelector('#auth-msg:has-text("Wrong email or password")');
  ok('wrong password rejected');
  await shot(page, '01-login');

  await login(page, 'newhire@creativaacademy.com', 'newhire-pass-1');
  await page.waitForSelector('text=Almost there');
  ok('inactive staff sees "waiting for approval", not data');
  await page.click('#signout');
  await page.waitForSelector('text=Staff sign in');

  // ── admin: Today ──
  await login(page, 'owner@creativaacademy.com', 'owner-pass-1');
  await page.waitForSelector('header.top');
  const stat = async (label) => Number(await page.locator('.stat', { hasText: label }).locator('b').textContent());
  assert.equal(await stat('New, not yet contacted'), 4);
  assert.equal(await page.locator('.panel', { hasText: 'New inquiries' }).locator('.row').count(), 4);
  ok('Today shows 4 new website inquiries');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.ok(await page.locator('text=<img src=x onerror=window.__xss=1> Test').count() >= 1);
  ok('HTML in form data is shown as text, never executed');
  await shot(page, '02-today');

  // ── drawer: inspect, log a call, schedule ──
  await page.locator('.row', { hasText: 'Maria Lopez' }).first().click();
  const drawer = page.locator('.drawer');
  await drawer.waitFor();
  assert.equal(await drawer.locator('input[name=child_name]').inputValue(), 'Sofia Lopez');
  assert.equal(await drawer.locator('input[name=program]').inputValue(), 'Early 2s');
  assert.equal(await drawer.locator('a[href="tel:7865550101"]').count(), 1);
  await drawer.locator('summary', { hasText: 'Original website submission' }).click();
  assert.ok(await drawer.locator('dd', { hasText: 'Mon, Wed' }).count() === 1);
  await drawer.locator('.timeline li', { hasText: 'Received from website form: schedule-tour' }).waitFor();
  ok('inquiry drawer shows mapped fields, call link, raw submission, intake log');

  await drawer.locator('#note-kind').selectOption('call');
  await drawer.locator('#note-body').fill('Spoke with Maria, wants a tour next week');
  await drawer.locator('#note-add').click();
  await drawer.locator('.timeline li.k-call', { hasText: 'Spoke with Maria' }).waitFor();
  await drawer.locator('.timeline li.k-stage', { hasText: 'New → Contacted' }).waitFor();
  assert.equal(await drawer.locator('select[name=stage]').inputValue(), 'contacted');
  ok('logging a call on a new inquiry moves it to Contacted, both on the timeline');

  const d = new Date(); d.setDate(d.getDate() + 2);
  const pad = (n) => String(n).padStart(2, '0');
  const tourLocal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:30`;
  const today = new Date(); const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  await drawer.locator('select[name=stage]').selectOption('tour_scheduled');
  await drawer.locator('input[name=tour_at]').fill(tourLocal);
  await drawer.locator('input[name=next_follow_up]').fill(todayStr);
  await drawer.locator('select[name=assigned_to]').selectOption({ label: 'Ms. Laura' });
  await drawer.locator('#save').click();
  await drawer.locator('.timeline li.k-stage', { hasText: 'Contacted → Tour scheduled' }).waitFor();
  await shot(page, '03-drawer');
  await drawer.locator('[data-close]').first().click();
  await page.locator('.panel', { hasText: 'Upcoming tours' }).locator('.row', { hasText: 'Maria Lopez' }).waitFor();
  await page.locator('.panel', { hasText: 'Follow-ups due' }).locator('.row', { hasText: 'Maria Lopez' }).waitFor();
  ok('saving stage, tour time, follow-up and assignee updates Today');

  // ── lost requires a reason ──
  await page.locator('.row', { hasText: 'James Carter' }).click();
  await drawer.locator('select[name=stage]').selectOption('lost');
  await drawer.locator('#save').click();
  await page.waitForSelector('#toast.err:has-text("reason")');
  await drawer.locator('input[name=lost_reason]').fill('Moved to Orlando');
  await drawer.locator('#save').click();
  await drawer.locator('.timeline li.k-stage', { hasText: 'New → Lost (Moved to Orlando)' }).waitFor();
  await drawer.locator('[data-close]').first().click();
  ok('marking lost requires a reason, which is logged');

  // ── pipeline board + drag and drop ──
  await page.click('header nav button[data-view=board]');
  const col = (s) => page.locator(`.col[data-stage=${s}]`);
  await col('tour_scheduled').locator('.card', { hasText: 'Maria Lopez' }).waitFor();
  assert.equal(await col('lost').locator('.card').count(), 1);
  await col('tour_scheduled').locator('.card', { hasText: 'Maria Lopez' }).dragTo(col('toured'));
  await col('toured').locator('.card', { hasText: 'Maria Lopez' }).waitFor();
  await page.locator('.card', { hasText: 'Ana Ruiz' }).dragTo(col('lost'));   // prompt answered by dialog handler
  await col('lost').locator('.card', { hasText: 'Ana Ruiz' }).waitFor();
  ok('drag a card to another column changes its stage (Lost asks for a reason)');
  await page.selectOption('#f-program', 'Bloom');
  assert.equal(await page.locator('.board .card').count(), 1);
  await page.selectOption('#f-program', '');
  ok('board filters by program');
  assert.equal(await page.locator('.board .card .move').first().isVisible(), false);
  ok('Move-to picker is hidden on a computer (drag instead)');
  await shot(page, '04-pipeline');

  // ── manual inquiry ──
  await page.click('#add');
  await drawer.waitFor();
  await drawer.locator('input[name=parent_name]').fill('Walk-in Dad');
  await drawer.locator('#save').click();
  await page.waitForSelector('#toast.err:has-text("phone number or email")');
  await drawer.locator('input[name=phone]').fill('305 555 0000');
  await drawer.locator('input[name=child_name]').fill('Mateo');
  await drawer.locator('input[name=program]').fill('Late 3s');
  await drawer.locator('#save').click();
  await drawer.locator('.timeline li', { hasText: 'Added by staff' }).waitFor();
  await drawer.locator('[data-close]').first().click();
  await col('new').locator('.card', { hasText: 'Walk-in Dad' }).waitFor();
  ok('staff can add a walk-in/phone inquiry; phone or email required');

  // ── list, search, CSV ──
  await page.click('header nav button[data-view=list]');
  await page.fill('#f-q', '555-0199');
  assert.equal(await page.locator('#rows tr[data-id]').count(), 1);
  assert.ok(await page.locator('#rows', { hasText: 'James Carter' }).count());
  await page.fill('#f-q', '');
  assert.equal(await page.locator('#rows tr[data-id]').count(), 5);
  ok('list search matches phone numbers in any format');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(csv, /parent_name/);
  assert.match(csv, /Maria Lopez/);
  assert.equal(csv.trim().split(/\r\n/).length, 6);
  ok('CSV export downloads the filtered rows');
  await shot(page, '05-list');

  // ── staff admin ──
  await page.click('header nav button[data-view=staff]');
  const newHire = page.locator('tr', { hasText: 'newhire@creativaacademy.com' });
  await newHire.locator('input[type=checkbox]').check();
  await page.waitForSelector('#toast:has-text("Saved")');
  assert.ok(await page.locator('tr', { hasText: 'owner@creativaacademy.com' }).locator('select').isDisabled());
  ok('admin activates a new staff member; cannot change own role');

  // ── tour calendar feed ──
  await page.waitForFunction(() => /tours_ics\?token=/.test(document.querySelector('#cal-url')?.value || ''));
  const feedUrl = await page.inputValue('#cal-url');
  const feed = await (await fetch(feedUrl)).text();
  assert.match(feed, /^BEGIN:VCALENDAR\r\n/);
  assert.match(feed, /SUMMARY:Tour: Maria Lopez/);
  assert.equal((feed.match(/BEGIN:VEVENT/g) || []).length, 1);   // Maria is the only family with a tour
  await page.click('#cal-reset');   // confirm() accepted by the dialog handler
  await page.waitForFunction((old) => document.querySelector('#cal-url').value !== old, feedUrl);
  assert.equal((await fetch(feedUrl)).status, 401);
  assert.match(await (await fetch(await page.inputValue('#cal-url'))).text(), /SUMMARY:Tour: Maria Lopez/);
  ok('Staff page gives a calendar link listing booked tours; Reset link kills the old one');
  await shot(page, '06-staff');

  // ── enrollment roster ──
  await page.click('header nav button[data-view=roster]');
  await page.locator('#roster-rows tr', { hasText: 'Test Kid Alpha' }).waitFor();
  assert.equal(await page.locator('#roster-rows tr[data-id]').count(), 2, 'enrolled students only by default');
  assert.equal((await page.locator('.class-card', { hasText: 'Early 3s' }).locator('.c-count').textContent()).trim(), '1');
  assert.ok(await page.locator('.class-card', { hasText: '18–23 months' }).locator('.tag', { hasText: '1 waiting' }).count());
  const alphaRow = page.locator('#roster-rows tr', { hasText: 'Test Kid Alpha' });
  assert.ok(await alphaRow.locator('input[data-doc=doc_registration]').isChecked());
  await alphaRow.locator('input[data-doc=doc_blue_form]').check();
  await page.waitForSelector('#toast:has-text("Blue form received")');
  assert.equal(await page.locator('.drawer').count(), 0, 'ticking a document must not open the student');
  ok('Enrollment: class counts, waiting list, tick a document from the list');

  await page.click('#r-add');
  await drawer.waitFor();
  await drawer.locator('input[name=name]').fill('Walk-in Kid');
  await drawer.locator('select[name=classroom_id]').selectOption({ label: 'Late 2s' });
  await drawer.locator('[data-doc=doc_birth_cert]').check();
  assert.match(await drawer.locator('input[name=doc_birth_cert]').inputValue(), /^\d{4}-\d{2}-\d{2}$/);
  await drawer.locator('#st-save').click();
  await page.waitForSelector('#toast:has-text("Walk-in Kid added")');
  await drawer.locator('[data-close]').first().click();
  await page.locator('#roster-rows tr', { hasText: 'Walk-in Kid' }).waitFor();
  await page.selectOption('#r-docs', 'missing');
  assert.equal(await page.locator('#roster-rows tr[data-id]').count(), 3);
  await page.selectOption('#r-docs', '');
  await page.selectOption('#r-funding', 'fes_ua');
  assert.equal(await page.locator('#roster-rows tr[data-id]').count(), 1);
  await page.selectOption('#r-funding', '');
  ok('add a student with documents; filter by missing documents and by funding');
  await shot(page, '10-enrollment');

  // ── student finance, payment, receipt ──
  await alphaRow.locator('td').first().click();
  await drawer.waitFor();
  assert.ok(await drawer.locator('input[name=fund_fes_ua]').isChecked());
  assert.equal(await drawer.locator('input[name=award_id]').inputValue(), 'TEST-123');
  assert.equal(await drawer.locator('input[data-doc=doc_blue_form]').isChecked(), true);
  await drawer.locator('#pay-add').click();
  await drawer.locator('input[name=amount]').waitFor();
  assert.equal(await drawer.locator('input[name=amount]').inputValue(), '560', 'amount suggests what is still due');
  await drawer.locator('input[name=amount]').fill('300');
  await drawer.locator('select[name=method]').selectOption('zelle');
  await drawer.locator('#pay-save-print').click();
  const sheet = page.locator('.print-sheet');
  await sheet.waitFor();
  assert.ok(await sheet.locator('.receipt', { hasText: 'TEST-123' }).count());
  assert.ok(await sheet.locator('.receipt', { hasText: '$300.00' }).count());
  assert.ok(await sheet.locator('.receipt', { hasText: '123 Test Street' }).count());
  assert.ok(await sheet.locator('.receipt', { hasText: 'Alpha Parent' }).count());
  await shot(page, '11-receipt');
  await sheet.locator('#rc-close').click();
  await drawer.locator('.pay-list li', { hasText: '$300.00' }).waitFor();
  await drawer.locator('[data-close]').first().click();
  ok('record a payment from the student page; receipt shows award ID, school header, amount');

  // ── tuition ──
  await page.click('header nav button[data-view=tuition]');
  const tRow = (name) => page.locator('#t-rows tr', { hasText: name });
  await tRow('Test Kid Alpha').locator('.pay-pill', { hasText: 'Partly paid' }).waitFor();
  await tRow('Test Kid Beta').locator('.pay-pill', { hasText: 'Not paid' }).waitFor();
  assert.ok(await tRow('Test Kid Beta').locator('td', { hasText: '$160.00' }).count(), 'biweekly tuition counts twice a month');
  assert.equal(await page.locator('.stat', { hasText: 'Still owed' }).locator('b').textContent(), '$420.00');
  assert.equal(await tRow('Walk-in Kid').locator('.pay-pill').textContent(), 'No tuition set');
  await tRow('Test Kid Beta').locator('[data-pay-for]').click();
  await drawer.locator('input[name=amount]').waitFor();
  await drawer.locator('select[name=payer]').selectOption('sr');
  await drawer.locator('#pay-save').click();
  await page.waitForSelector('#toast:has-text("Saved · receipt")');
  await tRow('Test Kid Beta').locator('.pay-pill', { hasText: /^Paid$/ }).waitFor();
  assert.equal(await page.locator('.stat', { hasText: 'Still owed' }).locator('b').textContent(), '$260.00');
  await page.click('#t-fes');
  await sheet.waitFor();
  assert.equal(await sheet.locator('.receipt').count(), 1, 'only FES-UA receipts');
  await sheet.locator('#rc-close').click();
  await shot(page, '12-tuition');
  ok('Tuition: who has paid, partial and unpaid, balances; record payment from the list; FES-UA receipts batch');

  // ── reports ──
  await page.click('header nav button[data-view=reports]');
  assert.equal(await page.locator('.stat', { hasText: 'Received in' }).locator('b').textContent(), '$460.00');
  assert.ok(await page.locator('.panel', { hasText: 'By who paid' }).locator('tr', { hasText: 'School Readiness' }).locator('td', { hasText: '$160.00' }).count());
  await page.locator('.fund-group summary', { hasText: 'FES-UA' }).click();
  assert.ok(await page.locator('.fund-group', { hasText: 'FES-UA' }).locator('li', { hasText: 'ID TEST-123' }).count());
  const [rdl] = await Promise.all([page.waitForEvent('download'), page.click('#rp-csv')]);
  assert.equal(fs.readFileSync(await rdl.path(), 'utf8').trim().split(/\r\n/).length, 3);
  await shot(page, '13-reports');
  ok('Reports: month total, by payer, funding lists with award IDs, payments CSV');

  // ── enrolled inquiry → enrollment list ──
  await page.click('header nav button[data-view=list]');
  await page.locator('#rows tr', { hasText: 'Maria Lopez' }).click();
  assert.ok(await drawer.locator('input[name=auto_emails]').isChecked());
  await drawer.locator('select[name=stage]').selectOption('enrolled');
  await drawer.locator('#save').click();
  await drawer.locator('#to-roster').click();
  await drawer.locator('#st-save').waitFor();
  assert.equal(await drawer.locator('input[name=name]').inputValue(), 'Sofia Lopez');
  assert.equal(await drawer.locator('select[name=classroom_id] option:checked').textContent(), 'Early 2s');
  await drawer.locator('#st-save').click();
  await page.waitForSelector('#toast:has-text("Sofia Lopez added")');
  await drawer.locator('#open-inq').click();
  await drawer.locator('#open-student', { hasText: 'Sofia Lopez' }).waitFor();
  await drawer.locator('[data-close]').first().click();
  ok('an Enrolled inquiry becomes a student in one tap, linked both ways');

  // ── settings ──
  await page.click('header nav button[data-view=staff]');
  await page.locator('.class-table tr', { has: page.locator('input[value="Early 3s"]') }).locator('input[data-k=capacity]').fill('12');
  await page.locator('.class-table tr', { has: page.locator('input[value="Early 3s"]') }).locator('input[data-k=capacity]').press('Tab');
  await page.waitForSelector('#toast:has-text("Saved")');
  await page.locator('#set-emails input[name=tour_reminder_subject]').fill('See you tomorrow!');
  await page.locator('#set-emails button[type=submit]').click();
  await page.waitForSelector('#toast:has-text("Saved")');
  await page.locator('tr', { hasText: 'teacher@creativaacademy.com' }).locator('select[data-k=finance]').selectOption('view');
  await page.waitForSelector('#toast:has-text("Saved")');
  await page.click('header nav button[data-view=roster]');
  assert.equal((await page.locator('.class-card', { hasText: 'Early 3s' }).locator('.c-count').textContent()).trim(), '1 / 12');
  ok('Settings: class capacity, email wording and finance access save');

  // ── activated staff, as a non-admin ──
  const p2 = await newPage();
  await login(p2, 'newhire@creativaacademy.com', 'newhire-pass-1');
  await p2.waitForSelector('header.top');
  assert.equal(await p2.locator('header nav button[data-view=staff]').count(), 0);
  await p2.click('header nav button[data-view=list]');
  await p2.locator('#rows tr', { hasText: 'Maria Lopez' }).click();
  assert.equal(await p2.locator('.drawer #del').count(), 0);
  ok('activated staff gets in; no Staff tab and no Delete for non-admins');
  await p2.locator('.drawer [data-close]').first().click();
  assert.equal(await p2.locator('header nav button[data-view=tuition]').count(), 0);
  assert.equal(await p2.locator('header nav button[data-view=reports]').count(), 0);
  await p2.click('header nav button[data-view=roster]');
  await p2.locator('#roster-rows tr', { hasText: 'Test Kid Alpha' }).locator('td').first().click();
  await p2.locator('.drawer input[name=name]').waitFor();
  assert.equal(await p2.locator('.drawer input[name=award_id]').count(), 0);
  assert.equal(await p2.locator('#roster-rows').locator('.tag', { hasText: 'FES-UA' }).count(), 0);
  ok('staff without finance access: roster and documents yes, no tuition, payments or award IDs');

  const p3 = await newPage();
  await login(p3, 'teacher@creativaacademy.com', 'teacher-pass-1');
  await p3.click('header nav button[data-view=tuition]');
  await p3.locator('#t-rows tr', { hasText: 'Test Kid Alpha' }).waitFor();
  assert.equal(await p3.locator('#t-add').count(), 0);
  assert.equal(await p3.locator('[data-pay-for]').count(), 0);
  ok('view-only finance: sees Tuition, cannot record payments');

  // ── phone ──
  const m = await newPage({ width: 390, height: 844 }, true);
  await login(m, 'owner@creativaacademy.com', 'owner-pass-1');
  await m.waitForSelector('header.top');
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px on a phone`);
  const headerH = await m.evaluate(() => document.querySelector('header.top').getBoundingClientRect().height);
  assert.ok(headerH <= 110, `phone header is ${headerH}px tall`);
  assert.equal(await m.evaluate(() => getComputedStyle(document.querySelector('header.top')).position), 'static');
  const tabsInOneRow = await m.evaluate(() => new Set([...document.querySelectorAll('header nav button')].map((b) => Math.round(b.getBoundingClientRect().top))).size);
  assert.equal(tabsInOneRow, 1);
  await shot(m, '07-mobile-today');
  await m.click('header nav button[data-view=roster]');
  await m.locator('#roster-rows tr', { hasText: 'Test Kid Alpha' }).waitFor();
  const rosterOverflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(rosterOverflow <= 0, `Enrollment scrolls sideways by ${rosterOverflow}px on a phone`);
  await shot(m, '14-mobile-enrollment');
  await m.click('header nav button[data-view=today]');
  ok(`phone: compact header (${Math.round(headerH)}px, tabs in one row, scrolls away), no sideways scroll`);

  await m.click('header nav button[data-view=board]');
  const mcol = (st) => m.locator(`.col[data-stage=${st}]`);
  const walkIn = mcol('new').locator('.card', { hasText: 'Walk-in Dad' });
  await walkIn.locator('.move').waitFor({ state: 'visible' });
  await shot(m, '09-mobile-pipeline');
  await walkIn.locator('.move').selectOption('contacted');
  await mcol('contacted').locator('.card', { hasText: 'Walk-in Dad' }).waitFor();
  assert.equal(await m.locator('.drawer').count(), 0, 'picking a stage must not open the family');
  ok('phone: "Move to…" on a card changes its stage without opening the family');

  await mcol('contacted').locator('.card', { hasText: 'Walk-in Dad' }).locator('.name').click();
  await m.locator('.drawer').waitFor();
  await shot(m, '08-mobile-drawer');
  ok('phone: tapping a card still opens the family');

  assert.deepEqual(errors, [], 'page errors: ' + errors.join('; '));
  ok('no JavaScript errors or Content-Security-Policy violations');
  console.log(`\nALL ${step} E2E CHECKS PASSED — screenshots in ${SHOTS}`);
} catch (e) {
  console.error('\nE2E FAILED at step', step + 1, '\n', e);
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
