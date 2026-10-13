// Hourly job (Netlify Scheduled Function): texts families the day before their tour, and a
// "how was your visit?" text a week after it to families the follow-up email can't reach.
// Which texts are due is decided in the database (public.tour_texts_due); the wording comes from
// the CRM's Settings page (same {parent} / {tour_date} … placeholders as the emails). Texts go out
// through Twilio.
//
// Netlify environment variables (Site configuration → Environment variables), besides the
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY the email job already uses:
//   TWILIO_ACCOUNT_SID             Twilio Console → Account info (starts with AC)
//   TWILIO_AUTH_TOKEN              Twilio Console → Account info (also checks incoming replies)
//   TWILIO_MESSAGING_SERVICE_SID   the Messaging Service linked to the approved A2P 10DLC campaign (MG…)
//   TWILIO_FROM                    or, instead of the Messaging Service, the number itself: +17865550123
// Without the Twilio variables the job only logs what it would send.

import { render } from './tour-emails.mjs';

export const config = { schedule: '@hourly' };

const MAX_PER_RUN = 50;
const OPTED_OUT = 21610; // Twilio: "Attempt to send to unsubscribed recipient"

export async function run(env, fetchImpl = fetch, log = console.log) {
  const base = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) { log('tour-texts: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; nothing to do'); return { sent: 0, skipped: 'not configured' }; }
  const db = async (pathname, init = {}) => {
    const res = await fetchImpl(`${base}/rest/v1/${pathname}`, {
      ...init,
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`${pathname}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  const rpc = (name, args) => db(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });

  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN;
  const sender = env.TWILIO_MESSAGING_SERVICE_SID ? { MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID }
    : env.TWILIO_FROM ? { From: env.TWILIO_FROM } : null;
  const live = Boolean(sid && token && sender);

  const [due, settingsRows] = await Promise.all([rpc('tour_texts_due', {}), db('settings?id=eq.1&select=*')]);
  const settings = settingsRows[0] || {};
  const result = { due: due.length, sent: 0, failed: 0, optedOut: 0, dryRun: !live };

  for (const row of due.slice(0, MAX_PER_RUN)) {
    const body = render(row.kind === 'reminder' ? settings.tour_reminder_text : settings.followup_text, row).trim();
    if (!body) { log(`tour-texts: ${row.kind} wording is empty; skipped`); continue; }
    if (!live) { log(`tour-texts (dry run): would text ${row.kind} to ${row.phone}: ${body}`); continue; }
    // Claim first: if two runs overlap, or the result can't be saved, a family is never texted twice.
    if (!(await rpc('tour_text_claim', { p_inquiry: row.inquiry_id, p_kind: row.kind }))) continue;
    let status = 'failed';
    try {
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: row.phone, Body: body, ...sender }).toString(),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok) status = 'sent';
      else if (out.code === OPTED_OUT) status = 'opted_out';
      else throw new Error(`Twilio ${res.status} ${out.code || ''} ${out.message || ''}`.trim());
    } catch (e) {
      log(`tour-texts: ${row.kind} to ${row.phone} failed: ${e.message}`);
    }
    result[{ sent: 'sent', failed: 'failed', opted_out: 'optedOut' }[status]] += 1;
    try {
      await rpc('tour_text_result', { p_inquiry: row.inquiry_id, p_kind: row.kind, p_to: row.phone, p_status: status });
    } catch (e) {
      log(`tour-texts: could not record ${status} ${row.kind} for ${row.inquiry_id}: ${e.message}`);
    }
  }
  log(`tour-texts: ${JSON.stringify(result)}`);
  return result;
}

export default async () => {
  const result = await run(process.env);
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};
