// Unit tests for netlify/functions/website-form.mjs with a fake Supabase.
// Run: node --test tests/website-form.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, sign, validSignature } from '../netlify/functions/website-form.mjs';

const SECRET = 'a-long-shared-secret-for-tests';
const env = { WEBSITE_FORM_SECRET: SECRET, SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_URL: 'https://db.example.com/' };
const submission = {
  id: '6720a1b2c3', form_name: 'schedule-tour', created_at: '2026-10-29T17:02:11.000Z', site_url: 'https://creativaacademy.com',
  data: { 'form-name': 'schedule-tour', 'parent-first-name': 'Nora', email: 'nora@example.com', phone: '7865550142', ip: '203.0.113.7' },
};
const request = (body, sig) => new Request('https://crm.example.com/.netlify/functions/website-form', {
  method: 'POST', body, headers: { 'content-type': 'application/json', ...(sig ? { 'x-webhook-signature': sig } : {}) },
});
function fakeSupabase(reply = 'saved', status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status });
  };
  return { calls, fetchImpl };
}
const quiet = () => {};

test('a signed submission goes to the CRM with its form, data, Netlify id and time', async () => {
  const body = JSON.stringify(submission);
  const { calls, fetchImpl } = fakeSupabase('saved');
  const res = await handle(request(body, sign(body, SECRET)), env, fetchImpl, quiet);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'saved');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://db.example.com/rest/v1/rpc/submit_inquiry_netlify');
  assert.equal(calls[0].init.headers.authorization, 'Bearer service-key');
  assert.deepEqual(calls[0].body, { p_form: 'schedule-tour', p_data: submission.data, p_netlify_id: '6720a1b2c3', p_received_at: submission.created_at });
});

test('no signature, a wrong secret, or a changed body: refused, nothing sent to the CRM', async () => {
  const body = JSON.stringify(submission);
  for (const [b, sig] of [[body, null], [body, sign(body, 'some-other-secret')], [body.replace('Nora', 'Eve'), sign(body, SECRET)], [body, 'x.y.z']]) {
    const { calls, fetchImpl } = fakeSupabase();
    const res = await handle(request(b, sig), env, fetchImpl, quiet);
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  }
  assert.equal(validSignature(sign(body, SECRET), body, SECRET), true);
  assert.equal(validSignature(sign(body, SECRET), body, ''), false);
});

test('a submission wrapped in {payload} is read too; the log says why one is refused', async () => {
  const body = JSON.stringify({ payload: submission });
  const { calls, fetchImpl } = fakeSupabase('saved');
  const res = await handle(request(body, sign(body, SECRET)), env, fetchImpl, quiet);
  assert.equal(await res.text(), 'saved');
  assert.equal(calls[0].body.p_netlify_id, '6720a1b2c3');
  const logs = [];
  const plain = JSON.stringify(submission);
  await handle(request(plain, sign(plain, 'some-other-secret')), env, fakeSupabase().fetchImpl, (m) => logs.push(m));
  await handle(request(plain, null), env, fakeSupabase().fetchImpl, (m) => logs.push(m));
  assert.match(logs[0], /different secret/);
  assert.match(logs[1], /no X-Webhook-Signature/);
  assert.ok(logs.every((m) => !m.includes(SECRET)), 'the secret is never logged');
});

test('not set up yet: 503, and only POST', async () => {
  const body = JSON.stringify(submission);
  const { calls, fetchImpl } = fakeSupabase();
  assert.equal((await handle(request(body, sign(body, SECRET)), { SUPABASE_SERVICE_ROLE_KEY: 'k' }, fetchImpl, quiet)).status, 503);
  assert.equal((await handle(new Request('https://crm.example.com/x'), env, fetchImpl, quiet)).status, 405);
  assert.equal(calls.length, 0);
});

test('other Netlify forms are left alone', async () => {
  const body = JSON.stringify({ ...submission, form_name: 'newsletter', data: { 'form-name': 'newsletter', email: 'a@example.com' } });
  const { calls, fetchImpl } = fakeSupabase();
  const res = await handle(request(body, sign(body, SECRET)), env, fetchImpl, quiet);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test('the CRM unreachable: 502 so Netlify tries again (the CRM never saves it twice)', async () => {
  const body = JSON.stringify(submission);
  const { fetchImpl } = fakeSupabase({ message: 'down' }, 500);
  assert.equal((await handle(request(body, sign(body, SECRET)), env, fetchImpl, quiet)).status, 502);
});
