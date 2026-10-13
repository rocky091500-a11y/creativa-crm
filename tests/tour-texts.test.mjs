// Unit tests for netlify/functions/tour-texts.mjs and text-inbound.mjs with fake Supabase and Twilio.
// Run: node --test tests/tour-texts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../netlify/functions/tour-texts.mjs';
import { handle, signature } from '../netlify/functions/text-inbound.mjs';

const settings = {
  tour_reminder_text: 'Creativa: Hi {parent}! Tour tomorrow at {tour_time}. Reply STOP to opt out.',
  followup_text: 'Creativa: Hi {parent}, how did {child} like it?',
};
const due = [
  { kind: 'reminder', inquiry_id: 'i1', phone: '+13055550101', parent_name: 'Maria Lopez', child_name: 'Sofia', tour_at: '2026-10-10T15:00:00+00:00' },
  { kind: 'followup', inquiry_id: 'i2', phone: '+13055550102', parent_name: null, child_name: null, tour_at: '2026-10-02T14:00:00+00:00' },
  { kind: 'reminder', inquiry_id: 'i3', phone: '+13055550103', parent_name: 'Stopped', child_name: 'Y', tour_at: '2026-10-10T15:00:00+00:00' },
  { kind: 'reminder', inquiry_id: 'i4', phone: '+13055550104', parent_name: 'Broken', child_name: 'Y', tour_at: '2026-10-10T15:00:00+00:00' },
  { kind: 'reminder', inquiry_id: 'i5', phone: '+13055550105', parent_name: 'Taken', child_name: 'Y', tour_at: '2026-10-10T15:00:00+00:00' },
];
const env = { SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'svc', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MG9' };

function fakes() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const isForm = String(init.headers?.['content-type']).includes('urlencoded');
    calls.push({ url, init, body: init.body ? (isForm ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body)) : null });
    const json = (obj, status = 200) => new Response(obj === null ? null : JSON.stringify(obj), { status });
    if (url.endsWith('/rest/v1/rpc/tour_texts_due')) return json(due);
    if (url.includes('/rest/v1/settings')) return json([settings]);
    if (url.endsWith('/rest/v1/rpc/tour_text_claim')) return json(JSON.parse(init.body).p_inquiry !== 'i5');
    if (url.endsWith('/rest/v1/rpc/tour_text_result')) return json(null, 204);
    if (url === 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json') {
      const to = new URLSearchParams(init.body).get('To');
      if (to.endsWith('103')) return json({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }, 400);
      if (to.endsWith('104')) return json({ code: 21211, message: 'Invalid To' }, 400);
      return json({ sid: 'SM1' }, 201);
    }
    throw new Error('unexpected ' + url);
  };
  return { calls, fetchImpl };
}

test('texts what is due, records each outcome, skips texts another run already claimed', async () => {
  const { calls, fetchImpl } = fakes();
  const r = await run(env, fetchImpl, () => {});
  assert.deepEqual(r, { due: 5, sent: 2, failed: 1, optedOut: 1, dryRun: false });
  const texts = calls.filter((c) => c.url.startsWith('https://api.twilio.com')).map((c) => c.body);
  assert.equal(texts.length, 4, 'claimed-elsewhere text (i5) not sent');
  assert.deepEqual(texts[0], { To: '+13055550101', Body: 'Creativa: Hi Maria! Tour tomorrow at 11:00 AM. Reply STOP to opt out.', MessagingServiceSid: 'MG9' });
  assert.equal(texts[1].Body, 'Creativa: Hi, how did your little one like it?');
  const auth = calls.find((c) => c.url.startsWith('https://api.twilio.com')).init.headers.authorization;
  assert.equal(auth, 'Basic ' + Buffer.from('AC123:tok').toString('base64'));
  const results = calls.filter((c) => c.url.endsWith('rpc/tour_text_result')).map((c) => [c.body.p_inquiry, c.body.p_status]);
  assert.deepEqual(results, [['i1', 'sent'], ['i2', 'sent'], ['i3', 'opted_out'], ['i4', 'failed']]);
  // every text is claimed before it is sent
  const order = calls.map((c) => (c.url.endsWith('tour_text_claim') ? 'claim:' + c.body.p_inquiry : c.url.startsWith('https://api.twilio') ? 'send:' + c.body.To.slice(-1) : null)).filter(Boolean);
  assert.deepEqual(order.slice(0, 4), ['claim:i1', 'send:1', 'claim:i2', 'send:2']);
});

test('uses TWILIO_FROM when there is no Messaging Service', async () => {
  const { calls, fetchImpl } = fakes();
  await run({ ...env, TWILIO_MESSAGING_SERVICE_SID: '', TWILIO_FROM: '+17865550000' }, fetchImpl, () => {});
  const first = calls.find((c) => c.url.startsWith('https://api.twilio.com')).body;
  assert.equal(first.From, '+17865550000');
  assert.equal(first.MessagingServiceSid, undefined);
});

test('without Twilio settings it only logs (dry run): nothing claimed or sent', async () => {
  const { calls, fetchImpl } = fakes();
  const lines = [];
  const r = await run({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'svc' }, fetchImpl, (l) => lines.push(l));
  assert.equal(r.dryRun, true);
  assert.equal(r.sent, 0);
  assert.ok(!calls.some((c) => c.url.includes('twilio') || c.url.includes('tour_text_claim')));
  assert.ok(lines.some((l) => l.includes('would text reminder to +13055550101')));
});

// ── incoming texts ──
const HOOK = 'https://crm.creativaacademy.com/.netlify/functions/text-inbound';
const inboundEnv = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', TWILIO_AUTH_TOKEN: '12345' };
function twilioRequest(params, { token = '12345', url = HOOK } = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature(token, url, params) },
    body: new URLSearchParams(params).toString(),
  });
}
function dbFake(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { calls, fetchImpl };
}

test('signature matches the official twilio library', () => {
  // value checked with twilio.validateRequest() from the twilio npm package (5.3.0)
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  assert.equal(signature('12345', 'https://example.com/myapp.php?foo=1&bar=2', params), 'vNe7KK2kJwCsxc9K3OLkkKB3qqI=');
});

test('a reply is logged in the CRM and forwarded to the front desk', async () => {
  const { calls, fetchImpl } = dbFake([{ inquiry_id: 'i1', parent_name: 'Maria <Lopez>', action: 'message' }]);
  const res = await handle(twilioRequest({ From: '+13055550101', Body: 'Can we come at 3 instead?', AccountSid: 'AC123' }),
    { ...inboundEnv, TEXT_FORWARD_TO: '+17865550000' }, fetchImpl, () => {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/xml');
  assert.deepEqual(calls[0].body, { p_from: '+13055550101', p_body: 'Can we come at 3 instead?' });
  assert.equal(await res.text(), '<?xml version="1.0" encoding="UTF-8"?><Response><Message to="+17865550000">'
    + 'Creativa text from Maria &lt;Lopez&gt; (+13055550101): Can we come at 3 instead?</Message></Response>');
});

test('STOP is recorded but not forwarded; no forward number means an empty reply', async () => {
  const stop = dbFake([{ inquiry_id: 'i1', parent_name: 'Maria', action: 'opt_out' }]);
  const r1 = await handle(twilioRequest({ From: '+13055550101', Body: 'STOP' }), { ...inboundEnv, TEXT_FORWARD_TO: '+17865550000' }, stop.fetchImpl, () => {});
  assert.equal(await r1.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assert.equal(stop.calls.length, 1);
  const msg = dbFake([{ inquiry_id: 'i1', parent_name: 'Maria', action: 'message' }]);
  const r2 = await handle(twilioRequest({ From: '+13055550101', Body: 'hi' }), inboundEnv, msg.fetchImpl, () => {});
  assert.equal(await r2.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

test('requests not signed by Twilio are refused and never reach the database', async () => {
  const { calls, fetchImpl } = dbFake([]);
  const forged = await handle(twilioRequest({ From: '+13055550101', Body: 'STOP' }, { token: 'wrong' }), inboundEnv, fetchImpl, () => {});
  assert.equal(forged.status, 403);
  const unsigned = await handle(new Request(HOOK, { method: 'POST', body: 'From=%2B1305&Body=x' }), inboundEnv, fetchImpl, () => {});
  assert.equal(unsigned.status, 403);
  const get = await handle(new Request(HOOK), inboundEnv, fetchImpl, () => {});
  assert.equal(get.status, 405);
  assert.equal(calls.length, 0);
});

test('if the database is down the reply is still forwarded', async () => {
  const fetchImpl = async () => new Response('down', { status: 500 });
  const lines = [];
  const res = await handle(twilioRequest({ From: '+13055550101', Body: 'hello' }), { ...inboundEnv, TEXT_FORWARD_TO: '+17865550000' }, fetchImpl, (l) => lines.push(l));
  assert.match(await res.text(), /<Message to="\+17865550000">Creativa text from \+13055550101: hello<\/Message>/);
  assert.ok(lines.some((l) => l.includes('could not log')));
});
