// Unit test for netlify/functions/tour-emails.mjs with a fake Supabase and a fake Resend.
// Run: node --test tests/tour-emails.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, render } from '../netlify/functions/tour-emails.mjs';

const settings = {
  tour_reminder_subject: 'Tour tomorrow',
  tour_reminder_body: 'Hi {parent},\nSee you {tour_date} at {tour_time} with {child}. / Hola {parent}, {tour_date_es}, {child_es}.',
  followup_subject: 'How was it?',
  followup_body: 'Hi {parent}, how did {child} like it?',
};
const due = [
  { kind: 'reminder', inquiry_id: 'i1', email: 'a@example.com', parent_name: 'Maria Lopez', child_name: 'Sofia Lopez', tour_at: '2026-10-10T15:00:00+00:00' },
  { kind: 'followup', inquiry_id: 'i2', email: 'b@example.com', parent_name: null, child_name: null, tour_at: '2026-10-02T14:00:00+00:00' },
  { kind: 'reminder', inquiry_id: 'i3', email: 'bounce@example.com', parent_name: 'X', child_name: 'Y', tour_at: '2026-10-10T15:00:00+00:00' },
];

function fakes() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const json = (obj, status = 200) => new Response(obj === null ? null : JSON.stringify(obj), { status });
    if (url.endsWith('/rest/v1/rpc/tour_emails_due')) return json(due);
    if (url.includes('/rest/v1/settings')) return json([settings]);
    if (url.endsWith('/rest/v1/rpc/tour_email_sent')) return json(null, 204);
    if (url === 'https://api.resend.com/emails') {
      return JSON.parse(init.body).to[0].startsWith('bounce') ? json({ message: 'nope' }, 422) : json({ id: 'e1' });
    }
    throw new Error('unexpected ' + url);
  };
  return { calls, fetchImpl };
}

test('renders names, Miami dates and fallbacks', () => {
  const out = render(settings.tour_reminder_body, due[0]);
  assert.equal(out, 'Hi Maria,\nSee you Saturday, October 10 at 11:00 AM with Sofia. / Hola Maria, sábado, 10 de octubre, Sofia.');
  assert.equal(render(settings.followup_body, due[1]), 'Hi, how did your little one like it?');
});

test('sends due emails, stamps only the ones that went out', async () => {
  const { calls, fetchImpl } = fakes();
  const r = await run({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'svc', RESEND_API_KEY: 're', REMINDER_REPLY_TO: 'office@example.com' }, fetchImpl, () => {});
  assert.deepEqual(r, { due: 3, sent: 2, failed: 1, dryRun: false });
  const emails = calls.filter((c) => c.url.startsWith('https://api.resend.com'));
  assert.equal(emails.length, 3);
  assert.equal(emails[0].body.subject, 'Tour tomorrow');
  assert.deepEqual(emails[0].body.to, ['a@example.com']);
  assert.equal(emails[0].body.reply_to, 'office@example.com');
  assert.match(emails[0].body.html, /Hi Maria,<br>See you/);
  assert.equal(emails[0].init.headers['idempotency-key'], 'reminder-i1-2026-10-10T15:00:00+00:00');
  const stamped = calls.filter((c) => c.url.endsWith('rpc/tour_email_sent')).map((c) => c.body);
  assert.deepEqual(stamped, [{ p_inquiry: 'i1', p_kind: 'reminder', p_to: 'a@example.com' }, { p_inquiry: 'i2', p_kind: 'followup', p_to: 'b@example.com' }]);
  assert.equal(calls[0].init.headers.authorization, 'Bearer svc');
});

test('without a Resend key it only logs (dry run) and stamps nothing', async () => {
  const { calls, fetchImpl } = fakes();
  const lines = [];
  const r = await run({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' }, fetchImpl, (l) => lines.push(l));
  assert.equal(r.dryRun, true);
  assert.equal(r.sent, 0);
  assert.equal(calls.filter((c) => c.url.includes('resend') || c.url.endsWith('tour_email_sent')).length, 0);
  assert.ok(lines.some((l) => l.includes('would send reminder to a@example.com')));
});

test('not configured: does nothing', async () => {
  const r = await run({}, () => { throw new Error('should not fetch'); }, () => {});
  assert.equal(r.skipped, 'not configured');
});
