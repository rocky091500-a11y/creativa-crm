// Unit tests for netlify/functions/family-texts.mjs with fake Supabase and Twilio.
// Run: node --test tests/family-texts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../netlify/functions/family-texts.mjs';

const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+17865550000' };
const due = [
  { id: 'r1', phone: '+13055550101', body: 'Hi Ana, balance $260.00' },
  { id: 'r2', phone: '+13055550102', body: 'Hi Bo' },
  { id: 'r3', phone: '+13055550103', body: 'Hi Stop' },
  { id: 'r4', phone: '+13055550104', body: 'Taken elsewhere' },
];
function fakes() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const form = String(init.headers?.['content-type']).includes('urlencoded');
    calls.push({ url, body: form ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body || 'null') });
    const json = (obj, status = 200) => new Response(obj === null ? null : JSON.stringify(obj), { status });
    if (url.endsWith('/rpc/family_texts_due')) return json(due);
    if (url.endsWith('/rpc/family_text_claim')) return json(JSON.parse(init.body).p_id !== 'r4');
    if (url.endsWith('/rpc/family_text_result')) return json(null, 204);
    if (url === 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json') {
      const to = new URLSearchParams(init.body).get('To');
      if (to.endsWith('102')) return json({ code: 21211, message: 'Invalid To' }, 400);
      if (to.endsWith('103')) return json({ code: 21610, message: 'unsubscribed' }, 400);
      return json({ sid: 'SM1' }, 201);
    }
    throw new Error('unexpected ' + url);
  };
  return { calls, fetchImpl };
}

test('sends what is due, records each outcome, never sends a text another run claimed', async () => {
  const { calls, fetchImpl } = fakes();
  const r = await run(env, fetchImpl, () => {});
  assert.deepEqual(r, { due: 4, sent: 1, failed: 1, optedOut: 1, dryRun: false, more: false });
  assert.ok(calls[0].url.startsWith('https://drgwfjoirmgxwhclbaak.supabase.co/rest/v1/rpc/family_texts_due'), 'defaults to the CRM project');
  const texts = calls.filter((c) => c.url.startsWith('https://api.twilio.com')).map((c) => c.body).sort((a, b) => a.To.localeCompare(b.To));
  assert.deepEqual(texts.map((t) => t.To), ['+13055550101', '+13055550102', '+13055550103'], 'r4 was claimed by another run');
  assert.deepEqual(texts[0], { To: '+13055550101', Body: 'Hi Ana, balance $260.00', From: '+17865550000' });
  const results = calls.filter((c) => c.url.endsWith('/rpc/family_text_result')).map((c) => [c.body.p_id, c.body.p_status]).sort();
  assert.deepEqual(results, [['r1', 'sent'], ['r2', 'failed'], ['r3', 'opted_out']]);
  assert.match(calls.find((c) => c.url.endsWith('/rpc/family_text_result') && c.body.p_id === 'r2').body.p_error, /21211 Invalid To/);
});

test('without Twilio set up, nothing is claimed or sent', async () => {
  const { calls, fetchImpl } = fakes();
  const r = await run({ SUPABASE_SERVICE_ROLE_KEY: 'svc' }, fetchImpl, () => {});
  assert.deepEqual(r, { sent: 0, dryRun: true });
  assert.equal(calls.length, 0);
});

test('without the service key, does nothing', async () => {
  const { calls, fetchImpl } = fakes();
  assert.equal((await run({}, fetchImpl, () => {})).skipped, 'not configured');
  assert.equal(calls.length, 0);
});

test('stops starting texts when its time is up and says there are more', async () => {
  const { calls, fetchImpl } = fakes();
  const r = await run(env, fetchImpl, () => {}, { budgetMs: -1 });
  assert.deepEqual(r, { due: 4, sent: 0, failed: 0, optedOut: 0, dryRun: false, more: true });
  assert.equal(calls.filter((c) => c.url.endsWith('/rpc/family_text_claim')).length, 0, 'nothing claimed, so nothing is left half-sent');
});
