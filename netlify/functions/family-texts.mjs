// Sends the texts staff write on the CRM's Messages page (public.message_recipients) through Twilio: the same
// account, number and environment variables as the tour texts (see tour-texts.mjs). Called by the CRM right after
// someone taps Send, and every hour by family-texts-hourly.mjs for texts scheduled for later. Only texts staff
// queued in the CRM are sent; the database decides what's due (never before 8am or from 9pm Miami time) and skips
// numbers that replied STOP. Without the Twilio variables it sends nothing and leaves the texts queued.
// Each run stops starting new texts after budgetMs, so it ends inside Netlify's time limit; `more: true` tells the
// CRM to call again (it does, until everything due has gone).

const DEFAULT_SUPABASE_URL = 'https://drgwfjoirmgxwhclbaak.supabase.co';
const MAX_PER_RUN = 100;
const AT_ONCE = 4;          // texts sent side by side
const OPTED_OUT = 21610; // Twilio: "Attempt to send to unsubscribed recipient"

export async function run(env, fetchImpl = fetch, log = console.log, { budgetMs = 6000 } = {}) {
  const started = Date.now();
  const base = (env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) { log('family-texts: SUPABASE_SERVICE_ROLE_KEY not set; nothing to do'); return { sent: 0, skipped: 'not configured' }; }
  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN;
  const sender = env.TWILIO_MESSAGING_SERVICE_SID ? { MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID }
    : env.TWILIO_FROM ? { From: env.TWILIO_FROM } : null;
  const rpc = async (name, args) => {
    const res = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  if (!(sid && token && sender)) {
    log('family-texts: Twilio is not set up (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM); texts stay queued');
    return { sent: 0, dryRun: true };
  }
  const due = await rpc('family_texts_due', { p_limit: MAX_PER_RUN });
  const result = { due: due.length, sent: 0, failed: 0, optedOut: 0, dryRun: false, more: due.length === MAX_PER_RUN };
  const sendOne = async (row) => {
    if (!(await rpc('family_text_claim', { p_id: row.id }))) return;   // another run has it
    let status = 'failed', error = null;
    try {
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: row.phone, Body: row.body, ...sender }).toString(),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok) status = 'sent';
      else if (out.code === OPTED_OUT) status = 'opted_out';
      else error = `Twilio ${res.status} ${out.code || ''} ${out.message || ''}`.trim();
    } catch (e) {
      error = e.message;
    }
    if (error) log(`family-texts: text to ${row.phone} failed: ${error}`);
    result[{ sent: 'sent', failed: 'failed', opted_out: 'optedOut' }[status]] += 1;
    try {
      await rpc('family_text_result', { p_id: row.id, p_status: status, p_error: error });
    } catch (e) {
      log(`family-texts: could not record ${status} for ${row.id}: ${e.message}`);
    }
  };
  const queue = [...due];
  const worker = async () => {
    while (queue.length) {
      if (Date.now() - started > budgetMs) { result.more = true; return; }
      await sendOne(queue.shift());
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  log(`family-texts: ${JSON.stringify(result)}`);
  return result;
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const result = await run(process.env);
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};
