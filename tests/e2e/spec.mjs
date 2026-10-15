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
  await shot(page, '12-tuition');
  ok('credits: keep a payment as a credit, apply it to an invoice; owed list; FES-UA receipts; next period');

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
      await feeRow.locator('[data-waive]').click();
      await page.waitForSelector('#toast:has-text("Late fee waived")');
      assert.equal(await page.locator('#t-open tr', { hasText: 'Late fee' }).count(), 0);
      assert.equal(await page.locator('#t-late').count(), 0, 'a waived fee stays waived');
      ok('late fee: $30 on tuition unpaid after Friday, shown on the child, waived in one tap');
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
  await pr.locator('#pe-rows tr', { hasText: 'Ana Clock' }).locator('.pay-pill', { hasText: 'Set' }).waitFor();
  await pr.locator('#pe-rows tr', { hasText: 'Ana Clock' }).click();
  await pr.locator('.drawer input[name=pin]').fill('1234');
  await pr.locator('.drawer #pin-set').click();
  await pr.waitForSelector('#toast:has-text("too easy to guess")');
  await pr.locator('.drawer input[name=pin]').fill('4826');
  await pr.locator('.drawer #pin-set').click();
  await pr.locator('#pin-show', { hasText: '4826' }).waitFor();
  await pr.locator('.drawer [data-close]').first().click();
  await shot(pr, '19-payroll-staff');
  ok('Payroll: add staff with hourly rates; printable PIN slips; set a PIN (easy ones refused)');

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
  await missed.locator('li', { hasText: 'Cora Seed' }).locator('[data-fix]').click();
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
  assert.equal(lines.length, 2, 'only people with hours');
  assert.match(lines[0], /Office, Bea\s*4\.00\s*0\.00\s*4\.00/);
  assert.match(lines[1], /Seed, Cora\s*40\.00\s*4\.00\s*44\.00/);
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
  assert.equal(await p3.locator('[data-pay-for], [data-pay-inv], [data-bill-one], #t-bill').count(), 0);
  assert.equal(await p3.locator('header nav button[data-view=payroll]').count(), 0, 'no Payroll without payroll access');
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
