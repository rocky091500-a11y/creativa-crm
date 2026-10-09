// Hourly job (Netlify Scheduled Function): emails families the day before their tour, and a
// "how was your visit?" note a week after it if nobody has heard from them since.
// Which emails are due is decided in the database (public.tour_emails_due); the wording comes
// from the CRM's Settings page. Emails go out through Resend (resend.com).
//
// Netlify environment variables (Site configuration → Environment variables):
//   SUPABASE_URL                https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   Supabase → Settings → API → service_role (server-side only, never in config.js)
//   RESEND_API_KEY              from resend.com, after verifying creativaacademy.com there
//   REMINDER_FROM               e.g. Creativa Academy <hello@creativaacademy.com>
//   REMINDER_REPLY_TO           optional: where parents' replies go, e.g. the office inbox
// Without RESEND_API_KEY the job only logs what it would send.

export const config = { schedule: '@hourly' };

const TZ = 'America/New_York';
const MAX_PER_RUN = 50;

const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || '';

export function render(template, row) {
  const at = new Date(row.tour_at);
  const parent = firstName(row.parent_name);
  const child = firstName(row.child_name);
  const values = {
    child: child || 'your little one',
    child_es: child || 'su peque',
    tour_date: at.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' }),
    tour_date_es: at.toLocaleDateString('es-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' }),
    tour_time: at.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }),
  };
  // "Hi {parent}," becomes "Hi," when the form had no parent name.
  return String(template || '')
    .replace(/ ?\{parent\}/g, parent ? ` ${parent}` : '')
    .replace(/\{(child|child_es|tour_date|tour_date_es|tour_time)\}/g, (_, k) => values[k]);
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toHtml = (text) => `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#3B4430">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;

export async function run(env, fetchImpl = fetch, log = console.log) {
  const base = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) { log('tour-emails: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; nothing to do'); return { sent: 0, skipped: 'not configured' }; }
  const db = async (pathname, init = {}) => {
    const res = await fetchImpl(`${base}/rest/v1/${pathname}`, {
      ...init,
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`${pathname}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };

  const [due, settingsRows] = await Promise.all([
    db('rpc/tour_emails_due', { method: 'POST', body: '{}' }),
    db('settings?id=eq.1&select=*'),
  ]);
  const settings = settingsRows[0] || {};
  const result = { due: due.length, sent: 0, failed: 0, dryRun: !env.RESEND_API_KEY };

  for (const row of due.slice(0, MAX_PER_RUN)) {
    const subject = render(row.kind === 'reminder' ? settings.tour_reminder_subject : settings.followup_subject, row);
    const text = render(row.kind === 'reminder' ? settings.tour_reminder_body : settings.followup_body, row);
    if (!env.RESEND_API_KEY) { log(`tour-emails (dry run): would send ${row.kind} to ${row.email}: ${subject}`); continue; }
    try {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
          // A retry within 24h (say, if stamping below failed) won't email the family twice.
          'idempotency-key': `${row.kind}-${row.inquiry_id}-${row.tour_at}`,
        },
        body: JSON.stringify({
          from: env.REMINDER_FROM || 'Creativa Academy <hello@creativaacademy.com>',
          to: [row.email],
          ...(env.REMINDER_REPLY_TO ? { reply_to: env.REMINDER_REPLY_TO } : {}),
          subject, text, html: toHtml(text),
        }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status} ${await res.text()}`);
      await db('rpc/tour_email_sent', { method: 'POST', body: JSON.stringify({ p_inquiry: row.inquiry_id, p_kind: row.kind, p_to: row.email }) });
      result.sent += 1;
    } catch (e) {
      result.failed += 1;
      log(`tour-emails: ${row.kind} to ${row.email} failed: ${e.message}`);
    }
  }
  log(`tour-emails: ${JSON.stringify(result)}`);
  return result;
}

export default async () => {
  const result = await run(process.env);
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};
