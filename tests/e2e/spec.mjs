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

  // ── tours to reschedule ──
  await page.click('#add');
  await drawer.waitFor();
  await drawer.locator('input[name=parent_name]').fill('Resched Mom');
  await drawer.locator('input[name=phone]').fill('305 555 0404');
  await drawer.locator('select[name=stage]').selectOption('tour_scheduled');
  await drawer.locator('input[name=tour_at]').fill(tourLocal);
  await drawer.locator('#save').click();
  await drawer.locator('.timeline li', { hasText: 'Added by staff' }).waitFor();
  await drawer.locator('[data-close]').first().click();
  await col('tour_scheduled').locator('.card', { hasText: 'Resched Mom' }).dragTo(col('reschedule'));
  await col('reschedule').locator('.card', { hasText: 'Resched Mom' }).locator('.tag', { hasText: /^was / }).waitFor();
  await page.click('header nav button[data-view=today]');
  await page.locator('#resched-panel .row', { hasText: 'Resched Mom' }).waitFor();
  assert.ok(await page.locator('#resched-panel .row', { hasText: 'Resched Mom' }).locator('a[href="sms:3055550404"]').count());
  assert.equal(await page.locator('.panel', { hasText: 'Upcoming tours' }).locator('.row', { hasText: 'Resched Mom' }).count(), 0);
  await shot(page, '15-reschedule-today');
  await page.click('header nav button[data-view=board]');
  await col('reschedule').locator('.card', { hasText: 'Resched Mom' }).dragTo(col('tour_scheduled'));
  await drawer.waitFor();
  assert.equal(await drawer.locator('input[name=tour_at]').inputValue(), '', 'moving back asks for a new time');
  await drawer.locator('#save').click();
  await page.waitForSelector('#toast.err:has-text("Pick the new tour date and time")');
  await drawer.locator('input[name=tour_at]').fill(tourLocal.replace('T10:30', 'T09:00'));
  await drawer.locator('#save').click();
  await drawer.locator('.timeline li.k-stage', { hasText: 'Reschedule → Tour scheduled' }).waitFor();
  await drawer.locator('[data-close]').first().click();
  await col('tour_scheduled').locator('.card', { hasText: 'Resched Mom' }).waitFor();
  // From the Today list: typing the new time while still at Reschedule books the tour again.
  await col('tour_scheduled').locator('.card', { hasText: 'Resched Mom' }).dragTo(col('reschedule'));
  await col('reschedule').locator('.card', { hasText: 'Resched Mom' }).waitFor();
  await page.click('header nav button[data-view=today]');
  await page.locator('#resched-panel .row', { hasText: 'Resched Mom' }).locator('.who').click();
  await drawer.waitFor();
  await drawer.locator('input[name=tour_at]').fill(tourLocal.replace('T10:30', 'T09:30'));
  await drawer.locator('#save').click();
  await drawer.locator('.timeline li.k-stage', { hasText: 'Reschedule → Tour scheduled' }).nth(1).waitFor();
  assert.equal(await drawer.locator('select[name=stage]').inputValue(), 'tour_scheduled');
  await drawer.locator('[data-close]').first().click();
  await page.locator('.panel', { hasText: 'Upcoming tours' }).locator('.row', { hasText: 'Resched Mom' }).waitFor();
  assert.equal(await page.locator('#resched-panel .row', { hasText: 'Resched Mom' }).count(), 0);
  await page.click('header nav button[data-view=board]');
  ok('Reschedule: tours to move get their own column and Today list; a new time (board or drawer) books them again');

  // ── list, search, CSV ──
  await page.click('header nav button[data-view=list]');
  await page.fill('#f-q', '555-0199');
  assert.equal(await page.locator('#rows tr[data-id]').count(), 1);
  assert.ok(await page.locator('#rows', { hasText: 'James Carter' }).count());
  await page.fill('#f-q', '');
  assert.equal(await page.locator('#rows tr[data-id]').count(), 6);
  ok('list search matches phone numbers in any format');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(csv, /parent_name/);
  assert.match(csv, /Maria Lopez/);
  assert.equal(csv.trim().split(/\r\n/).length, 7);
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
  assert.match(feed, /SUMMARY:Tour: Resched Mom/);   // rescheduled: back on the calendar
  assert.equal((feed.match(/BEGIN:VEVENT/g) || []).length, 2);   // Maria and Resched Mom are the families with tours
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
  await page.click('#r-add');
  await drawer.locator('input[name=name]').fill('Grad Kid');
  await drawer.locator('select[name=status]').selectOption('graduated');
  await drawer.locator('input[name=withdrawn_on]').waitFor({ state: 'visible' });
  assert.match(await drawer.locator('input[name=withdrawn_on]').inputValue(), /^\d{4}-\d{2}-\d{2}$/, 'last day defaults to today');
  await drawer.locator('#st-save').click();
  await page.waitForSelector('#toast:has-text("Grad Kid added")');
  await drawer.locator('[data-close]').first().click();
  await page.selectOption('#r-status', 'graduated');
  await page.locator('#roster-rows tr', { hasText: 'Grad Kid' }).locator('.stage-pill', { hasText: 'Graduated' }).waitFor();
  await page.selectOption('#r-status', 'enrolled');
  ok('a child can be marked Graduated (with their last day at school), like Withdrawn');
  assert.ok(await page.locator('#roster-rows tr', { hasText: 'Walk-in Kid' }).locator('.tag.f-private', { hasText: 'Private pay' }).count());
  await page.selectOption('#r-funding', 'private');
  assert.deepEqual((await page.locator('#roster-rows tr[data-id] td:first-child b').allTextContents()).sort(), ['Walk-in Kid']);
  await page.selectOption('#r-funding', '');
  await page.locator('#roster-rows tr', { hasText: 'Test Kid Beta' }).locator('td').first().click();
  await drawer.locator('input[name=fund_sr_bpiece]').check();
  assert.ok(await drawer.locator('input[name=fund_sr]').isChecked(), 'BPIECE ticks School Readiness too');
  await drawer.locator('#st-save').click();
  await page.waitForSelector('#toast:has-text("Saved")');
  await drawer.locator('[data-close]').first().click();
  assert.ok(await page.locator('#roster-rows tr', { hasText: 'Test Kid Beta' }).locator('.tag', { hasText: 'SR – BPIECE' }).count());
  ok('no program = Private pay; BPIECE students are also School Readiness');
  await shot(page, '10-enrollment');

  // ── student finance and contacts ──
  await alphaRow.locator('td').first().click();
  await drawer.waitFor();
  assert.ok(await drawer.locator('input[name=fund_fes_ua]').isChecked());
  assert.equal(await drawer.locator('input[name=award_id]').inputValue(), 'TEST-123');
  assert.equal(await drawer.locator('input[name=billing_program]').inputValue(), 'Preschool Full-Time');
  assert.equal(await drawer.locator('input[data-doc=doc_blue_form]').isChecked(), true);
  await drawer.locator('.contact-list li', { hasText: 'Alpha Parent' }).locator('a[href="tel:3055550101"]').waitFor();
  await drawer.locator('#contact-add').click();
  await drawer.locator('select[name=role]').selectOption('secondary');
  await drawer.locator('input[name=relationship]').fill('Father');
  await drawer.locator('input[name=first_name]').fill('Beto');
  await drawer.locator('input[name=last_name]').fill('Alpha');
  await drawer.locator('input[name=cell_phone]').fill('(786) 555-0102');
  await drawer.locator('#ct-save').click();
  await page.waitForSelector('#toast:has-text("Contact saved")');
  await drawer.locator('.contact-list li', { hasText: 'Beto Alpha' }).locator('a[href="sms:7865550102"]').waitFor();
  await drawer.locator('.pay-list li', { hasText: 'No invoices yet' }).waitFor();
  await drawer.locator('[data-close]').first().click();
  ok('student page: funding, billing item, every contact (add a father) with call and text links');

  // ── tuition: bill the period, record payments, credits ──
  await page.click('header nav button[data-view=tuition]');
  const tRow = (name) => page.locator('#t-rows tr', { hasText: name });
  await tRow('Test Kid Alpha').locator('.pay-pill', { hasText: 'Not billed yet' }).waitFor();
  assert.equal(await tRow('Walk-in Kid').locator('.pay-pill').textContent(), 'No rate set');
  await page.click('#t-bill');   // confirm() accepted
  await page.waitForSelector('#toast:has-text("2 invoices created")');
  await tRow('Test Kid Alpha').locator('.pay-pill', { hasText: /^(Open|Late)$/ }).waitFor();   // Late once the Friday grace has passed
  assert.ok(await tRow('Test Kid Beta').locator('td.num', { hasText: '$80.00' }).count(), 'biweekly rate billed once per period');
  assert.equal(await page.locator('.stat', { hasText: 'Billed this period' }).locator('b').textContent(), '$640.00');
  assert.equal(await page.locator('#t-bill').count(), 0, 'nothing left to bill');

  await tRow('Test Kid Alpha').locator('[data-pay-inv]').click();
  await drawer.locator('select[name=invoice_id]').waitFor();
  assert.equal(await drawer.locator('input[name=amount]').inputValue(), '560', 'amount suggests the invoice balance');
  await drawer.locator('input[name=amount]').fill('300');
  await drawer.locator('select[name=method]').selectOption('zelle');
  await drawer.locator('#pay-save-print').click();
  const sheet = page.locator('.print-sheet');
  await sheet.waitFor();
  assert.ok(await sheet.locator('.receipt', { hasText: 'TEST-123' }).count());
  assert.ok(await sheet.locator('.receipt', { hasText: '$300.00' }).count());
  assert.ok(await sheet.locator('.receipt', { hasText: 'Alpha Parent' }).count());
  assert.match(await sheet.locator('.receipt .r-table').nth(1).textContent(), /Tuition \(Preschool Full-Time\) — \w+ \d+ – \w+ \d+, \d{4}/);
  assert.match(await sheet.locator('.receipt .r-year').textContent(), /^School year \d{4} – \d{4}$/);
  assert.match(await sheet.locator('.receipt .r-box').textContent(), /FES-UA \(Unique Abilities\)[\s\S]*TEST-123/);
  assert.match(await sheet.locator('.receipt .r-foot').textContent(), /123 Test Street/);
  assert.equal((await sheet.locator('.receipt .r-license').textContent()).trim(), 'License No. C11MD1517');
  await shot(page, '11-receipt');
  await page.pdf({ path: path.join(SHOTS, '11-receipt-print.pdf'), format: 'Letter', printBackground: true });   // what Print / Save as PDF gives
  await sheet.locator('#rc-close').click();
  await tRow('Test Kid Alpha').locator('.pay-pill', { hasText: 'Partly paid' }).waitFor();
  assert.ok(await tRow('Test Kid Alpha').locator('td.num', { hasText: '$260.00' }).count());
  ok('Tuition: bill the period in one tap; a payment pays its invoice; receipt names the billing period');

  await page.click('#t-add');
  await drawer.locator('select[name=student_id]').selectOption({ label: 'Test Kid Beta · VPK' });
  await drawer.locator('select[name=invoice_id]').selectOption('');
  await drawer.locator('input[name=amount]').fill('50');
  await drawer.locator('#pay-save').click();
  await page.waitForSelector('#toast:has-text("Saved · receipt")');
  await page.locator('#t-credits tr', { hasText: 'Test Kid Beta' }).waitFor();
  assert.ok((await page.locator('.stat', { hasText: 'Owed, all periods' }).locator('span').textContent()).includes('$50.00 credits'));
  await page.locator('#t-credits tr', { hasText: 'Test Kid Beta' }).locator('[data-apply]').click();
  await drawer.locator('select[name=invoice_id]').selectOption({ index: 1 });
  await drawer.locator('#pay-save').click();
  await tRow('Test Kid Beta').locator('.pay-pill', { hasText: 'Partly paid' }).waitFor();
  assert.equal(await page.locator('#t-credits tr[data-pay]').count(), 0, 'credit applied');
  await tRow('Test Kid Beta').locator('[data-pay-inv]').click();
  assert.equal(await drawer.locator('input[name=amount]').inputValue(), '30');
  await drawer.locator('select[name=payer]').selectOption('sr');
  await drawer.locator('#pay-save').click();
  await tRow('Test Kid Beta').locator('.pay-pill', { hasText: /^Paid$/ }).waitFor();
  assert.equal(await page.locator('.stat', { hasText: 'Still owed this period' }).locator('b').textContent(), '$260.00');
  await page.locator('#t-open tr', { hasText: 'Test Kid Alpha' }).waitFor();
  assert.equal(await page.locator('#t-open tr[data-inv]').count(), 1, 'only Alpha still owes');
  await page.click('#t-fes');
  await sheet.waitFor();
  assert.equal(await sheet.locator('.receipt').count(), 1, 'only FES-UA family receipts');
  await sheet.locator('#rc-close').click();
  await page.click('#p-next');
  await tRow('Test Kid Alpha').locator('.pay-pill', { hasText: 'Not billed yet' }).waitFor();
  await page.click('#p-now');
  // Periods before the CRM's first billing Monday (Oct 5) show the billing system's sheet, with nothing to bill.
  for (let i = 0; i < 40 && !(await page.locator('.month-bar b', { hasText: 'Aug 10 – Aug 21' }).count()); i++) await page.click('#p-prev');
  await page.locator('.month-bar', { hasText: 'billed and paid in the billing system' }).waitFor();
  assert.equal(await page.locator('#t-bill, [data-bill-one], [data-pay-inv], [data-pay-for], #t-late').count(), 0, 'nothing to bill or collect before the CRM');
  await page.click('#t-fes');   // FES-UA receipts for an old period: what the family paid through the billing system
  await page.locator('.print-sheet .receipt').first().waitFor();
  assert.equal(await page.locator('.print-sheet .receipt').count(), 1);
  assert.match(await page.locator('.print-sheet .receipt').textContent(), /Paid through the billing system[\s\S]*Test Kid Alpha[\s\S]*Tuition — Aug 10 – August 21, 2026[\s\S]*Billing system[\s\S]*\$560\.00[\s\S]*FES-UA/);
  await page.locator('#rc-close').click();
  assert.deepEqual(await page.locator('table.tuition thead th').allTextContents(), ['Student', 'Funding', 'Rate', 'Billed', 'Paid', 'Balance', 'Status', ''],
    'same columns as a CRM period');
  assert.match(await tRow('Test Kid Alpha').textContent(), /FES-UA[\s\S]*\$560\.00[\s\S]*\$560\.00[\s\S]*\$560\.00[\s\S]*Paid/, 'rate, billed, paid, Paid');
  assert.match(await tRow('Test Kid Beta').textContent(), /Not on the sheet/);
  assert.equal(await page.locator('.stat', { hasText: 'Billed this period' }).locator('b').textContent(), '$560.00');
  assert.equal(await page.locator('.stat', { hasText: 'Still owed this period' }).locator('b').textContent(), '$0.00');
  assert.match(await page.locator('#t-gone tr', { hasText: 'GONE, KID' }).textContent(), /\$100\.00[\s\S]*Paid/);
  assert.ok(await page.locator('#p-prev').isDisabled(), 'no earlier sheets');
  await shot(page, '12b-tuition-aug-10');
  await page.click('#p-next');   // Aug 24 – Sep 4: a credit on the sheet, paid amount still to check
  assert.match(await tRow('Test Kid Alpha').textContent(), /\$520\.00[\s\S]*Check amount[\s\S]*sheet -\$40\.00/);
  await page.click('#p-now');
  await tRow('Test Kid Alpha').waitFor();
  assert.equal(await page.locator('#week-box .wb-week').count(), 4, 'this week and the three after it');
  assert.match(await page.locator('#week-box .wb-split').textContent(), /FES \/ Step Up \$280[\s\S]*School Readiness families’ share \$40/,
    'a two-week rate is half a week; by who pays');
  await shot(page, '12-tuition');
  ok('credits: keep a payment as a credit, apply it to an invoice; owed list; FES-UA receipts; next period; Aug–Sep periods show the old sheets');

  // ── late fee: tuition still unpaid after the Friday grace day ──
  {
    const t = new Date();
    const sinceMonday = ((Math.round((Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) - Date.UTC(2026, 9, 5)) / 864e5) % 14) + 14) % 14;
    if (sinceMonday > 4) {
      await page.click('#t-late');   // confirm() accepted
      await page.waitForSelector('#toast:has-text("1 late fee added")');
      const feeRow = page.locator('#t-open tr', { hasText: 'Late fee' });
      assert.match(await feeRow.textContent(), /Test Kid Alpha[\s\S]*\$30\.00/);
      await tRow('Test Kid Alpha').locator('text=+ $30.00 late fee').waitFor();
      assert.equal(await page.locator('#t-late').count(), 0, 'no second late fee');
      assert.equal(await feeRow.locator('[data-waive]').textContent(), 'Take off');
      await tRow('Test Kid Alpha').locator('[data-rm-fee]').click();   // added by mistake: take it off (confirm() accepted)
      await page.waitForSelector('#toast:has-text("Late fee taken off")');
      assert.equal(await page.locator('#t-open tr', { hasText: 'Late fee' }).count(), 0);
      assert.equal(await tRow('Test Kid Alpha').locator('text=late fee').count(), 0);
      assert.equal(await page.locator('#t-late').count(), 0, 'a fee taken off stays off');
      ok('late fee: $30 on tuition unpaid after Friday, shown on the child, taken off in one tap');
    } else {
      assert.equal(await page.locator('#t-late').count(), 0, 'no late fees before Friday has passed');
      ok('late fee: none offered while the period is in its grace days');
    }
  }

  // ── reports ──
  await page.click('header nav button[data-view=reports]');
  assert.equal(await page.locator('.stat', { hasText: 'Received in' }).locator('b').textContent(), '$380.00');
  assert.equal(await page.locator('.stat', { hasText: 'Billed in the month' }).locator('b').textContent(), '$640.00');
  assert.ok(await page.locator('.panel', { hasText: 'By who paid' }).locator('tr', { hasText: 'School Readiness' }).locator('td', { hasText: '$30.00' }).count());
  await page.locator('.fund-group summary', { hasText: 'FES-UA' }).click();
  assert.ok(await page.locator('.fund-group', { hasText: 'FES-UA' }).locator('li', { hasText: 'ID TEST-123' }).count());
  const [rdl] = await Promise.all([page.waitForEvent('download'), page.click('#rp-csv')]);
  assert.equal(fs.readFileSync(await rdl.path(), 'utf8').trim().split(/\r\n/).length, 4);
  await shot(page, '13-reports');
  ok('Reports: received and billed in the month, by payer, funding lists with award IDs, payments CSV');
  const whoPaid = page.locator('#who-paid');
  assert.match(await whoPaid.locator('[data-method=zelle]').textContent(), /Zelle \$300\.00 · 1[\s\S]*Test Kid Alpha[\s\S]*\$300\.00/);
  assert.equal(await whoPaid.locator('[data-method=cash] li').count(), 2, 'cash: the family and School Readiness');
  assert.match(await whoPaid.locator('[data-method=card]').textContent(), /None/);
  ok('Reports: who paid by cash, Zelle and card this month, by name');
  await page.locator('#hist-panel summary').click();
  const histAlpha = page.locator('#hist-rows tr', { hasText: 'ALPHA, TEST' });
  assert.deepEqual((await histAlpha.locator('td.num').allTextContents()).map((x) => x.trim()), ['$560.00', '-$40.00 *']);
  assert.ok(await page.locator('#hist-rows tr', { hasText: 'GONE, KID' }).locator('text=(not in the CRM)').count());
  assert.deepEqual((await page.locator('#hist-panel tfoot th.num').allTextContents()).map((x) => x.trim()), ['$660.00', '-$40.00']);
  await histAlpha.click();
  await page.locator('.drawer .section', { hasText: 'Earlier billing (billing system, paid)' }).locator('li', { hasText: 'paid early' }).waitFor();
  await page.locator('.drawer [data-close]').first().click();
  ok('Reports: the billing system’s balance sheets by family and date, totals; shown on the child’s page');

  // ── enrolled inquiry → enrollment list ──
  await page.click('header nav button[data-view=list]');
  await page.locator('#rows tr', { hasText: 'Maria Lopez' }).click();
  assert.ok(await drawer.locator('input[name=auto_emails]').isChecked());
  const nextMonth1 = (() => { const [y, mo] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).split('-').map(Number);
    return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`; })();
  await drawer.locator('input[name=start_on]').fill(nextMonth1);
  await drawer.locator('input[name=expected_tuition]').fill('600');
  await drawer.locator('select[name=stage]').selectOption('enrolled');
  await drawer.locator('#save').click();
  await drawer.locator('#to-roster').click();
  await drawer.locator('#st-save').waitFor();
  assert.equal(await drawer.locator('input[name=name]').inputValue(), 'Sofia Lopez');
  assert.equal(await drawer.locator('select[name=classroom_id] option:checked').textContent(), 'Early 2s');
  assert.equal(await drawer.locator('input[name=start_date]').inputValue(), nextMonth1, 'the start day carries over');
  assert.equal(await drawer.locator('input[name=tuition_amount]').inputValue(), '600', 'and the tuition');
  await drawer.locator('#st-save').click();
  await page.waitForSelector('#toast:has-text("Sofia Lopez added")');
  await drawer.locator('#open-inq').click();
  await drawer.locator('#open-student', { hasText: 'Sofia Lopez' }).waitFor();
  await drawer.locator('[data-close]').first().click();
  ok('an Enrolled inquiry becomes a student in one tap, linked both ways, with its start day and tuition');

  // ── settings ──
  await page.click('header nav button[data-view=staff]');
  await page.locator('.class-table tr', { has: page.locator('input[value="Early 3s"]') }).locator('input[data-k=capacity]').fill('12');
  await page.locator('.class-table tr', { has: page.locator('input[value="Early 3s"]') }).locator('input[data-k=capacity]').press('Tab');
  await page.waitForSelector('#toast:has-text("Saved")');
  await page.locator('#set-emails input[name=tour_reminder_subject]').fill('See you tomorrow!');
  await page.locator('#set-emails button[type=submit]').click();
  await page.waitForSelector('#toast:has-text("Saved")');
  assert.equal(await page.locator('#set-texts input[name=texts_enabled]').isChecked(), false, 'texts start off');
  await page.locator('#set-texts input[name=texts_enabled]').check();
  await page.locator('#set-texts textarea[name=tour_reminder_text]').fill('Creativa: tour tomorrow at {tour_time}. Reply STOP to opt out.');
  const savedTexts = page.waitForResponse((r) => r.url().includes('/settings') && r.request().method() === 'PATCH');
  await page.locator('#set-texts button[type=submit]').click();
  assert.equal((await savedTexts).status(), 200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.click('header nav button[data-view=staff]');
  assert.equal(await page.locator('#set-texts input[name=texts_enabled]').isChecked(), true);
  assert.equal(await page.locator('#set-texts textarea[name=tour_reminder_text]').inputValue(), 'Creativa: tour tomorrow at {tour_time}. Reply STOP to opt out.');
  ok('Settings: automatic texts switch on and their wording saves');
  await page.locator('tr', { hasText: 'teacher@creativaacademy.com' }).locator('select[data-k=finance]').selectOption('view');
  await page.waitForSelector('#toast:has-text("Saved")');
  await page.click('header nav button[data-view=roster]');
  assert.equal((await page.locator('.class-card', { hasText: 'Early 3s' }).locator('.c-count').textContent()).trim(), '1 / 12');
  ok('Settings: class capacity, email wording and finance access save');

  // ── receipts: license number and signature ──
  await page.click('header nav button[data-view=staff]');
  assert.equal(await page.locator('#set-receipt input[name=receipt_license]').inputValue(), 'C11MD1517');
  const payrollAccess = page.locator('tr', { hasText: 'teacher@creativaacademy.com' }).locator('select[data-k=payroll]');
  assert.equal(await payrollAccess.inputValue(), 'no');
  const savedAccess = page.waitForResponse((r) => r.url().includes('/profiles') && r.request().method() === 'PATCH');
  await payrollAccess.selectOption('yes');
  assert.equal((await savedAccess).request().postDataJSON().payroll, true, 'Payroll: Yes saves as true');
  await payrollAccess.selectOption('no');
  await page.waitForSelector('#toast:has-text("Saved")');
  const sigPng = await page.locator('.settings-panel h2', { hasText: 'Receipts' }).screenshot();   // any dark-on-light picture
  await page.locator('#sig-file').setInputFiles({ name: 'signature.png', mimeType: 'image/png', buffer: sigPng });
  await page.waitForSelector('#toast:has-text("Signature saved")');
  assert.match(await page.locator('#sig-box .sig-preview img').getAttribute('src'), /^data:image\/png;base64,/);
  await page.click('header nav button[data-view=tuition]');
  await page.locator('[data-receipt]').first().click();
  await page.locator('.print-sheet .receipt .r-sig').waitFor();
  assert.ok(await page.locator('.print-sheet .r-sig').evaluate((img) => img.complete && img.naturalWidth > 0), 'the signature shows on the receipt');
  await shot(page, '17-receipt-signature');
  await page.pdf({ path: path.join(SHOTS, '17-receipt-signature.pdf'), format: 'Letter', printBackground: true });
  await page.locator('#rc-close').click();
  ok('Receipts: license number and the uploaded signature print on every receipt');

  // ── annual statements for taxes ──
  await page.click('header nav button[data-view=staff]');
  await page.locator('#set-receipt input[name=receipt_tax_id]').fill('12-3456789');
  await page.locator('#set-receipt button[type=submit]').click();
  await page.waitForSelector('#toast:has-text("Saved")');
  await page.click('header nav button[data-view=reports]');
  const stmtRows = page.locator('#stmt-rows tr');
  await stmtRows.first().waitFor();
  assert.match(await stmtRows.filter({ hasText: 'Alpha Parent' }).textContent(), /Check Aug–Sep[\s\S]*Test Kid Alpha[\s\S]*\$1,380\.00/, 'Oct $300 + Aug–Sep $560 + $520 (guess)');
  const check = page.locator('#hist-check .hc-fam', { hasText: 'ALPHA, TEST' });
  await check.locator('input[data-hid]').nth(1).fill('500');
  await check.locator('[data-hc-save]').click();
  await page.waitForSelector('#toast:has-text("ALPHA, TEST confirmed")');
  assert.equal(await page.locator('#hist-check').count(), 0, 'nothing left to check');
  assert.match(await stmtRows.filter({ hasText: 'Alpha Parent' }).textContent(), /\$1,360\.00/);
  assert.equal(await stmtRows.filter({ hasText: 'Alpha Parent' }).locator('.pay-pill').count(), 0);
  assert.match(await stmtRows.filter({ hasText: 'Test Kid Beta' }).textContent(), /\$50\.00/, 'program (School Readiness) payments left out');
  await stmtRows.filter({ hasText: 'Alpha Parent' }).locator('[data-print]').click();
  const stmt = page.locator('.print-sheet .statement');
  await stmt.waitFor();
  const stmtText = await stmt.textContent();
  for (const want of ['Annual Statement', 'Tax ID (EIN)', '12-3456789', 'License No. C11MD1517', 'Test Kid Alpha', 'Total paid in', '$300.00', 'Zelle',
    'Billing system', 'previous billing system', '$560.00', '$500.00', '$1,360.00']) {
    assert.ok(stmtText.includes(want), `statement shows ${want}`);
  }
  assert.ok(await stmt.locator('.r-sig').count(), 'statement is signed');
  await shot(page, '26-annual-statement');
  await page.pdf({ path: path.join(SHOTS, '26-annual-statement.pdf'), format: 'Letter', printBackground: true });
  await page.locator('#rc-close').click();
  await page.click('header nav button[data-view=tuition]');
  await page.click('header nav button[data-view=staff]');
  ok('Annual statements: from August (old billing system periods, checked amounts), tax ID, programs left out, signed, printable');

  // ── Telegram alerts ──
  await page.click('header nav button[data-view=staff]');
  const tg = page.locator('#tg-panel');
  await tg.locator('input[name=token]').fill('my bot token');
  await tg.locator('#tg-token button[type=submit]').click();
  await page.waitForSelector('#toast.err:has-text("not a Telegram bot token")');
  await tg.locator('input[name=token]').fill('123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await tg.locator('#tg-token button[type=submit]').click();
  await page.waitForSelector('#toast:has-text("Token saved")');
  await page.locator('#tg-panel #tg-find:not([disabled])').click();
  await page.locator('#tg-chats option', { hasText: 'Creativa front desk' }).waitFor({ state: 'attached' });
  await page.selectOption('#tg-chats', '555111222');
  assert.equal(await page.inputValue('#tg-chat input[name=telegram_chat_id]'), '555111222');
  await page.locator('#tg-chat input[name=tgf_contact]').uncheck();
  await page.locator('#tg-chat button[type=submit]').click();
  await page.waitForSelector('#toast:has-text("Saved")');
  await page.locator('#tg-panel .tg-status', { hasText: 'Connected to chat 555111222' }).waitFor();
  await page.locator('#tg-panel #tg-test').click();
  await page.waitForSelector('#toast:has-text("Test message sent")');
  assert.equal(await page.locator('#tg-chat input[name=tgf_contact]').isChecked(), false);
  ok('Telegram: save a bot token, find the chat, choose forms, send a test');

  // ── spam: mark as spam blocks the sender ──
  const anonRpc = (form, data) => fetch(`${BASE}/rest/v1/rpc/submit_inquiry`, { method: 'POST',
    headers: { 'content-type': 'application/json', apikey: 'anon-test-key', authorization: 'Bearer anon-test-key' },
    body: JSON.stringify({ p_form: form, p_data: data }) });
  assert.equal((await anonRpc('contact', { 'first-name': 'Prank', 'last-name': 'Caller', email: 'prank@example.com', phone: '305 555 0666', message: 'lol' })).status, 204);
  await page.reload();
  await page.click('header nav button[data-view=list]');
  await page.locator('#rows tr', { hasText: 'Prank Caller' }).click();
  await drawer.locator('#spam').click();
  await page.waitForSelector('#toast:has-text("Marked as spam")');
  assert.equal(await page.locator('#rows tr', { hasText: 'Prank Caller' }).count(), 0);
  await anonRpc('contact', { 'first-name': 'Prank', 'last-name': 'Again', email: 'PRANK@example.com', message: 'lol' });
  await anonRpc('waitlist', { parent_name: 'Prank Three', phone: '(305) 555-0666' });
  await page.reload();
  await page.click('header nav button[data-view=list]');
  await page.fill('#f-q', 'Prank');
  assert.equal(await page.locator('#rows tr[data-id]').count(), 0, 'blocked email and phone cannot send again');
  await page.fill('#f-q', '');
  await page.click('header nav button[data-view=staff]');
  const spam = page.locator('#spam-panel');
  await spam.locator('#block-rows tr', { hasText: 'prank@example.com' }).waitFor();
  assert.ok(await spam.locator('#block-rows tr', { hasText: '3055550666' }).count());
  await spam.locator('#spam-stats', { hasText: 'From a blocked sender 2' }).waitFor();
  assert.match(await spam.locator('#ts-status').textContent(), /Robot check is off/);
  await spam.locator('#block-add select[name=kind]').selectOption('phone');
  await spam.locator('#block-add input[name=value]').fill('+1 (786) 555-0000');
  await spam.locator('#block-add button[type=submit]').click();
  await spam.locator('#block-rows tr', { hasText: '7865550000' }).waitFor();
  await spam.locator('#block-rows tr', { hasText: 'prank@example.com' }).locator('[data-unblock]').click();
  await page.waitForSelector('#toast:has-text("Unblocked")');
  await spam.locator('#block-rows tr', { hasText: 'prank@example.com' }).waitFor({ state: 'detached' });
  await shot(page, '16-settings-telegram-spam');
  ok('Spam: one tap deletes and blocks email + phone; blocked senders are refused; Settings lists, adds and unblocks');

  // ── payroll: staff and PINs ──
  const pr = await newPage();
  await login(pr, 'owner@creativaacademy.com', 'owner-pass-1');
  await pr.click('header nav button[data-view=payroll]');
  await pr.click('[data-ptab=people]');
  await pr.locator('#pe-rows tr', { hasText: 'Cora Seed' }).waitFor();
  for (const [first, last, rate] of [['Ana', 'Clock', '16.50'], ['Bea', 'Office', '15']]) {
    await pr.click('#pe-add');
    await pr.locator('.drawer input[name=first_name]').fill(first);
    await pr.locator('.drawer input[name=last_name]').fill(last);
    await pr.locator('.drawer input[name=position]').fill('Teacher');
    await pr.locator('.drawer input[name=pay_rate]').fill(rate);
    await pr.locator('.drawer #em-save').click();
    await pr.locator('#pe-rows tr', { hasText: `${first} ${last}` }).waitFor();
  }
  await pr.click('#pe-pins');   // confirm() accepted
  const slips = pr.locator('.pin-slip');
  await slips.first().waitFor();
  assert.equal(await slips.count(), 3, 'a PIN slip for each person without a PIN');
  assert.ok((await slips.locator('.slip-pin b').allTextContents()).every((x) => /^\d{4}$/.test(x)));
  await shot(pr, '18-pin-slips');
  await pr.click('#sl-close');
  assert.equal(await pr.locator('#pe-nopin').count(), 0, 'nobody left without a PIN');
  assert.equal(await pr.locator('#pe-rows tr', { hasText: 'Ana Clock' }).locator('.pin-val').textContent(), '••••', 'PINs on file, hidden until “Show PINs”');
  await pr.locator('#pe-rows tr', { hasText: 'Ana Clock' }).click();
  assert.match(await pr.locator('#pin-sec').textContent(), /PIN on file: \d{4}/);
  await pr.locator('.drawer input[name=pin]').fill('7777');   // an easy one for now
  await pr.locator('.drawer #pin-set').click();
  await pr.locator('#pin-show', { hasText: '7777' }).locator('text=easy one').waitFor();
  await pr.locator('.drawer input[name=pin]').fill('4826');
  await pr.locator('.drawer #pin-set').click();
  await pr.locator('#pin-show', { hasText: '4826' }).waitFor();
  await pr.locator('.drawer [data-close]').first().click();
  await pr.click('#pe-show');
  assert.equal(await pr.locator('#pe-rows tr', { hasText: 'Ana Clock' }).locator('.pin-val').textContent(), '4826');
  await pr.click('#pe-show');
  await shot(pr, '19-payroll-staff');
  ok('Payroll: add staff with hourly rates; printable PIN slips; PINs on file (Show PINs), an easy one allowed for now');

  // ── the time clock on a tablet ──
  const kiosk = await newPage({ width: 1024, height: 768 }, true);
  await kiosk.goto(BASE + '/clock/');
  await kiosk.locator('text=This device isn’t a time clock yet').waitFor();
  await login(kiosk, 'owner@creativaacademy.com', 'owner-pass-1');
  await kiosk.click('header nav button[data-view=payroll]');
  await kiosk.click('[data-ptab=setup]');
  assert.equal(await kiosk.locator('#pay-sched input[name=payroll_anchor]').inputValue(), '2026-10-02', 'pay periods start Friday Oct 2');
  assert.match(await kiosk.locator('#pay-weeks').textContent(), /Pay periods \(Friday to Thursday\):[\s\S]*Tuition is billed/);
  assert.equal(await kiosk.locator('#pay-clash').count(), 0, 'pay weeks alternate with tuition weeks');
  await kiosk.click('#dev-add');   // confirm() accepted
  await kiosk.waitForURL(/\/clock\/$/);
  const kname = (n) => kiosk.locator('.k-name', { hasText: n });
  const typePin = async (pin) => { for (const c of pin) await kiosk.click(`[data-key="${c}"]`); };
  await kname('Ana Clock').waitFor();
  assert.deepEqual(await kiosk.locator('.k-name > span:first-child').allTextContents(), ['Ana Clock', 'Bea Office', 'Cora Seed']);
  await shot(kiosk, '20-clock-names');
  await kname('Ana Clock').click();
  await typePin('4826');
  await kiosk.locator('.k-state', { hasText: 'You’re clocked out' }).waitFor();
  await shot(kiosk, '21-clock-status');
  await kiosk.click('[data-act=in]');
  await kiosk.locator('.k-done h1', { hasText: /^Clocked in at \d/ }).waitFor();
  await shot(kiosk, '22-clock-done');
  await kiosk.click('#k-ok');
  await kname('Ana Clock').locator('.k-in').waitFor();
  await kname('Ana Clock').click();
  await typePin('0000');
  await kiosk.locator('#k-msg', { hasText: 'Wrong PIN' }).waitFor();
  await typePin('4826');
  await kiosk.locator('.k-state', { hasText: 'clocked in since' }).waitFor();
  await kiosk.click('[data-act=lunch]');
  await kiosk.locator('.k-done h1', { hasText: /^Out for lunch at/ }).waitFor();
  await kiosk.click('#k-ok');
  await kname('Ana Clock').click();
  await typePin('4826');
  await kiosk.locator('.k-state', { hasText: 'at lunch since' }).waitFor();
  await kiosk.click('[data-act=in]');
  await kiosk.locator('.k-done h1', { hasText: /^Back from lunch at/ }).waitFor();
  await kiosk.click('#k-ok');
  await kname('Ana Clock').click();
  await typePin('4826');
  await kiosk.click('[data-act=out]');
  await kiosk.locator('.k-done h1', { hasText: /^Clocked out at/ }).waitFor();
  assert.ok(await kiosk.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on the tablet');
  await kiosk.goto(BASE + '/');
  await kiosk.waitForSelector('text=Staff sign in');
  ok('time clock: set up from Payroll (signs the CRM out there); name + PIN; in, wrong PIN refused, lunch, back, out');

  // ── payroll: hours, fixes, Patriot ──
  await pr.click('[data-ptab=hours]');
  const prow = (n) => pr.locator('#pp-rows tr', { hasText: n });
  await prow('Ana Clock').waitFor();
  await pr.locator('.here-now', { hasText: 'Nobody is clocked in' }).waitFor();
  const missed = pr.locator('#pp-missed');
  await missed.locator('li', { hasText: 'Dee Missed' }).locator('[data-fix]').click();
  await pr.locator('.drawer input[name=t_in]').fill('07:00');
  await pr.locator('.drawer input[name=t_out]').fill('08:00');
  await pr.locator('.drawer #te-save').click();
  await pr.waitForSelector('#toast:has-text("Saved")');
  await missed.waitFor({ state: 'detached' });
  ok('Payroll: a missed clock-out is flagged and fixed');

  await pr.click('#pp-prev');
  await prow('Cora Seed').locator('td.num', { hasText: '45.00' }).waitFor();
  assert.deepEqual((await prow('Cora Seed').locator('td.num').allTextContents()).map((x) => x.trim()), ['$15.00', '40.00', '5.00', '45.00', '$712.50']);
  await shot(pr, '23-payroll-hours');
  ok('Payroll: 45 hours in a workweek = 40 regular + 5 overtime; estimated gross pays overtime at 1½×');
  await prow('Cora Seed').click();
  await pr.locator('.drawer table.ts').first().waitFor();
  await pr.locator('.drawer .ts-span').first().click();
  await pr.locator('.drawer input[name=t_out]').fill('16:00');
  await pr.locator('.drawer #te-save').click();
  await pr.locator('.drawer .ts-total', { hasText: '44.00' }).waitFor();
  assert.ok(await pr.locator('.drawer .ts-edited').count() >= 1, 'a changed time is marked');
  await shot(pr, '24-timesheet');
  await pr.locator('.drawer [data-close]').first().click();
  await pr.click('#pp-add');
  await pr.locator('.drawer select[name=employee_id]').selectOption({ label: 'Bea Office' });
  await pr.locator('.drawer input[name=t_in]').fill('08:00');
  await pr.locator('.drawer input[name=t_out]').fill('12:00');
  await pr.locator('.drawer #te-save').click();
  await prow('Bea Office').locator('td.num', { hasText: '4.00' }).first().waitFor();
  await pr.click('#pp-patriot');
  const ps = pr.locator('.pay-sheet');
  await ps.waitFor();
  const lines = await ps.locator('tbody tr').allTextContents();
  assert.ok(!lines.some((l) => l.includes('Clock, Ana')), 'only people with hours in the period (Ana clocked in this period)');
  assert.match(lines.find((l) => l.includes('Office, Bea')) || '', /Office, Bea\s*4\.00\s*0\.00\s*4\.00/);
  assert.match(lines.find((l) => l.includes('Seed, Cora')) || '', /Seed, Cora\s*40\.00\s*4\.00\s*44\.00/);
  assert.ok(lines.findIndex((l) => l.includes('Office, Bea')) < lines.findIndex((l) => l.includes('Seed, Cora')), 'by last name');
  const patriotCsv = pr.waitForEvent('download');
  await pr.click('#ps-csv');
  assert.match((await patriotCsv).suggestedFilename(), /^creativa-patriot-hours-\d{4}-\d{2}-\d{2}\.csv$/);
  await shot(pr, '25-patriot-sheet');
  await pr.pdf({ path: path.join(SHOTS, '25-patriot-sheet.pdf'), format: 'Letter', printBackground: true });
  await pr.click('#ps-close');
  await pr.click('#pp-close');   // confirm() accepted
  await pr.waitForSelector('#toast:has-text("marked as entered in Patriot")');
  await pr.locator('.month-bar .pay-pill', { hasText: 'Entered in Patriot' }).waitFor();
  await prow('Cora Seed').click();
  assert.ok(await pr.locator('.drawer .ts-span').first().isDisabled(), 'time is locked once entered in Patriot');
  assert.equal(await pr.locator('.drawer #ts-add').count(), 0);
  await pr.locator('.drawer [data-close]').first().click();
  await pr.click('#pp-reopen');
  await pr.waitForSelector('#toast:has-text("Pay period reopened")');
  ok('Payroll: change a time (kept as changed), add time, hours for Patriot (+ CSV), mark as entered (locks), reopen');

  // ── paychecks from Patriot (016) ──
  await pr.click('[data-ptab=paid]');
  await pr.click('#pc-add');
  await pr.fill('.drawer textarea[name=paste]', ['Pay Date\tPay Period\tEmployees', '10/22/2026\t10/2/2026 - 10/15/2026\t2\tHide Details\tReprint All Paychecks',
    'PRINT\tEMPLOYEE\tHOURS\tGROSS PAY\tNET PAY', '\tSEED, CORA\t80.00\t$1,240.00\t$1,145.14', '\tNOBODY, PAT Q\t10.00\t$150.00\t$138.00',
    'Totals:\t90.00\t$1,390.00\t$1,283.14', 'Select All Paychecks'].join('\n'));
  assert.equal(await pr.inputValue('.drawer input[name=pay_date]'), '2026-10-22');
  assert.equal(await pr.inputValue('.drawer input[name=period_start]'), '2026-10-02');
  assert.match(await pr.locator('#pc-preview tbody tr', { hasText: 'SEED, CORA' }).textContent(), /Cora Seed[\s\S]*80\.00[\s\S]*\$1,240\.00[\s\S]*\$1,145\.14/);
  await pr.locator('#pc-preview tbody tr', { hasText: 'NOBODY, PAT Q' }).locator('text=not on the staff list').waitFor();
  await pr.locator('#pc-preview', { hasText: 'Adds up to Patriot’s totals' }).waitFor();
  await shot(pr, '31-paychecks-add');
  await pr.click('#pc-save');
  await pr.waitForSelector('#toast:has-text("2 paychecks, $1,390.00 gross")');
  assert.match(await pr.locator('#pc-runs tr').first().textContent(), /Oct 22[\s\S]*Oct 2 – Oct 15[\s\S]*2[\s\S]*90\.00[\s\S]*\$1,390\.00[\s\S]*\$1,283\.14/);
  assert.match(await pr.locator('#pc-people tr', { hasText: 'Cora Seed' }).textContent(), /1[\s\S]*80\.00[\s\S]*\$1,240\.00/);
  await pr.locator('#pc-people tr', { hasText: 'Cora Seed' }).click();
  await pr.locator('.drawer #ts-paid li', { hasText: '$1,240.00' }).first().waitFor();
  await pr.locator('.drawer [data-close]').first().click();
  await pr.locator('#pc-runs tr').first().click();
  await pr.locator('.drawer tbody tr', { hasText: 'NOBODY, PAT Q' }).waitFor();
  await pr.locator('.drawer [data-close]').first().click();
  await pr.click('[data-ptab=hours]');
  ok('Paychecks: paste a payroll from Patriot (dates read, staff matched, totals checked); by pay date, by person, on each timesheet');

  // ── how to do payroll: a note on Today points to the steps on the Payroll page, which print ──
  await page.click('header nav button[data-view=today]');
  await page.locator('.pay-note', { hasText: 'Step-by-step instructions for payroll and pay stubs' }).waitFor();
  await page.click('#see-pay-guide');
  await page.locator('#pay-guide[open]', { hasText: 'Run payroll in Patriot' }).waitFor();
  assert.match(await page.locator('#pay-guide').textContent(), /Hours for Patriot[\s\S]*Approve[\s\S]*pay stubs[\s\S]*Mark as entered in Patriot[\s\S]*Add a payroll from Patriot/);
  await page.click('#pay-guide-print');
  await page.locator('.print-sheet h1', { hasText: 'How to do payroll' }).waitFor();
  await shot(page, '32-pay-guide');
  await page.click('#pg-close');
  await page.click('header nav button[data-view=today]');
  assert.equal(await page.locator('.pay-note').count(), 0, 'the note goes once the steps were seen');
  ok('How to do payroll: a note on Today, the steps on the Payroll page (Hours → Patriot → pay stubs → paychecks), printable');

  // ── to do (017) ──
  const nyDay = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  await page.click('header nav button[data-view=todo]');
  assert.match(await page.locator('li.todo', { hasText: 'Submit VPK attendance' }).textContent(), /Due [\s\S]* · Anyone in the office · every month/);
  assert.equal(await page.locator('li.todo', { hasText: 'Submit the Child Care Food Program claim' }).count(), 1);
  assert.equal(await page.locator('li.todo', { hasText: 'Submit School Readiness (SR) attendance' }).count(), 1);
  await page.click('#todo-add');
  await page.fill('.drawer input[name=title]', 'Order classroom supplies');
  await page.locator('.drawer select[name=assigned_to]').selectOption({ label: 'Emily Owner' });
  await page.fill('.drawer input[name=due_on]', nyDay(1));
  await page.selectOption('.drawer select[name=repeat]', 'monthly');
  await page.selectOption('.drawer select[name=remind_days]', '7');
  await page.click('#td-save');
  await page.waitForSelector('#toast:has-text("Added: Order classroom supplies")');
  assert.match(await page.locator('li.todo', { hasText: 'Order classroom supplies' }).textContent(), /tomorrow · You · every month/);
  await page.locator('header nav button[data-view=todo] .nav-badge').waitFor();
  await page.click('header nav button[data-view=today]');
  await page.locator('.today-todo li.todo', { hasText: 'Order classroom supplies' }).locator('[data-todo-done]').check();
  await page.waitForSelector('#toast:has-text("Done: Order classroom supplies. It’s back on")');
  assert.equal(await page.locator('.today-todo li.todo', { hasText: 'Order classroom supplies' }).count(), 0, 'checked off: off Today until next time');
  await page.click('header nav button[data-view=todo]');
  assert.equal(await page.locator('li.todo:not(.todo-done)', { hasText: 'Order classroom supplies' }).count(), 1, 'next month’s is on the list');
  await page.locator('li.todo-done', { hasText: 'Order classroom supplies' }).locator('[data-todo-done]').uncheck();
  await page.waitForSelector('#toast:has-text("Back on the list")');
  assert.equal(await page.locator('li.todo', { hasText: 'Order classroom supplies' }).count(), 1, 'undo: open again, and next month’s copy is gone');
  await shot(page, '33-todo');
  ok('To do: monthly reports to start, add one for a person, it shows on their Today with a count; check off (comes back next month), undo');

  // ── money (017) ──
  await page.click('header nav button[data-view=money]');
  const moneyCol = (h) => page.locator('.money-grid .panel', { has: page.locator('h2', { hasText: h }) });
  assert.match(await moneyCol('Money in').locator('li', { hasText: 'Tuition and fees from families' }).textContent(), /Zelle \$300\.00/);
  await page.click('#mo-add-out');
  await page.fill('.drawer input[name=category]', 'Food');
  await page.fill('.drawer input[name=amount]', '500');
  await page.fill('.drawer input[name=party]', 'Test Market');
  await page.fill('.drawer input[name=reference]', '1001');
  await page.selectOption('.drawer select[name=ccfp_col]', 'food');
  await page.click('#me-again');
  await page.waitForSelector('#toast:has-text("Saved: Food $500.00")');
  assert.equal(await page.inputValue('.drawer input[name=category]'), 'Food', 'add another keeps the category');
  await page.fill('.drawer input[name=category]', 'Supplies');
  await page.fill('.drawer input[name=amount]', '80');
  await page.selectOption('.drawer select[name=ccfp_col]', 'supplies');
  await page.click('#me-save');
  await page.waitForSelector('#toast:has-text("Saved: Supplies $80.00")');
  await page.click('#mo-add-out');
  await page.fill('.drawer input[name=category]', 'Food service labor');
  await page.fill('.drawer input[name=amount]', '1000');
  await page.selectOption('.drawer select[name=ccfp_col]', 'labor');
  assert.equal(await page.locator('.drawer input[name=in_totals]').isChecked(), false, 'labor is only for the food program record');
  await page.click('#me-save');
  await page.waitForSelector('#toast:has-text("Saved: Food service labor $1,000.00")');
  assert.match(await moneyCol('Money out').textContent(), /Food[\s\S]*\$500\.00[\s\S]*Supplies[\s\S]*\$80\.00/);
  assert.equal(await moneyCol('Money out').locator('li', { hasText: 'Food service labor' }).count(), 0, 'not counted twice with payroll');
  await page.locator('#mo-rows tr', { hasText: 'Food service labor' }).locator('text=only for the food program record').waitFor();
  const aug = page.locator('#mo-year tr[data-month="2026-08"]');
  if (await aug.count()) {   // the old billing system's sheets (seed: Aug 2026) count as tuition paid that month
    await aug.click();
    await moneyCol('Money in').locator('li', { hasText: 'Tuition paid in the old billing system' }).waitFor();
    await page.click('#mo-now');
  }
  ok('Money: tuition from Tuition by method; expenses and receipts (add another), marked for the food program; labor only on its record');

  await page.click('[data-mtab=food]');
  await page.click('#cf-add');
  await page.fill('.drawer input[name=claim_month]', nyDay(0).slice(0, 7));
  await page.fill('.drawer input[name=breakfasts]', '1000');
  await page.fill('.drawer input[name=lunches]', '1200');
  await page.fill('.drawer input[name=pm_snacks]', '1100');
  await page.fill('.drawer input[name=meal_earnings]', '7000');
  await page.fill('.drawer input[name=cash_in_lieu]', '400');
  assert.equal(await page.locator('#cf-total').textContent(), '$7,400.00');
  await page.click('#cf-fill');
  assert.equal(await page.inputValue('.drawer input[name=food_cost]'), '500.00');
  assert.equal(await page.inputValue('.drawer input[name=non_food_cost]'), '1080.00');
  await page.fill('.drawer input[name=submitted_on]', nyDay(0));
  await page.locator('.drawer input[name=submitted_on]').dispatchEvent('change');
  assert.equal(await page.inputValue('.drawer select[name=status]'), 'submitted');
  await page.click('#cf-save');
  await page.waitForSelector('#toast:has-text("Saved the claim for")');
  assert.match(await page.locator('#cf-rows tr').first().textContent(), /3,300[\s\S]*\$7,400\.00[\s\S]*\$1,580\.00[\s\S]*Submitted · pending/);
  await page.locator('.stat', { hasText: 'Submitted, not paid yet' }).locator('text=$7,400.00').waitFor();
  await page.click('#cf-next');
  await page.click('#cf-print');
  const rec = page.locator('.ccfp-sheet');
  assert.equal(await rec.locator('tbody tr').count(), 3);
  assert.match(await rec.locator('tfoot').textContent(), /\$500\.00[\s\S]*\$1,000\.00[\s\S]*\$0\.00[\s\S]*\$80\.00/);
  assert.match(await rec.locator('.ccfp-head').textContent(), /Food costs \$500\.00 · Non-food costs \$1,080\.00 · Grand total operating costs \$1,580\.00/);
  await shot(page, '34-ccfp-record');
  await page.click('#cr-close');
  await page.click('[data-mtab=overview]');
  await page.locator('.panel', { hasText: 'On its way' }).locator('li', { hasText: 'Child Care Food Program' }).locator('text=$7,400.00').waitFor();
  await page.click('[data-mtab=food]');
  await page.locator('#cf-rows tr').first().click();
  await page.fill('.drawer input[name=paid_on]', nyDay(0));
  await page.locator('.drawer input[name=paid_on]').dispatchEvent('change');
  assert.equal(await page.inputValue('.drawer input[name=paid_amount]'), '7400.00');
  await page.click('#cf-save');
  await page.waitForSelector('#toast:has-text("Saved the claim")');
  await page.click('[data-mtab=overview]');
  await moneyCol('Money in').locator('li', { hasText: 'Child Care Food Program' }).locator('text=$7,400.00').waitFor();
  await page.locator('#mo-year tr.on').waitFor();
  await shot(page, '35-money');
  ok('Food program: a claim (total, costs from the receipts), pending → coming in, paid → money in; the monthly record prints with its columns');

  // ── projection (019) ──
  await page.click('header nav button[data-view=board]');
  await page.click('#add');
  await drawer.locator('input[name=parent_name]').fill('Delta Parent');
  await drawer.locator('input[name=phone]').fill('305 555 0177');
  await drawer.locator('input[name=child_name]').fill('Test Kid Delta');
  await drawer.locator('input[name=program]').fill('Early 2s');
  assert.equal(await drawer.locator('input[name=expected_tuition]').getAttribute('placeholder'), '560 or 600', 'the class’s 2-week rates as a hint');
  await drawer.locator('#inq-rates [data-rate=after_care]').click();   // the class rate in one tap: $300 a week = $600 every 2 weeks
  assert.equal(await drawer.locator('input[name=expected_tuition]').inputValue(), '600');
  await drawer.locator('input[name=start_on]').fill(nextMonth1);
  await drawer.locator('input[name=expected_tuition]').fill('500');
  await drawer.locator('#save').click();
  await page.waitForSelector('#toast:has-text("Inquiry added")');
  await drawer.locator('[data-close]').first().click();
  await page.locator('.card', { hasText: 'Delta Parent' }).locator('.tag.start', { hasText: '$500.00' }).waitFor();
  await page.click('header nav button[data-view=money]');
  await page.click('[data-mtab=projection]');
  assert.equal(await page.locator('.proj-chart .pc-month').count(), 6, 'a column pair a month');
  assert.equal(await page.locator('.proj-cards .proj-month').count(), 6);
  assert.match(await page.locator('.proj-cards .proj-month').first().locator('.pm-actual').textContent(), /Came in so far\s*\$[\d,]+[\s\S]*Went out so far/, 'this month: what really came in');
  await page.locator('.proj-summary', { hasText: 'left over a month' }).waitFor();
  await page.click('.proj-table-box > summary');   // every number as a table
  const proj = page.locator('table.proj');
  await proj.waitFor();
  assert.equal(await proj.locator('thead th').count(), 7, 'six months by default');
  const projRow = (label) => proj.locator('tr', { has: page.locator('th', { hasText: label }) }).first();
  assert.match(await projRow('Tuition from private-pay families').textContent(), /\$[\d,]+/);
  assert.match(await projRow('New families starting (possible)').locator('td').nth(1).textContent(), /^\$1,(000|500)$/, 'the new child from next month');
  await page.locator('#proj-coming tr', { hasText: 'Sofia Lopez' }).locator('text=Starts').waitFor();
  await page.locator('#proj-wait li', { hasText: 'Test Kid Delta' }).locator('text=Possible from').waitFor();   // a Pipeline family, once
  await page.click('[data-pm="12"]');
  assert.equal(await proj.locator('thead th').count(), 13);
  await shot(page, '36-projection');
  await page.click('[data-pm="6"]');
  ok('Projection: tuition from each child’s rate and start date, payroll and expenses from recent months, Pipeline families who could start');

  // ── bills paid every month, and class rates (020) ──
  await page.click('[data-mtab=bills]');
  await page.click('#bill-add');
  await drawer.locator('input[name=name]').fill('Rent');
  await drawer.locator('input[name=category]').fill('Rent');
  await drawer.locator('input[name=amount]').fill('1000');
  await drawer.locator('input[name=days]').fill('15, 30');
  await drawer.locator('input[name=pl0]').fill('Base rent');
  await drawer.locator('input[name=pa0]').fill('1500');
  await drawer.locator('input[name=pl1]').fill('CAM');
  await drawer.locator('input[name=pa1]').fill('500');
  await drawer.locator('input[name=starts_on]').fill(`${todayStr.slice(0, 7)}-01`);
  await drawer.locator('#bill-save').click();
  await page.waitForSelector('#toast:has-text("Saved: Rent, $2,000.00 a month")');
  assert.equal(await page.locator('#bill-dues li', { hasText: 'Rent' }).count(), 2, 'due on the 15th and the 30th');
  assert.match(await page.locator('#bill-list li', { hasText: 'Rent' }).textContent(), /\$2,000\.00[\s\S]*2 payments of \$1,000\.00, on the 15th and the 30th[\s\S]*Base rent \$1,500\.00[\s\S]*CAM \$500\.00/);
  await page.locator('#bill-dues li').first().locator('[data-pay]').click();
  assert.equal(await drawer.locator('input[name=amount]').inputValue(), '1000');
  await drawer.locator('#me-save').click();
  await page.waitForSelector('#toast:has-text("Saved: Rent $1,000.00")');
  await page.locator('#bill-dues li.bd-paid', { hasText: 'Rent' }).waitFor();
  assert.equal(await page.locator('.stat', { hasText: 'Paid' }).first().locator('b').textContent(), '$1,000.00');
  await shot(page, '38-bills');
  await page.click('[data-mtab=overview]');
  await moneyCol('Money out').locator('li', { hasText: 'Rent' }).locator('text=$1,000.00').waitFor();
  await page.click('[data-mtab=projection]');
  assert.match(await projRow('Rent and bills').locator('td').nth(1).textContent(), /\$2,000/, 'every bill on its days');
  assert.match(await projRow('Other expenses').textContent(), /not counting Rent/);
  assert.equal(await page.locator('#proj-rates li', { hasText: 'Test Kid Alpha' }).count(), 0, '$560 every 2 weeks is the Early 3s after-care rate');
  // A class rate changes on Settings: the child at the old rate shows up to check.
  await page.click('header nav button[data-view=staff]');
  const e3Rate = page.locator('.rate-table tr', { hasText: 'Early 3s' }).locator('input[data-k=rate_after_care]');
  await e3Rate.fill('285');
  await e3Rate.press('Tab');
  await page.waitForSelector('#toast:has-text("Saved")');
  await page.click('header nav button[data-view=money]');
  assert.match(await page.locator('#proj-rates li', { hasText: 'Test Kid Alpha' }).textContent(), /\$560\.00 every 2 weeks: 2% less than full time \+ after care \(\$285\.00 a week\)/);
  await page.locator('#proj-rates li', { hasText: 'Test Kid Alpha' }).locator('[data-open-sid]').click();
  await drawer.locator('#rate-opts [data-rate=full]').click();   // one tap fills the rate, kept every 2 weeks
  assert.equal(await drawer.locator('input[name=tuition_amount]').inputValue(), '540');
  assert.equal(await drawer.locator('#rate-opts .btn.primary').textContent(), 'Full time · $270.00 a week');
  await drawer.locator('[data-close]').first().click();   // discard (confirm accepted)
  await page.click('header nav button[data-view=staff]');
  await e3Rate.fill('280');
  await e3Rate.press('Tab');
  await page.waitForSelector('#toast:has-text("Saved")');
  ok('Bills: rent twice a month with what it’s made of, mark one paid (money out); the projection counts bills; class rates on Settings, rates to check, one-tap rate');

  // ── waiting list: registration paid is what holds the spot (019) ──
  await page.click('header nav button[data-view=board]');
  const waitCol = page.locator('.col[data-stage=waitlisted]');
  await page.locator('.card', { hasText: 'Delta Parent' }).dragTo(waitCol);
  await waitCol.locator('.card', { hasText: 'Delta Parent' }).locator('.tag.due', { hasText: 'registration not paid' }).waitFor();
  const regNote = async () => (await waitCol.locator('.col-note').textContent()).match(/(\d+) of (\d+) paid registration/).slice(1).map(Number);
  const [paid0, wait0] = await regNote();
  await waitCol.locator('.card', { hasText: 'Delta Parent' }).click();
  await drawer.locator('input[name=reg_amount]').fill('150');
  await drawer.locator('#save').click();
  await page.waitForSelector('#toast:has-text("Add the day registration was paid")');
  await drawer.locator('input[name=reg_paid_on]').fill(todayStr);
  await drawer.locator('#save').click();
  await drawer.locator('#to-roster', { hasText: 'Add Test Kid Delta to the waiting list' }).click();
  await drawer.locator('#st-save').waitFor();
  assert.equal(await drawer.locator('select[name=status]').inputValue(), 'waitlist');
  assert.equal(await drawer.locator('select[name=reg_fee]').inputValue(), 'paid', 'registration paid carries over');
  await drawer.locator('#st-save').click();
  await page.waitForSelector('#toast:has-text("Test Kid Delta added")');
  await drawer.locator('#open-inq').click();
  await drawer.locator('.enroll-link', { hasText: 'On the waiting list: Test Kid Delta' }).waitFor();
  assert.match(await drawer.locator('p', { hasText: 'Registration:' }).textContent(), /Registration: paid/);
  await drawer.locator('[data-close]').first().click();
  await waitCol.locator('.card', { hasText: 'Delta Parent' }).locator('.tag.paid', { hasText: 'registration paid' }).waitFor();
  assert.deepEqual(await regNote(), [paid0 + 1, wait0], 'the Waitlisted column counts who paid');
  await shot(page, '37-waitlist-registration');
  await page.click('header nav button[data-view=roster]');
  await page.selectOption('#r-status', 'waitlist');
  assert.equal(await page.locator('#roster-rows tr', { hasText: 'Test Kid Delta' }).locator('.tag.paid').textContent(), 'Paid');
  assert.match(await page.locator('.class-card', { hasText: 'Early 2s' }).locator('.tag').textContent(), /\d+ waiting · [1-9]\d* paid/);
  assert.match(await page.locator('.class-card.total').textContent(), /on waiting lists \([1-9]\d* paid registration\)/);
  await page.selectOption('#r-status', 'enrolled');
  await page.click('header nav button[data-view=money]');
  await page.click('[data-mtab=projection]');
  assert.equal(await page.locator('#proj-wait li', { hasText: 'Test Kid Delta' }).count(), 1, 'on the waiting list and in the Pipeline: listed once');
  assert.match(await page.locator('#proj-wait li', { hasText: 'Test Kid Delta' }).textContent(), /Pipeline: Waitlisted[\s\S]*registration paid[\s\S]*Counted from/, 'registration paid + start date: counted');
  assert.match(await page.locator('#proj-wait li', { hasText: 'Test Kid Gamma' }).textContent(), /Not counted: add a start date/);
  await page.click('.proj-table-box > summary');
  assert.match(await page.locator('table.proj tr', { has: page.locator('th', { hasText: 'New families starting (registration paid)' }) }).locator('td').nth(1).textContent(), /^\$1,(000|500)$/);
  ok('Waiting list: registration paid on the inquiry shows on its card and the column, carries over to the student, and shows on Enrollment; with a start date it counts in the projection');

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

  // ── who changed what ──
  await p2.locator('.drawer [data-close]').first().click();
  await p2.locator('header nav button[data-view=changes] .nav-badge').waitFor();
  await p2.click('header nav button[data-view=changes]');
  await p2.locator('.chg-list li', { hasText: 'Emily Owner added Walk-in Kid to Late 2s' }).waitFor();
  assert.equal(await p2.locator('.chg-list li', { hasText: 'recorded a' }).count(), 0, 'no tuition changes without finance access');
  assert.equal(await p2.locator('header nav button[data-view=changes] .nav-badge').count(), 0, 'opening Changes clears the count');
  await p2.click('header nav button[data-view=roster]');
  await p2.locator('#roster-rows tr', { hasText: 'Test Kid Alpha' }).locator('input[data-doc=doc_yellow_form]').check();
  await p2.waitForSelector('#toast:has-text("Yellow form received")');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.click('header nav button[data-view=today]');
  await page.locator('.changes-note', { hasText: 'by New Hire' }).waitFor();
  await page.click('#see-changes');
  const mine = page.locator('.chg-list li.new', { hasText: 'New Hire changed Test Kid Alpha: yellow form' });
  await mine.waitFor();
  assert.ok(await page.locator('.chg-list li', { hasText: /^[\s\S]*You recorded a \$300\.00 Zelle payment for Test Kid Alpha/ }).count(), 'your own changes say You');
  await shot(page, '27-changes');
  await mine.locator('[data-cg-kid]').click();
  await page.locator('.drawer #st-changes li', { hasText: 'New Hire' }).waitFor();
  await page.locator('.drawer [data-close]').first().click();
  ok('Changes: everyone sees who changed what (in their areas), a count of new changes by others, and each child’s history');

  // ── texts to families ──
  await page.click('header nav button[data-view=messages]');
  const tpl = (name) => page.locator('#msg-tpls [data-tpl]', { hasText: name });
  await page.locator('#msg-tpls [data-tpl-new]').waitFor();   // My messages loaded (014 starts with three examples)
  await tpl('Payment reminder').click();
  const alphaTo = page.locator('#msg-list li', { hasText: 'Test Kid Alpha' });
  await alphaTo.waitFor();
  const owes = (await alphaTo.textContent()).match(/\+13055550101 · owes (\$[\d,.]+)/)[1];
  assert.equal(await alphaTo.locator('.msg-bubble').textContent(), `Hi Alpha, this is Emily from Creativa Academy. A friendly reminder that Test's tuition `
    + `balance is ${owes}. You can pay by Zelle, card or cash. Thank you!\nReply STOP to opt out.`);
  assert.equal(await page.locator('#msg-list li', { hasText: 'Test Kid Gamma' }).count(), 0, 'only families who owe');
  await alphaTo.locator('[data-skip-one]').click();
  await page.locator('#msg-list', { hasText: 'you took them off' }).locator('[data-unskip]').click();
  await alphaTo.waitFor();
  await tpl('Activity reminder').click();
  assert.equal(await page.evaluate(() => { const t = document.querySelector('#msg-form textarea'); return t.value.slice(t.selectionStart, t.selectionEnd); }),
    '[activity]', 'the first blank is selected, ready to type over');
  await page.click('#msg-send');
  await page.waitForSelector('#toast:has-text("Fill in the parts in [brackets] first")');
  ok('Messages: start from a saved message; blocks are filled in for each family (their balance, my name); [blanks] must be filled; take a family off');

  // write one from blocks, save it to My messages, fill in its blank, change it for one family
  await page.selectOption('#msg-form select[name=who]', 'pick');
  await page.fill('#msg-form input[name=q]', 'alpha');
  await page.locator('#msg-pick-list [data-fam]').check();
  await page.click('#msg-tpls [data-tpl-new]');
  const ta = page.locator('#msg-form textarea[name=body]');
  await ta.fill('Hi');
  await page.click('[data-block="{parent}"]');
  await page.keyboard.type(', picture day for');
  await page.click('[data-block="{child}"]');
  await page.keyboard.type(' is on');
  await page.click('[data-block="[ ]"]');
  await page.keyboard.type('day');
  await page.keyboard.press('End');
  await page.keyboard.type('! - ');
  await page.click('[data-block="{me}"]');
  assert.equal(await ta.inputValue(), 'Hi {parent}, picture day for {child} is on [day]! - {me}');
  await page.fill('#msg-form input[name=tplName]', 'Picture day');
  await page.click('#tpl-new');
  await page.waitForSelector('#toast:has-text("Saved “Picture day” to My messages")');
  await page.locator('#msg-tpls [data-tpl].on', { hasText: 'Picture day' }).waitFor();
  await page.click('#msg-next-blank');
  await page.keyboard.type('Friday');
  assert.equal(await ta.inputValue(), 'Hi {parent}, picture day for {child} is on Friday! - {me}');
  assert.equal(await alphaTo.locator('.msg-bubble').textContent(), 'Hi Alpha, picture day for Test is on Friday! - Emily\nReply STOP to opt out.');
  await alphaTo.locator('[data-edit-one]').click();
  await alphaTo.locator('textarea.msg-one').fill('Hi Alpha! Picture day for Test is on Friday, wear something blue. - Emily\nReply STOP to opt out.');
  await alphaTo.locator('[data-done-one]').click();
  await alphaTo.locator('text=Changed just for them').waitFor();
  assert.equal(await page.locator('#msg-send').textContent(), 'Send 1 text');
  await shot(page, '28-messages');
  await page.click('#msg-send');
  await page.waitForSelector('#toast:has-text("Saved")');
  const sentRow = page.locator('#msg-hist tr', { hasText: '1 famil' });
  await sentRow.locator('text=1 waiting').waitFor();
  assert.match(await sentRow.textContent(), /You[\s\S]*Hi \{parent\}, picture day/);
  await sentRow.click();
  assert.equal(await page.locator('.drawer .msg-bubble').textContent(), 'Hi {parent}, picture day for {child} is on Friday! - {me}\nReply STOP to opt out.');
  const alphaGot = page.locator('.drawer li', { hasText: 'Alpha Parent' });
  await alphaGot.locator('text=Waiting').waitFor();
  assert.match(await alphaGot.locator('.msg-their').textContent(), /^Hi Alpha! Picture day for Test is on Friday, wear something blue\. - Emily\s+Reply STOP/);
  await page.click('#msg-cancel');
  await page.waitForSelector('#toast:has-text("Canceled for 1 family")');
  await sentRow.locator('text=1 canceled').waitFor();
  await tpl('Picture day').waitFor();
  assert.equal(await page.locator('#msg-form textarea[name=body]').inputValue(), '', 'a fresh text after sending');
  await page.click('header nav button[data-view=roster]');
  await page.locator('#roster-rows tr', { hasText: 'Test Kid Alpha' }).locator('td').first().click();
  await page.locator('.drawer #st-texts li', { hasText: /wear something blue\. - Emily\s+Reply STOP to opt out\./ }).locator('text=Canceled').waitFor();
  await page.locator('.drawer [data-close]').first().click();
  assert.equal(await p2.locator('header nav button[data-view=messages]').count(), 0, 'no Messages without finance access');
  assert.equal(await p2.locator('header nav button[data-view=money], header nav button[data-view=todo]').count(), 0, 'no Money or To do without finance access');
  ok('Messages: write your own with blocks, save it to My messages, fill in its [blank], change one family’s text; history and cancel');

  // ── lists (015) ──
  await page.click('header nav button[data-view=messages]');
  const listRow = (name) => page.locator('.msg-lists-ul li', { hasText: name });
  await listRow('Moms 2nd Floor').waitFor();
  assert.deepEqual(await page.locator('.msg-lists-ul .ml-name b').allTextContents(), ['FES Moms', 'Kinder Moms', 'Moms 1st Floor', 'Moms 2nd Floor',
    'VPK Moms', 'School Readiness families', 'Private pay families']);
  assert.match(await listRow('Moms 2nd Floor').textContent(), /Early 3s, Late 3s[\s\S]*1 family · 1 text\b/);
  assert.match(await listRow('FES Moms').textContent(), /Every class · FES-UA, FES-EO[\s\S]*1 family · 1 text\b/);
  await listRow('Moms 2nd Floor').locator('[data-list-text]').click();
  assert.equal(await page.locator('#msg-form select[name=who] option:checked').textContent(), 'Moms 2nd Floor');
  await page.locator('#msg-list li', { hasText: 'Test Kid Alpha' }).waitFor();
  await listRow('VPK Moms').locator('[data-list-edit]').click();
  await page.locator('.drawer #ls-now li', { hasText: 'no cell number' }).waitFor();   // Test Kid Beta has no phone
  await page.fill('#ls-xname', 'Front Desk');
  await page.fill('#ls-xphone', '786 555 0100');
  await page.click('#ls-xadd');
  await page.locator('.drawer #ls-now li', { hasText: '+17865550100' }).waitFor();
  await page.fill('#ls-q', 'alpha');
  await page.click('#ls-found [data-addfam]');
  await page.locator('.drawer #ls-fams li', { hasText: 'Test Kid Alpha' }).waitFor();
  await shot(page, '30-list-edit');
  await page.click('#ls-save');
  await page.waitForSelector('#toast:has-text("Saved “VPK Moms”")');
  assert.match(await listRow('VPK Moms').textContent(), /VPK · \+1 added by hand · \+1 other[\s\S]*2 families \+ 1 other · 2 texts/);
  await page.click('#list-new');
  await page.fill('.drawer input[name=name]', 'Early 3s FES');
  await page.locator('.drawer label', { hasText: 'Early 3s' }).locator('input').check();
  await page.locator('.drawer label', { hasText: 'FES-UA' }).locator('input').check();
  await page.locator('.drawer #ls-now li', { hasText: 'Alpha Parent' }).waitFor();
  await page.click('#ls-save');
  await listRow('Early 3s FES').waitFor();
  assert.ok(await page.locator('#msg-form select[name=who] option', { hasText: 'Early 3s FES' }).count(), 'a new list can be texted');
  await page.locator('.msg-lists').scrollIntoViewIfNeeded();
  await shot(page, '29-lists');
  ok('Lists: the school’s lists by class and funding (kept up to date), add families by hand and other people, make a new one');

  // who in a family gets group texts; Families I pick still reach the primary contact
  await page.click('header nav button[data-view=roster]');
  await page.locator('#roster-rows tr', { hasText: 'Test Kid Alpha' }).locator('td').first().click();
  await drawer.locator('.contact-list li', { hasText: 'Alpha Parent' }).locator('[data-contact]').click();
  assert.equal(await page.locator('.drawer input[name=group_texts]').isChecked(), true, 'the Primary contact gets group texts');
  await page.locator('.drawer input[name=group_texts]').uncheck();
  await page.click('#ct-save');
  await page.waitForSelector('#toast:has-text("Contact saved")');
  await drawer.locator('.contact-list li', { hasText: 'Alpha Parent' }).locator('.tag', { hasText: 'no group texts' }).waitFor();
  await drawer.locator('.contact-list li', { hasText: 'Beto Alpha' }).locator('[data-contact]').click();
  assert.equal(await page.locator('.drawer input[name=group_texts]').isChecked(), false, 'a Secondary contact doesn’t, unless ticked');
  await page.locator('.drawer input[name=group_texts]').check();
  await page.click('#ct-save');
  await page.waitForSelector('#toast:has-text("Contact saved")');
  await drawer.locator('.contact-list li', { hasText: 'Beto Alpha' }).locator('.tag', { hasText: 'gets group texts' }).waitFor();
  await drawer.locator('#st-text').click();
  await page.locator('#msg-pick-list input[data-fam]:checked').waitFor();
  assert.match(await page.locator('#msg-list').textContent(), /Alpha Parent[\s\S]*\+13055550101/, 'texting one family reaches the Primary contact');
  await page.selectOption('#msg-form select[name=who]', { label: 'FES Moms' });
  await page.locator('#msg-list li', { hasText: 'Beto Alpha' }).waitFor();
  assert.equal(await page.locator('#msg-list li', { hasText: '+13055550101' }).count(), 0, 'group texts skip a contact set not to get them');
  await page.click('header nav button[data-view=roster]');
  await page.selectOption('#r-status', 'waitlist');
  await page.locator('#roster-rows tr', { hasText: 'Test Kid Gamma' }).locator('td').first().click();
  await drawer.locator('#contact-copy').click();
  await drawer.locator('#cc-q').fill('alpha');
  await drawer.locator('#cc-found [data-cc]').click();
  await page.waitForSelector('#toast:has-text("Copied Alpha Parent and Beto Alpha")');
  await drawer.locator('.contact-list li', { hasText: 'Beto Alpha' }).locator('.tag', { hasText: 'gets group texts' }).waitFor();
  await drawer.locator('#st-text').click();
  await page.locator('#msg-list li', { hasText: 'Test Kid Alpha, Test Kid Gamma' }).waitFor();   // brothers and sisters: one family, one text
  await page.click('header nav button[data-view=roster]');
  await page.selectOption('#r-status', 'enrolled');
  await page.click('header nav button[data-view=messages]');
  ok('Group texts go to the contacts set to get them (the Primary contact unless changed); “Text this family”; brothers and sisters share parents and a text');

  // missing paperwork, someone else, and a new website request while the CRM is open
  await page.click('#msg-tpls [data-tpl-new]');
  await page.selectOption('#msg-form select[name=who]', 'all');
  await tpl('Missing paperwork').click();
  assert.equal(await page.locator('#msg-form select[name=who]').inputValue(), 'docs', 'a message with {missing} goes to families missing paperwork');
  const docsTo = page.locator('#msg-list li', { hasText: 'Test Kid Alpha' });
  assert.match(await docsTo.locator('.msg-bubble').textContent(),
    /^Hi Beto, this is Emily from Creativa Academy\. We are still missing Test's [a-z ]+\. Please bring it to the front desk when you can\. Thank you!\nReply STOP/);
  await page.selectOption('#msg-form select[name=who]', 'one');
  await page.fill('#msg-form input[name=oneName]', 'Rosa');
  await page.fill('#msg-form input[name=onePhone]', '(305) 555-0199');
  assert.match(await page.locator('#msg-list').textContent(), /Rosa[\s\S]*\+13055550199/);
  assert.equal(await page.locator('#msg-send').textContent(), 'Send 1 text');
  const sent = await fetch(`${BASE}/rest/v1/rpc/submit_inquiry`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p_form: 'schedule-tour', p_data: { 'parent-name': 'Walker Newfamily', 'parent-phone': '3055550142', 'child-name': 'Wally' } }) });
  assert.ok(sent.ok, `website request saved (${sent.status})`);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForSelector('#toast:has-text("New tour request: Walker Newfamily")');
  await page.locator('header nav button[data-view=today] .nav-badge', { hasText: '1' }).waitFor();
  assert.match(await page.title(), /^\(1\) /);
  await page.click('header nav button[data-view=today]');
  await page.locator('.panel', { hasText: 'New inquiries' }).locator('.row', { hasText: 'Walker Newfamily' }).waitFor();
  assert.equal(await page.locator('header nav button[data-view=today] .nav-badge').count(), 0);
  ok('Messages: families missing paperwork ({missing} filled in), someone else by number; a new website request shows up without reloading');

  const p3 = await newPage();
  await login(p3, 'teacher@creativaacademy.com', 'teacher-pass-1');
  await p3.click('header nav button[data-view=tuition]');
  await p3.locator('#t-rows tr', { hasText: 'Test Kid Alpha' }).waitFor();
  assert.equal(await p3.locator('#t-add').count(), 0);
  assert.equal(await p3.locator('[data-pay-for], [data-pay-inv], [data-bill-one], #t-bill').count(), 0);
  assert.equal(await p3.locator('header nav button[data-view=payroll]').count(), 0, 'no Payroll without payroll access');
  assert.equal(await p3.locator('header nav button[data-view=messages]').count(), 0, 'no Messages with view-only finance');
  assert.equal(await p3.locator('header nav button[data-view=todo]').count(), 0, 'no To do for view-only finance');
  await p3.click('header nav button[data-view=money]');
  await p3.locator('.money-grid').waitFor();
  assert.equal(await p3.locator('#mo-add-out, #mo-add-in').count(), 0, 'view-only finance sees Money but can’t add');
  ok('view-only finance: sees Tuition, cannot record payments; no Payroll');

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
  await m.click('header nav button[data-view=money]');
  await m.click('[data-mtab=projection]');
  await m.locator('.proj-month').first().waitFor();
  assert.equal(await m.locator('table.proj').isVisible(), false, 'the table is tucked away');
  assert.match(await m.locator('.proj-month').first().textContent(), /(Left over|Short)[\s\S]*Money in[\s\S]*Money out[\s\S]*What’s in it/);
  const projOverflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(projOverflow <= 0, `Projection scrolls sideways by ${projOverflow}px on a phone`);
  await shot(m, '39-mobile-projection');
  await m.click('[data-mtab=bills]');
  await m.locator('#bill-dues li').first().waitFor();
  await shot(m, '40-mobile-bills');
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
  let n = 0;   // what every open page looked like when it failed
  for (const ctx of browser.contexts()) for (const pg of ctx.pages()) await pg.screenshot({ path: path.join(SHOTS, `failed-${++n}.png`) }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
