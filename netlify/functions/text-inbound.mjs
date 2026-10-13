// Twilio calls this when a family texts the school's Twilio number (usually a reply to a tour text).
// The text is logged on that family's timeline in the CRM; STOP / START opt the number out / back in
// (Twilio itself sends the "you're unsubscribed" confirmation). With TEXT_FORWARD_TO set, other
// replies are also forwarded to that phone (e.g. the front-desk cell) so someone sees them right away.
//
// Twilio Console → Messaging → Services → (the service) → Integration → "Send a webhook":
//   https://crm.creativaacademy.com/.netlify/functions/text-inbound   (HTTP POST)
//
// Netlify environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_AUTH_TOKEN (to check
// that each request really comes from Twilio), and optionally
//   TEXT_FORWARD_TO      +17865550123
//   TWILIO_WEBHOOK_URL   only if the address above is different (it must match Twilio's exactly)

import { createHmac, timingSafeEqual } from 'node:crypto';

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const twiml = (inner = '') => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`,
  { headers: { 'content-type': 'text/xml' } });

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export function signature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}
function validSignature(authToken, url, params, given) {
  const want = Buffer.from(signature(authToken, url, params));
  const got = Buffer.from(String(given || ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

export async function handle(req, env, fetchImpl = fetch, log = console.log) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.TWILIO_AUTH_TOKEN || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    log('text-inbound: TWILIO_AUTH_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    return new Response('Not configured', { status: 503 });
  }
  const params = Object.fromEntries(new URLSearchParams(await req.text()));
  const url = env.TWILIO_WEBHOOK_URL || req.url;
  if (!validSignature(env.TWILIO_AUTH_TOKEN, url, params, req.headers.get('x-twilio-signature'))) {
    log(`text-inbound: refused a request with a bad Twilio signature (checked against ${url})`);
    return new Response('Forbidden', { status: 403 });
  }
  const from = params.From || '', body = params.Body || '';
  if (!from) return twiml();

  let who = null;
  try {
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/text_inbound`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_from: from, p_body: body }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    who = (await res.json())[0] || null;
  } catch (e) {
    log(`text-inbound: could not log the text from ${from}: ${e.message}`);
  }
  if (who && !who.inquiry_id) log(`text-inbound: text from ${from}, not a number in the CRM (${who.action})`);

  // STOP / START are answered by Twilio itself; just forward ordinary messages.
  const forwardTo = env.TEXT_FORWARD_TO;
  if (!forwardTo || forwardTo === from || (who && who.action !== 'message')) return twiml();
  const label = who?.parent_name ? `${who.parent_name} (${from})` : from;
  return twiml(`<Message to="${xml(forwardTo)}">${xml(`Creativa text from ${label}: ${body}`.slice(0, 1200))}</Message>`);
}

export default (req) => handle(req, process.env);
