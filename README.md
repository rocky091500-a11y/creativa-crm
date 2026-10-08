# Creativa CRM

Enrollment pipeline for Creativa Academy staff — every tour request, waitlist sign-up and
contact form from creativaacademy.com lands here, and staff move each family from
**New → Contacted → Tour scheduled → Toured → Waitlisted / Enrolled / Lost**.

- **Today** — follow-ups due, upcoming tours, new inquiries not yet contacted
- **Pipeline** — drag families between stages
- **All inquiries** — search (names, email, any phone format), filter, download CSV
- **Inquiry drawer** — call/text/email buttons, every form field, notes & call log, full original submission
- **Staff** (admins) — turn staff access on and off

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
   - SQL Editor → paste and run `supabase/migrations/001_init.sql`.
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

## Tests

```bash
# Database rules (intake mapping, spam handling, who can see/change what)
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
