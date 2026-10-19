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
- **Tuition** (finance access) — biweekly billing: bill everyone for the period in one tap, see who has paid, is late
  or is Step Up pending, record payments against invoices, keep and apply credits, see everything still owed, and
  print receipts (one at a time, or every FES-UA receipt for the period at once for reimbursement uploads)
- **Reports** (finance access) — money received per month, by who paid / method / class, the school year at a
  glance, and who is on School Readiness, SR – BPIECE, FES-UA (with award IDs), FES-EO, VPK or private pay
- **Payroll** (payroll access) — a time clock for the front-desk tablet (`/clock/`: tap your name, type a PIN, clock
  in / lunch / back / out), each pay period's regular and overtime hours per person, timesheets the office can fix,
  missed clock-outs flagged, and a sheet of hours to type into Patriot Software
- **Settings** (admins) — staff, finance and payroll access, classes and teachers, receipts (signer, license number,
  signature, address line), tour email wording, Telegram alerts, spam protection (blocked senders), and the tour
  calendar link
- **Telegram alerts** — each new website request is sent to a Telegram chat the moment it arrives
- **Tour calendar** — every scheduled tour as a private calendar feed for Google Calendar or phones
- **Tour emails** — a reminder the day before each tour, and a “how was your visit?” email a week later if
  nobody has heard from the family (English + Spanish)
- **Tour texts** — the same reminders by text message through Twilio; families' replies land on their timeline,
  STOP is honored automatically
- **Messages** (admins and staff who record payments) — texts to enrolled families: everyone, one class, families
  who owe or are late (their balance filled in), or families you pick; send now or later, see who got it

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
     then `003_enrollment_finance.sql`, `004_turnstile.sql`, `005_text_reminders.sql`,
     `006_reschedule_telegram_spam.sql`, `007_billing_contacts.sql`, `008_payroll_timeclock.sql`, `009_tax_statements.sql`, `010_billing_history.sql`, `011_graduated_earlier_payments.sql`, `012_change_log.sql`, `013_family_texts.sql`, `014_message_templates.sql`, `015_message_lists.sql`, `016_paychecks.sql`, `017_money_food_program_todos.sql`, `018_weekly_late_fees.sql`, `019_projection.sql`, `020_class_rates_and_bills.sql`, `021_school_calendar.sql`, `022_pins_on_file.sql` and `023_registration.sql`, in that order.
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
2. **Netlify** (the CRM site) → Site configuration → Environment variables — just two:
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API Keys → Legacy API Keys → `service_role`
     (server-side only; never in `config.js`)
   - `RESEND_API_KEY` — the `re_…` key from Resend

   Emails come from `Creativa Academy <info@creativaacademy.com>` and replies go to `info@creativaacademy.com`.
   To change that, add `REMINDER_FROM` / `REMINDER_REPLY_TO`; `SUPABASE_URL` can override the built-in project URL.
3. Redeploy. Netlify → Logs → Functions → `tour-emails` shows each run. Without `RESEND_API_KEY` it only logs what it
   would send.

## Tour texts (Twilio)

`supabase/migrations/005_text_reminders.sql` and `netlify/functions/tour-texts.mjs` (hourly) send the tour reminders
by text too, on the email schedule but only between 9am and 8pm Miami time:

- **Reminder text**: the day before the tour, to every family at *Tour scheduled* with a US phone number.
- **Follow-up text**: 7–10 days after the tour, only to families with no email address (everyone else gets the
  follow-up email), and only if nobody has logged a call, email or text with them since — a reply by text counts.

Each text goes once per tour and is logged on the timeline. The per-family switch in the inquiry turns off emails and
texts together. Admins edit the wording, or switch texts off, on **Settings → Automatic text messages** (off until
Twilio is ready).

Replies: `netlify/functions/text-inbound.mjs` receives every text sent to the school's Twilio number, checks it really
came from Twilio, and logs it on that family's timeline. **STOP** (or UNSUBSCRIBE, CANCEL, END, QUIT, PARAR) adds the
number to `text_opt_outs` and it is never texted automatically again; **START** undoes it. Twilio sends the opt-out
confirmation itself. With `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set, every reply (and every STOP) is also
posted to that Telegram chat, which is free; with `TEXT_FORWARD_TO` set, ordinary replies are also texted on to that phone
(one more text each).

One-time setup:
1. **Twilio** — create an account at twilio.com, upgrade it (trial accounts can only text verified numbers) and buy
   a local Miami number (305/786).
2. **A2P 10DLC registration** (required by US carriers for business texting; approval takes a few days to a couple
   of weeks). Twilio Console → Messaging → Regulatory compliance → A2P 10DLC:
   - **Brand**: Creativa Academy's legal name, EIN, address and website.
   - **Campaign**: use case *Customer care* (or *Mixed*). Description: “Tour reminders and follow-ups for families who
     requested a tour of our preschool.” Sample message: the reminder text from Settings.
     Opt-in: “Parents enter their phone number on the tour, waitlist or contact form at creativaacademy.com, next to a
     notice that we may text them about their inquiry and tour (link to creativaacademy.com/privacy/).” Opt-out: STOP.
     Privacy policy: `https://creativaacademy.com/privacy/`.
   - Create a **Messaging Service**, add the number to it, and link it to the campaign.
3. In the Messaging Service → **Integration**: “Send a webhook”, Request URL
   `https://crm.creativaacademy.com/.netlify/functions/text-inbound`, method POST.
4. **Netlify** → Site configuration → Environment variables (besides `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`):
   - `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` — Twilio Console → Account info
   - `TWILIO_MESSAGING_SERVICE_SID` — the Messaging Service (starts with `MG`); or `TWILIO_FROM` = the number
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (optional, free) — the same bot and chat the website uses
   - `TEXT_FORWARD_TO` (optional) — e.g. the front-desk cell, `+17865550123`
5. Redeploy, run `005_text_reminders.sql` in the Supabase SQL Editor, then switch texts on in **Settings**.
   Netlify → Logs → Functions → `tour-texts` shows each run; without the Twilio variables it only logs what it would send.

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

- **Spam protection (006)**: on top of the robot check, every website request is refused if its email, phone or
  device (IP address) is on the blocked list, or if that device already sent 5 requests in the past hour. An admin
  presses **Spam** on an inquiry to delete it and block its email, phone and device; Settings → Spam protection
  lists who is blocked (unblock or add an email/phone by hand) and what was stopped in the last 30 days.
  `006` also shortens the robot check's wait to 1.5 s so a slow Cloudflare can't push a request past Supabase's
  3-second limit for website calls. Run migrations in order and don't re-run `004` after `006` (it would put back
  004's intake without these checks).
- The website's five forms declare their hidden `bot-field` to Netlify (`netlify-honeypot`), so Netlify's copy also
  drops bots that fill it in.

## Billing (007)

`007_billing_contacts.sql` follows the school's billing rules: each child is invoiced their biweekly rate every other
Monday (the first billing Monday is 2026-10-05, set in `settings.billing_anchor`), due that day with grace until
Friday. On **Tuition**, **Bill this period** creates the period's invoices (`create_period_invoices`); it skips
children already billed, with no rate, marked *not billed to the family* (e.g. FES paid by Step Up), on
**Step Up (pending)** (Kindergarten awaiting Step Up eligibility: never shown as late), or not enrolled in that period.

- A payment pays one invoice of the same child, or stays a **credit** until someone applies it. Deleting an invoice
  turns its payments into credits.
- Each child also has every contact (Primary = mother, Secondary = father, Emergency/Authorized) and a billing
  family account, so siblings billed together are easy to find.
- Master data (students, contacts, invoices, credits, open A/R) is loaded with `imports/build_master_import.py`; see
  `data/README.md`. The data files never go in this repository.
- **Late fees** (`008_payroll_timeclock.sql`): tuition not fully paid by the Friday grace day gets one late fee
  (`settings.late_fee_amount`, $30; 0 turns them off). After that Friday, **Add $30 late fees** on Tuition adds it to
  every unpaid invoice of the period (`create_late_fees`); a fee shows under the child's status and in *Owed*. One
  added by mistake (or let go) comes off with **take off** next to it (on Tuition, in *Owed*, or on the child's page):
  it's voided for good, with who took it off in its note, and anything paid toward it stays as a credit. Receipts for
  it read “Late fee — tuition (period)”.
- A child who starts in the **second week** of a period (019) is billed just that week, due their first Monday.

## Receipts

Every receipt shows the school's license number (`settings.receipt_license`, C11MD1517) under the title, and, once an
admin uploads one on **Settings → Receipts**, the signature of the person in *Signed by* over the signature line. The
CRM crops the photo to the ink and makes the paper transparent. The image is kept in `receipt_signature`, readable
only by finance staff (for printing) and changed only by admins; it is never in this repository.

## Annual statements and payment methods (009)

- **Annual statements** (Reports → *Annual statements (for taxes)*, or *Annual statement* on a child's page): what a
  family paid in a calendar year, with the school's name, address, **tax ID (EIN)** and license number, every payment
  (date, receipt, method, amount) and the total, signed. That's what parents need for the child and dependent care
  credit (IRS Form 2441). Payments from School Readiness, Step Up and VPK are left out; siblings on the same billing
  family account share one statement. Print one, or all for the year; CSV with totals by method.
- The tax ID (`settings.receipt_tax_id`, set on Settings → Receipts) also prints on every receipt.
- **Who paid how** (Reports): each month's cash, Zelle, credit/debit card (and other) payments, by child, with totals.

## Billing system sheets (010)

The billing system's *Balance Summary (Family)* sheets from before the CRM (Aug 12 – Oct 5, 2026) are kept in
`billing_history`: what each family owed on the day each sheet was printed, for the tuition period written on it.
They show on **Reports → Balances on the billing system's sheets** (family × sheet, totals that match the printed
totals) and on each child's page (finance access). Reference only: they change no invoice, payment or annual statement.
The rows were loaded with a private SQL file; family names never go in this repository.

`011_graduated_earlier_payments.sql`: those periods (Aug 10 – Oct 2) were billed **and paid** in the billing system.
`billing_history.paid` is what each family paid for each of them, so **annual statements cover the school year from
August** ("Tuition Aug 10 – Aug 21 · Billing system"). Where a family's sheets show a carried balance or a credit, the
amount is a best guess (`needs_check`) until finance staff confirm it on Reports → Annual statements. On Tuition, a
period before Oct 5 looks like a CRM period: one row per child with class and funding, the amount billed and paid
(siblings share one), Step Up pending children, and nothing to bill. The same migration adds the **Graduated** status:
like Withdrawn, with the last day at school; graduated children are billed only through that day.

## Texts to families (013)

**Messages** (tab; admins, and staff with finance "View & record") texts enrolled families through the same Twilio
number as the tour texts:

- **Who gets it**: one of **My lists**, all enrolled families, one class, families who owe money, families with a late
  balance (past the Friday grace day), families missing paperwork, the waiting list, families you tick, or someone
  else by typing a number (also **Text this family** on a child's page). Each family gets one text per number;
  brothers and sisters (the same family account, or a parent with the same cell number) are one family and
  share a text that names them all. **Copy from a brother or sister** on a child's page copies the parents over.
- **My lists** (`015_message_lists.sql`), like TextMagic's lists but kept up to date by the CRM: a list is children in
  some classes (none ticked = every class) with some funding (none = any), plus families added by hand and other
  people (a name and a cell number, e.g. yourself for a copy). A child who changes class or funding moves lists by
  themselves. It starts with FES Moms (FES-UA/EO), Kinder Moms (Kindergarten), Moms 1st Floor (18–23 months, Early 2s,
  Late 2s), Moms 2nd Floor (Early 3s, Late 3s), VPK Moms (VPK), School Readiness and Private pay families
  (Step Up pending is all Kindergarten, so Kinder Moms covers it); change, add or delete any.
- **Who in a family gets group texts** (lists, classes, everyone, reminders): each contact's **Gets group texts** box on
  the child's page; by default the Primary contact yes, others no. A list can also text the second parent. Texts to
  families picked by hand go to the Primary contact.
- **Wording**: write it your way. The **Add** blocks drop in each family's details where the cursor is: parent's
  first name `{parent}`, child's first name `{child}`, balance owed `{balance}`, class `{class}`, missing paperwork `{missing}` (e.g. “Ana's blue
  form and birth certificate”), and your own first name `{me}`; *Blank to fill in* adds a `[blank]` to fill in each time (*Fill in the next [blank]* jumps to it, and a
  text with a blank left can't be sent). The preview shows every family's text before it goes; **Change** rewrites
  one family's text just for them, **Don't send** takes a family off. “Reply STOP to opt out.” is added on its own
  line unless you untick it.
- **My messages** (`014_message_templates.sql`): name a message and save it to start from next time; change or
  delete saved ones. It starts with three examples (payment reminder, activity reminder, school closed).
- **When**: now, or a date and time. Texts only go out between 8am and 9pm Miami time; one sent later waits until 8am.
- Numbers that replied STOP are skipped (and a STOP Twilio reports while sending is recorded). **Texts sent** lists
  every text with who sent it and what happened to each family; one that hasn't gone out can be canceled. Each
  child's page lists the texts their family got.

`supabase/migrations/013_family_texts.sql` holds the texts (`messages`, `message_recipients`), and
`014_message_templates.sql` the saved ones (`message_templates`);
`netlify/functions/family-texts.mjs` sends them through Twilio when **Send** is pressed, and
`family-texts-hourly.mjs` sends scheduled ones every hour. It needs `SUPABASE_SERVICE_ROLE_KEY`,
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM`), the same variables
as the tour texts; without them texts wait as *Waiting* and go out once they are set. Carriers only allow texts to
parents who agreed to them: register the A2P campaign as *Mixed* with a payment reminder and an activity reminder as
sample messages, and keep the consent line (“I agree to receive text messages from Creativa Academy about my child,
tuition and school events. Reply STOP to opt out.”) in the enrollment packet.

## New website requests while the CRM is open

The CRM checks for new website requests every minute while it's open (and as soon as you come back to its tab), so
they show up without reloading: a message pops up, **Today** shows how many came in, and the browser tab shows the
count, until you open Today, Pipeline or All inquiries. Telegram alerts (006) keep coming as before.

## Who changed what (012)

Every change a signed-in person makes to children, contacts, classes, tuition, payments, invoices, the old sheets'
amounts, payroll, time, settings or access is written to `change_log` (who, when, the row, and old → new for each
changed field) by a trigger; nobody can edit or delete it. Imports, the time clock and the system aren't logged.
**Changes** (tab) lists them by day with filters by person and area; its count shows changes by other people since
you last opened it, Today mentions them, and each child's page has its recent changes. Staff see enrollment changes,
finance access sees tuition changes, payroll access sees payroll changes, admins see everything.

## Payroll and the time clock (008)

Everyone is paid by the hour. Staff clock in and out on the **time clock** (`/clock/`) on a tablet at the front desk;
the office checks each pay period on **Payroll** and types the hours into **Patriot Software**, which runs payroll
and paystubs. (Patriot has no file import for hours from other systems, so the CRM gives a sheet to copy from.)

- **Who sees it**: admins, and anyone given **Payroll: Yes** on Settings. Finance access alone doesn't show pay rates.
- **Staff & PINs**: each person's position, hourly rate, scheduled lunch and schedule. **Make PINs for everyone**
  gives each a random 4-digit PIN and a sheet of slips to hand out. With `022_pins_on_file.sql`, each PIN set from then on
  is also kept on file for payroll staff (**Show PINs**, **Print PIN slips**), so the office can look one up; the clock
  checks a hashed copy. A typed-in easy PIN (7777) is allowed for now and marked to change; made-up ones never are. A box
  at the top names everyone still missing a PIN. Five wrong PINs lock that person out of the clock for 15 minutes.
- **Setting up the clock**: sign in to the CRM on the tablet, **Payroll → Time clock → Use this device as the time
  clock**. The tablet keeps a device key (only its hash is stored) and is signed out of the CRM. Remove a lost tablet
  there and it stops working. Times always come from the server.
- **Hours**: per pay period (Settings in **Payroll → Time clock → Pay schedule**: weekly, every two weeks, twice a
  month or monthly; match Patriot). Staff are paid every two weeks for **Friday to Thursday** (10 workdays: Oct 2–15,
  Oct 16–29…), alternating with tuition: the Friday after each period falls in the week between tuition billing
  Mondays (Oct 5, Oct 19…). The panel lists both and warns if they ever land on the same weeks. Changing the schedule
  warns if periods already entered in Patriot wouldn't line up with it. Lunch clocked out is unpaid; overtime is time over 40 hours in a workweek
  (starting on the pay schedule's weekday: Friday to Thursday), worked out per day by `payroll_hours()`. Estimated gross is
  rate × regular + 1.5 × rate × overtime, before taxes.
- **Fixing time**: tap a name for the timesheet, tap a time to change it, or **+ Add time**. Changed times are marked
  and the clock's original is kept. A stretch open more than 16 hours is a **missed clock-out**, listed at the top.
- **Hours for Patriot**: the sheet (and CSV) of regular and overtime hours by last name. After entering them in
  Patriot, **Mark as entered in Patriot** keeps the hours sent and locks that period's time (**Reopen** to change it).
- Staff names and pay rates were loaded with a one-time SQL file kept outside this repository; never commit them.

## Paychecks from Patriot (016)

Patriot Software has no way to connect other programs (its only export is a CSV from the Payroll Details report), so
each payroll is copied into the CRM: **Payroll → Paychecks → Add a payroll from Patriot**. In Patriot open
**Payroll → Print Payrolls**, tap **View Details** on the payroll, select from the pay date down to the **Totals** line,
copy and paste. The CRM reads the pay date, pay period and each person's hours, gross and net pay, matches them to the
staff list (by last and first name, ignoring accents and middle initials), and checks they add up to Patriot's totals.
Adding a pay date that's already there replaces it.

**How to do payroll, step by step** (check hours → Hours for Patriot → run payroll and print pay stubs in Patriot → mark as
entered → copy the paychecks back) is at the top of Payroll → Hours, and prints; Today points people with Payroll access
to it until they've seen it.

The tab lists each payroll and the year's totals, by pay date and by person; each person's timesheet shows their latest
paychecks. Only admins and people with Payroll access see it, and every change shows on the Changes page under Payroll.

## Weekly payers' late fees (018)

A child on a weekly rate gets a two-week bill each period like everyone else, but the family pays a week at a time: the
first week is late after the period's first Friday, the second week after the second Friday. A weekly payer who paid the
first week isn't shown as late, and gets no late fee, until then.

## Projection, start dates and the waiting list (019)

**Money → Projection** estimates the next 3, 6 or 12 months: tuition from each enrolled child's rate for every billing
period they'll be here (from their start date until a last day set on their page), by who pays (private-pay families,
FES / Step Up, School Readiness families' share, Kindergarten on Step Up pending), VPK and SR payments and the food
program (recent averages), and other money in; payroll, rent and bills on their days (020), and other expenses from
recent months. It opens with what's left over a month, the tightest and best months, and a chart of money in and out by
month; then a card per month (tap "What's in it" for the lines), the full table tucked away, children whose rate isn't
one of their class's (one tap to use the class rate), new families, and enrolled children starting and leaving. **New
families** are the Enrollment waiting list matched up with the Pipeline (linked, same name, or same phone and first name),
each child once, plus Pipeline families with a start date or at Waitlisted. A start date and registration paid (either
place) counts as starting (money in); a start date without it, as possible; no start date, not at all. A child on the
waiting list whose Pipeline stage is earlier is flagged. With no rate, their class's full-time rate is used.

**Tuition** opens with the tuition expected each week: this week (next week on a weekend) and the three after it, from each
child's rate (a two-week rate is half a week; Kindergarten's school-year rate a tenth a month, Aug–May), by who pays.

**Settings → School calendar** (021) keeps holidays and closed days. Families pay full tuition through them; days marked
*staff not paid* (one of the two weeks of winter break) come off payroll in the projection.

For a family in the **Pipeline**, open it and fill in **Starts on** and **Tuition** (with how often); the card shows
"starts …" and they count from that day. Both move over when they become a student.

The waiting list: **Registration paid on** (and the amount) on an inquiry, or a student's *Registration fee* = Paid (or a
registration bill paid in full), is what holds a spot. Waitlisted cards say *registration paid* or *not paid*, the
Waitlisted column counts who paid, and on Enrollment each class card shows how many are waiting and how many paid. A
Waitlisted inquiry can be added to the waiting list in one tap, keeping that.

## Class rates and monthly bills (020)

**Settings → Classes → Tuition rates** keeps each class's rates from the Programs & Hours sheet: full time (7:00–3:00)
and full time with after care (7:00–5:45), a week, or a school year for Kindergarten (10 payments, Aug–May), plus the
registration and book fees. Each child's page has them in a **Class rate** list ("Until 3:00 — $540.00 every 2 weeks", "Until 5:45 (after care) —
…"; kept to how the family pays: weekly or every 2 weeks), with a place to write why a child's rate is different (a sibling discount). The Pipeline's tuition does the
same from the program.

**Money → Bills** keeps what the school pays on set days every month: rent (twice a month, with what a month is made
of, like base rent and CAM), utilities (an estimate when the amount changes)... Each month lists every payment due,
paid or not; **Mark paid** adds it to money out. Unpaid ones show under *On its way*, and the projection counts every
bill on its days (other expenses leave out the bills' categories, so nothing is counted twice).

## Money, the Child Care Food Program and To do (017)

**Money** (admins and finance access; adding needs finance "View & record") shows each month what came in and what
went out, what's left over, what's on its way, and the year by month:

- **Money in**: tuition and program payments recorded per child on Tuition (by who paid: families, FES / Step Up, SR,
  VPK, and by method), food program claims once paid, and anything added here (deposits not recorded per child...).
- **Money out**: payroll (gross pay from the paychecks copied from Patriot, 016; needs Payroll access) and expenses
  added here (food, supplies, rent, utilities...). Nothing that's already in the CRM is typed twice.
- **On its way**: food program claims submitted but not paid, tuition families still owe, and the last payroll.

Receipts can be marked for the food program's columns (d) food purchases to (j) other costs. **Money → Food program**
keeps each month's claim (meals, earnings, costs, submitted, paid; "Fill food and non-food from the receipts") and
prints the **Monthly Record of CCFP Operating Expenditures** from those receipts. A line that's only for that record,
like the cook's labor that payroll already counts, is left out of money out.

**To do** (admins, finance "View & record" and payroll access): each to-do has a due date, who it's for, whether it
repeats, and how many days before to remind. From then until it's checked off it's on that person's **Today** page and
counted on the To do tab; a repeating one comes back for its next date when checked off. It starts with the food
program claim and the SR and VPK attendance, due the 1st of every month, reminded a week before. Reminders stay in the
CRM.

## Telegram alerts

`006_reschedule_telegram_spam.sql` sends each new website request to Telegram as soon as it is saved: tour
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

## Registration for next school year (023)

**Enrollment → Registration 2027–28** (finance access) lists every child at the school or waiting, moving up to the next
class (waiting children keep theirs; Kindergarten moves on to 1st grade; change it if needed), with that class's
registration fee (Settings → Classes), whether they're coming back, and what's been paid. **Record payment** makes the
child's "Registration 2027–28" bill and the payment on it in one step when it's saved (`registration_pay`: one bill per
child per year, paid in one or more parts, due when the school year starts), with a receipt for that school year; it
counts in Money and Reports like any payment. Changing the class moves the fee; "not coming back" before paying removes the
bill (`registration_save`). A waiting child who already paid registration shows as *Paid (on file)*. The year and the
opening date are `settings.reg_year` / `reg_opens` (2027-28, from Nov 9, 2026).

## Guide

**Settings** opens with a guide to everything the CRM does, by area, with how to use each part (`guide.js`, written in
English and Spanish; it follows the Español button). Add a line there when something new is added to the CRM.

## Español

The **Español** button in the header shows the CRM in Spanish on that device (it's remembered; **English** switches back).
The CRM's own words are translated as they appear, from `es.js` (exact text, or with its numbers and month/day names
filled in as `{n}`); names, notes and anything people type stay as written, and printed papers (receipts, statements, the
food program record) stay in English. A phrase still in English just needs a line added to `es.js`.

## Tests

```bash
# Database rules (intake mapping, spam handling, who can see/change what, calendar feed,
# roster/finance access, receipts, which tour emails and texts are due, opt-outs, Turnstile, reschedule,
# Telegram alerts, blocked senders and the per-device limit, billing periods and invoices,
# late fees, receipt signature, payroll access, PINs, the time clock, overtime, locked pay periods,
# change log, texts to families: who can send, quiet hours, opt-outs, sending once)
PGHOST=... PGPORT=... PGUSER=postgres tests/run-db-tests.sh

# Tour email and text jobs, family texts, incoming texts (fake Supabase, Resend and Twilio)
node --test tests/tour-emails.test.mjs tests/tour-texts.test.mjs tests/family-texts.test.mjs

# Full browser walkthrough: Postgres + PostgREST + headless Chromium
POSTGREST=/path/to/postgrest SUPABASE_JS=/path/to/supabase.min.js \
PGHOST=... PGPORT=... PGUSER=postgres tests/e2e/run.sh
```

`tests/supabase-stub.sql` stands in for the bits of Supabase the migration needs
(`auth.users`, `auth.uid()`, the `anon`/`authenticated` roles).

## Changing things

- **Stages** live in three places that must match: the `check` constraint and the
  `labels` in `inquiries_log()` (latest in `006_reschedule_telegram_spam.sql`), and `STAGES`/`STAGE_LABEL` in `app.js`.
  Add a new numbered migration rather than editing one that has already been run.
- **Funding programs, payment methods and documents** live in the `check` constraints in `003_enrollment_finance.sql`
  and `FUNDING` / `PAYER` / `METHOD` / `DOCS` in `app.js`.
- **Website form fields** are mapped in `submit_inquiry()`. Every submission is also
  kept untouched in `inquiries.raw`, so nothing is lost if a field isn't mapped.
