# Creativa CRM

Enrollment pipeline for Creativa Academy staff — every tour request, waitlist sign-up and
contact form from creativaacademy.com lands here, and staff move each family from
**New → Contacted → Tour scheduled → Toured → Waitlisted / Enrolled / Lost**.

- **Today** — follow-ups due, upcoming tours, new inquiries not yet contacted
- **Pipeline** — drag families between stages
- **All inquiries** — search (names, email, any phone format), filter, download CSV
- **Inquiry drawer** — call/text/email buttons, every form field, notes & call log, full original submission
- **Staff** (admins) — turn staff access on and off, and get the tour calendar link
- **Tour calendar** — every scheduled tour as a private calendar feed for Google Calendar or phones

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
   - SQL Editor → paste and run `supabase/migrations/001_init.sql`, then `002_calendar_feed.sql`.
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

## Tests

```bash
# Database rules (intake mapping, spam handling, who can see/change what, calendar feed)
PGHOST=... PGPORT=... PGUSER=postgres tests/run-db-tests.sh

# Full browser walkthrough: Postgres + PostgREST + headless Chromium
POSTGREST=/path/to/postgrest SUPABASE_JS=/path/to/supabase.min.js \
PGHOST=... PGPORT=... PGUSER=postgres tests/e2e/run.sh
```

`tests/supabase-stub.sql` stands in for the bits of Supabase the migration needs
(`auth.users`, `auth.uid()`, the `anon`/`authenticated` roles).

## Changing things

- **Stages** live in three places that must match: the `check` constraint and the
  `labels` in `001_init.sql`, and `STAGES`/`STAGE_LABEL` in `app.js`. Add a new
  numbered migration rather than editing `001_init.sql` once it has been run.
- **Website form fields** are mapped in `submit_inquiry()`. Every submission is also
  kept untouched in `inquiries.raw`, so nothing is lost if a field isn't mapped.
