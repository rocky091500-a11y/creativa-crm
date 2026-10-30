// Netlify sends its copy of every website form here, so a request that reaches Telegram also reaches the CRM even when
// the copy from the family's browser didn't (an expired robot check, a dropped connection). The CRM saves it only if it
// doesn't already have it (public.submit_inquiry_netlify, 028_website_form_backup.sql).
//
// On the WEBSITE's Netlify site: Site configuration → Forms → Form notifications → Add notification → Outgoing webhook:
//   Event: New form submission · URL: https://crm.creativaacademy.com/.netlify/functions/website-form · Form: Any form
//   JWS secret token: the same long random text as WEBSITE_FORM_SECRET below.
//
// Netlify environment variables (the CRM's site): SUPABASE_SERVICE_ROLE_KEY, WEBSITE_FORM_SECRET, and optionally
// SUPABASE_URL (defaults to the CRM's project). Requests without a valid signature are refused.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_SUPABASE_URL = 'https://drgwfjoirmgxwhclbaak.supabase.co';
const FORMS = new Set(['schedule-tour', 'waitlist', 'contact', 'bloom-interest', 'family-support']);

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Netlify signs each webhook with a JWS (HS256) whose payload is {"iss": "netlify", "sha256": <hex SHA-256 of the body>}.
export function validSignature(jws, body, secret) {
  const parts = String(jws || '').split('.');
  if (parts.length !== 3 || !secret) return false;
  const want = Buffer.from(b64url(createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest()));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  try {
    const header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    const claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    return header.alg === 'HS256' && claims.iss === 'netlify'
      && claims.sha256 === createHash('sha256').update(body).digest('hex');
  } catch {
    return false;
  }
}

// For tests: what Netlify would put in the X-Webhook-Signature header.
export function sign(body, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: 'netlify', sha256: createHash('sha256').update(body).digest('hex') }));
  return `${head}.${claims}.${b64url(createHmac('sha256', secret).update(`${head}.${claims}`).digest())}`;
}

export async function handle(req, env, fetchImpl = fetch, log = console.log) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.WEBSITE_FORM_SECRET || !env.SUPABASE_SERVICE_ROLE_KEY) {
    log('website-form: WEBSITE_FORM_SECRET / SUPABASE_SERVICE_ROLE_KEY not set');
    return new Response('Not configured', { status: 503 });
  }
  const body = await req.text();
  if (!validSignature(req.headers.get('x-webhook-signature'), body, env.WEBSITE_FORM_SECRET)) {
    log('website-form: refused a request without a valid Netlify signature');
    return new Response('Forbidden', { status: 403 });
  }
  let sub;
  try { sub = JSON.parse(body); } catch { return new Response('Bad request', { status: 400 }); }
  const data = sub && typeof sub.data === 'object' && sub.data ? sub.data : {};
  const form = sub?.form_name || data['form-name'] || '';
  if (!FORMS.has(form)) return new Response('Not a CRM form');
  if (!sub.id) return new Response('Bad request', { status: 400 });

  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '')}/rest/v1/rpc/submit_inquiry_netlify`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_form: form, p_data: data, p_netlify_id: String(sub.id), p_received_at: sub.created_at || null }),
  });
  if (!res.ok) {
    // Netlify tries again later, and the CRM won't save it twice.
    log(`website-form: the CRM didn't take ${form} ${sub.id}: ${res.status} ${await res.text()}`);
    return new Response('Try again later', { status: 502 });
  }
  const result = await res.json();
  log(`website-form: ${form} ${sub.id}: ${result}`);
  return new Response(String(result));
}

export default (req) => handle(req, process.env);
