# Creativa CRM

Enrollment pipeline for Creativa Academy staff — every tour request, waitlist sign-up and
contact form from creativaacademy.com lands here, and staff move each family from
**New → Contacted → Tour scheduled (→ Reschedule) → Toured → Waitlisted / Enrolled / Lost**.

- **Today** — follow-ups due, upcoming tours, tours to reschedule, new inquiries not yet contacted
- **Pipeline** — drag families between stages
- **All inquiries** — search (names, email, any phone format), filter, download CSV
- **Inquiry drawer** — call/text/email buttons, every form field, notes & call log, full original submission
- **Enrollment** — every student by class (enrolled, waiting list, withdrawn), class counts against capacity,
  documents received (registration packet, blue form, yellow form, birth certificate), RBT/therapies, registration fee
- **Tuition** (finance access) — each month: who has paid, partly paid or owes; record payments; print receipts
  (one at a time, or every FES-UA receipt for the month at once for reimbursement uploads)
- **Reports** (finance access) — money received per month, by who paid / method / class, the school year at a
  glance, and who is on School Readiness, SR – BPIECE, FES-UA (with award IDs), FES-EO, VPK or private pay
- **Settings** (admins) — staff access and finance access, classes and teachers, receipt address line, tour email
  wording, Telegram alerts, spam protection (blocked senders), and the tour calendar link
- **Telegram alerts** — each new website request is sent to a Telegram chat the moment it arrives
- **Tour calendar** — every scheduled tour as a private calendar feed for Google Calendar or phones
- **Tour emails** — a reminder the day before each tour, and a “how was your visit?” email a week later if
  nobody has heard from the family (English + Spanish)

Plain HTML/CSS/JS, no build step. Data and logins live in Supabase; hosted on Netlify.

## How it fits together

```
creativaacademy.com form ──► Netlify Forms (email notifications, unchanged)
            │
            └─ js/crm-capture.js ──► Supabase submit_inquiry() ──► inquiries table
                                                                      ▲
crm.creativaacademy.com (this repo) ── staff login ── row-level security ┘
```

- The website only has the public **anon** key, which can do exactly one thing: call
  `submit_inquiry()` for the five enrollment forms. It cannot read anything.
- A new login sees nothing until an admin switches it **Active**. Only admins delete
  inquiries or change staff access, and nobody can change their own role.
- Resubmitting the same form within 2 minutes updates the first record instead of
  creating a duplicate. Bots that fill the honeypot field and floods are dropped.
- Parents' Night Out forms are not sent to the CRM.

## One-time setup

1. **Supabase project** — create one at supabase.com (US East). Then:
   - SQL Editor → paste and run `supabase/migrations/001_init.sql`, then `002_calendar_feed.sql`,
     then `003_enrollment_finance.sql`, `004_turnstile.sql` and `005_reschedule_telegram_spam.sql`, in that order.
   - Authentication → Sign In / Providers → turn **off** "Allow new users to sign up"
     (staff are invited, nobody signs themselves up).
   - Authentication → URL Configuration → Site URL `https://crm.creativaacademy.com`,
     and add `https://crm.creativaacademy.com/*` to Redirect URLs.
2. **Keys** — Settings → API. Put the Project URL and the **anon public** key in
   `config.js` here and in `js/crm-capture.js` in the website repo. Never use the
   service_role key in either place.
3. **First admin** — Authentication → Users → Invite user (your email). Accept the
   email, set a password, then run in the SQL Editor:
   ```sql
   update public.profiles set role = 'admin', active = true where email = 'you@example.com';
   ```
4. **Netlify** — new site from this repo (no build command, publish directory `.`),
   then Domain management → add `crm.creativaacademy.com`.
5. **Staff** — invite each person from Supabase (Authentication → Users → Invite user),
   then switch them **Active** on the CRM's Staff page.

## Tour calendar (Google Calendar)

`supabase/migrations/002_calendar_feed.sql` adds a private iCalendar feed of scheduled tours
(45-minute events, from 60 days back onward, families marked Lost left out). Admins copy the
link from the Staff page and add it in Google Calendar under **Other calendars → + → From URL**.

- The link carries a secret token; only admins can read it, and **Reset link** replaces it
  (the old link stops working at once). Anyone with the link can see tour names and phones.
- Google refreshes subscribed calendars on its own schedule (typically every few hours),
  so new tours show up there with a delay. The CRM is always current.
- The feed is `rpc/tours_ics`, which returns the `"*/*"` domain so PostgREST serves raw
  `text/calendar` whatever Accept header the calendar app sends.

## Finance access

Tuition, payments, receipts, award IDs and reports are hidden from regular staff. On **Settings**, give a person
**Finances: View only** (sees tuition, payments and totals) or **View & record** (also records payments, prints
receipts and sets tuition). Admins always have both. The database enforces this, not just the screen.

- Each student's tuition is what the family is expected to pay, monthly, biweekly (counted as 2 a month) or weekly
  (4 a month). Payments from the family, School Readiness, FES, VPK or others all count toward the month they are for.
- Receipt numbers are assigned by the database in order and can't be edited. A student with payments can't be
  deleted; set them to Withdrawn instead.
- A student on no funding program is **private pay**. SR – BPIECE students are School Readiness students too
  (ticking BPIECE ticks School Readiness).
- Receipts print in the style of the Programs & Hours sheet; the address line at the bottom is set on Settings.
- The 2026-27 roster was loaded with a one-time SQL import kept outside this repository. This repository is public:
  never commit student names, birthdays or award IDs to it.

## Tour emails

`netlify/functions/tour-emails.mjs` runs every hour on Netlify. The database (`tour_emails_due()`) decides what is due,
in Miami time:

- **Reminder**: the day before the tour, from 9am, while the family is still at *Tour scheduled*.
- **Follow-up**: 7–10 days after the tour, from 10am, if they are still at *Tour scheduled* or *Toured* and nobody
  has logged a call, email or text with them since the tour.

Each email goes once per tour (a new tour time sends again) and is logged on the family's timeline. Admins edit the
wording, or switch the emails off, on **Settings**; staff can switch them off for one family in its inquiry. Families
with no email address show on the Today page with a **Text** button that opens a ready-written text message.

One-time setup:
1. **Resend** — sign up at resend.com, add the domain `creativaacademy.com` and add the DNS records it shows, then
   create an API key.
2. **Netlify** → Site configuration → Environment variables:
   - `SUPABASE_URL` — `https://drgwfjoirmgxwhclbaak.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Settings → API → `service_role` (server-side only; never in `config.js`)
   - `RESEND_API_KEY`
   - `REMINDER_FROM` — e.g. `Creativa Academy <hello@creativaacademy.com>`
   - `REMINDER_REPLY_TO` (optional) — the inbox where parents' replies should go
3. Redeploy. Netlify → Logs → Functions → `tour-emails` shows each run. Without `RESEND_API_KEY` it only logs what it
   would send.

## "Are you human" check (Cloudflare Turnstile)

`supabase/migrations/004_turnstile.sql` puts Cloudflare Turnstile in front of website intake:
`submit_inquiry()` asks Cloudflare whether each submission's token is genuine before saving it,
so bots are refused whether they use the forms or call the CRM directly. Refusals are counted in
`intake_blocked` (form + reason only, no personal data).

- The website (`js/crm-capture.js` in the website repo) shows the check on the five enrollment
  forms (usually invisible) and holds a submit for a moment if the check hasn't finished.
- The **secret key** lives only in Supabase Vault: `select vault.create_secret('…', 'turnstile_secret_key');`
  Until it is stored nothing is checked. To change it: `update vault.secrets set secret = '…' where name = 'turnstile_secret_key';`
- If Cloudflare can't be reached, submissions are let through (an outage never loses a family).
- Spam blocked in the last 30 days:
  `select form, reason, count(*) from intake_blocked where created_at > now() - interval '30 days' group by 1, 2;`

- **Spam protection (005)**: on top of the robot check, every website request is refused if its email, phone or
  device (IP address) is on the blocked list, or if that device already sent 5 requests in the past hour. An admin
  presses **Spam** on an inquiry to delete it and block its email, phone and device; Settings → Spam protection
  lists who is blocked (unblock or add an email/phone by hand) and what was stopped in the last 30 days.
  `005` also shortens the robot check's wait to 1.5 s so a slow Cloudflare can't push a request past Supabase's
  3-second limit for website calls. Run migrations in order and don't re-run `004` after `005` (it would put back
  004's intake without these checks).
- The website's five forms declare their hidden `bot-field` to Netlify (`netlify-honeypot`), so Netlify's copy also
  drops bots that fill it in.

## Telegram alerts

`005_reschedule_telegram_spam.sql` sends each new website request to Telegram as soon as it is saved: tour
requests, waitlist, contact, Bloom and family support (choose which on Settings). Only requests that passed the
robot check and aren't from a blocked sender get this far, staff-added inquiries are never sent, and a resubmit
within 2 minutes doesn't send twice. The alert is queued with Supabase's `pg_net` and goes out in the background
once the request is saved, so a slow or broken Telegram never holds up the form or loses a request; Telegram's
answer (delivered, or its error) shows on Settings.

Once alerts work, turn off Netlify's own form emails (Netlify → Site configuration → Forms → Form notifications).
Netlify keeps an unfiltered copy of every submission and its emails skip the robot check and the blocked list;
Telegram only gets requests that passed them. Netlify still keeps the copies as a backup.

Setup (Settings → Telegram alerts, admins): create a bot with **@BotFather** (`/newbot`) or reuse an existing one,
paste its token, send the bot a message (or add it to the staff group), press **Find chat**, pick the chat, **Save**,
then **Send test**. The token is stored in Supabase Vault (`telegram_bot_token`), never in a table or the browser.

## Tours to reschedule

Move a family to **Reschedule** (Pipeline, or the stage picker) when their tour has to move. They show on Today
under *Tours to reschedule* with the old time and call/text buttons, leave the tour calendar, and get no reminder
email. Moving them back to *Tour scheduled* asks for the new date and time.

## Tests

```bash
# Database rules (intake mapping, spam handling, who can see/change what, calendar feed,
# roster/finance access, receipts, which tour emails are due, Turnstile, reschedule,
# Telegram alerts, blocked senders and the per-device limit)
PGHOST=... PGPORT=... PGUSER=postgres tests/run-db-tests.sh

# Tour email job (fake Supabase and Resend)
node --test tests/tour-emails.test.mjs

# Full browser walkthrough: Postgres + PostgREST + headless Chromium
POSTGREST=/path/to/postgrest SUPABASE_JS=/path/to/supabase.min.js \
PGHOST=... PGPORT=... PGUSER=postgres tests/e2e/run.sh
```

`tests/supabase-stub.sql` stands in for the bits of Supabase the migration needs
(`auth.users`, `auth.uid()`, the `anon`/`authenticated` roles).

## Changing things

- **Stages** live in three places that must match: the `check` constraint and the
  `labels` in `inquiries_log()` (latest in `005_reschedule_telegram_spam.sql`), and `STAGES`/`STAGE_LABEL` in `app.js`.
  Add a new numbered migration rather than editing one that has already been run.
- **Funding programs, payment methods and documents** live in the `check` constraints in `003_enrollment_finance.sql`
  and `FUNDING` / `PAYER` / `METHOD` / `DOCS` in `app.js`.
- **Website form fields** are mapped in `submit_inquiry()`. Every submission is also
  kept untouched in `inquiries.raw`, so nothing is lost if a field isn't mapped.
