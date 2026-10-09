-- Creativa CRM — enrollment roster, documents, funding, tuition payments and tour emails.
-- Run once in the Supabase SQL editor, after 001_init.sql and 002_calendar_feed.sql.
--
-- Model:
--   classrooms        the school's classes (name, teachers, optional capacity).
--   students          one row per child: enrolled, on a waiting list, or withdrawn.
--                     Includes the four enrollment documents. Every active staff member sees these.
--   student_finance   funding (School Readiness, SR BPIECE, FES-UA, FES-EO, VPK, private),
--                     tuition amount and award/scholarship ID. Finance access only.
--   payments          every payment received (parent, School Readiness, FES, ...), with a
--                     receipt number. Finance access only.
--   settings          one row: receipt header and the wording of the automatic tour emails.
--
-- Finance access: admins always have it. Other staff get profiles.finance = 'view' (see
-- tuition, payments and reports) or 'edit' (also record payments and change tuition).
--
-- No dollar-quoting or backslashes in this file: function bodies use single quotes,
-- so the script survives copy-paste through tools that escape special characters.

-- ───────────────────────── finance access ─────────────────────────
alter table public.profiles
  add column finance text not null default 'none' check (finance in ('none','view','edit'));

create or replace function public.can_view_finance()
returns boolean language sql stable security definer set search_path = public as '
  select exists (select 1 from public.profiles
                  where id = auth.uid() and active and (role = ''admin'' or finance in (''view'',''edit'')));
';

create or replace function public.can_edit_finance()
returns boolean language sql stable security definer set search_path = public as '
  select exists (select 1 from public.profiles
                  where id = auth.uid() and active and (role = ''admin'' or finance = ''edit''));
';

-- Nobody changes their own finance access either.
create or replace function public.profiles_guard()
returns trigger language plpgsql as '
begin
  if new.id = auth.uid() and (new.role <> old.role or new.active <> old.active or new.finance <> old.finance) then
    raise exception ''You cannot change your own role or access'';
  end if;
  return new;
end';

-- ───────────────────────── classrooms ─────────────────────────
create table public.classrooms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(btrim(name)) between 1 and 60),
  teachers    text,
  capacity    int check (capacity is null or capacity between 1 and 99),
  sort        int not null default 100
);

insert into public.classrooms (name, sort) values
  ('18–23 months', 10), ('Early 2s', 20), ('Late 2s', 30), ('Early 3s', 40),
  ('Late 3s', 50), ('VPK', 60), ('Kindergarten', 70);

-- ───────────────────────── students ─────────────────────────
create table public.students (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  name            text not null check (length(btrim(name)) between 1 and 120),
  dob             date,
  classroom_id    uuid references public.classrooms(id) on delete set null,
  status          text not null default 'enrolled' check (status in ('enrolled','waitlist','withdrawn')),
  school_year     text not null default '2026-27',
  start_date      date,
  withdrawn_on    date,
  withdraw_reason text,
  parent_name     text,
  parent_phone    text,
  parent_email    text,
  rbt             text check (rbt in ('yes','in_process')),
  therapy         text,
  reg_fee         text check (reg_fee in ('paid','not_paid','na')),
  -- enrollment documents: the date each was received (null = still missing)
  doc_registration date,
  doc_blue_form    date,
  doc_yellow_form  date,
  doc_birth_cert   date,
  notes           text,
  inquiry_id      uuid references public.inquiries(id) on delete set null,
  created_by      uuid references public.profiles(id) on delete set null default auth.uid()
);

create index students_class_idx on public.students (classroom_id, status);
create index students_inquiry_idx on public.students (inquiry_id);

create trigger students_touch before update on public.students
  for each row execute function public.inquiries_touch();

-- ───────────────────────── funding & tuition ─────────────────────────
create table public.student_finance (
  student_id        uuid primary key references public.students(id) on delete cascade,
  funding           text[] not null default '{}'
                    check (funding <@ array['private','sr','sr_bpiece','fes_ua','fes_eo','vpk']::text[]),
  tuition_amount    numeric(10,2) check (tuition_amount is null or tuition_amount >= 0),
  tuition_frequency text not null default 'monthly' check (tuition_frequency in ('monthly','biweekly','weekly')),
  award_id          text check (length(award_id) <= 60),
  notes             text,
  updated_at        timestamptz not null default now()
);

create trigger student_finance_touch before update on public.student_finance
  for each row execute function public.inquiries_touch();

create sequence public.receipt_no_seq start 1001;

create table public.payments (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  student_id   uuid not null references public.students(id) on delete restrict,
  paid_on      date not null default current_date,
  covers_month date not null check (extract(day from covers_month) = 1),  -- first day of the month it pays for
  amount       numeric(10,2) not null check (amount > 0 and amount < 100000),
  payer        text not null default 'parent' check (payer in ('parent','sr','fes','vpk','other')),
  method       text not null default 'cash' check (method in ('cash','check','zelle','card','ach','other')),
  reference    text check (length(reference) <= 80),          -- check number, confirmation code…
  note         text check (length(note) <= 500),
  receipt_no   bigint not null unique,                         -- set by payments_guard
  created_by   uuid references public.profiles(id) on delete set null default auth.uid()
);

alter sequence public.receipt_no_seq owned by public.payments.receipt_no;
create index payments_month_idx on public.payments (covers_month);
create index payments_paid_idx on public.payments (paid_on);
create index payments_student_idx on public.payments (student_id, paid_on desc);

-- ───────────────────────── settings ─────────────────────────
create table public.settings (
  id                    int primary key default 1 check (id = 1),
  school_name           text not null default 'Creativa Academy',
  receipt_header        text,       -- address, phone, tax ID: printed under the name on receipts
  receipt_signer        text,       -- e.g. "Emily Say, Director"
  tour_reminder_subject text not null default 'Your tour at Creativa Academy is tomorrow / Su visita es mañana',
  tour_reminder_body    text not null default 'Hi {parent},

This is a friendly reminder that your tour of Creativa Academy is tomorrow, {tour_date} at {tour_time}. We can''t wait to meet you and {child}!

If you need to change the time, just reply to this email or give us a call.

—

Hola {parent},

Le recordamos que su visita a Creativa Academy es mañana, {tour_date_es} a las {tour_time}. ¡Esperamos conocerles a usted y a {child_es}!

Si necesita cambiar la hora, responda a este correo o llámenos.

Creativa Academy',
  followup_subject      text not null default 'How was your visit to Creativa Academy? / ¿Cómo fue su visita?',
  followup_body         text not null default 'Hi {parent},

Thank you for visiting Creativa Academy last week! We''d love to hear how your tour went and answer any questions you have about enrolling {child}.

Just reply to this email — we''re happy to help.

—

Hola {parent},

¡Gracias por visitar Creativa Academy la semana pasada! Nos encantaría saber cómo le fue en la visita y responder cualquier pregunta sobre la inscripción de {child_es}.

Solo responda a este correo, con gusto le ayudamos.

Creativa Academy',
  emails_enabled        boolean not null default true
);
-- Placeholders in the email wording: {parent} (first name), {child} / {child_es} (first name, or
-- "your little one" / "su peque"), {tour_date}, {tour_date_es}, {tour_time}.
insert into public.settings default values;

-- ───────────────────────── automatic tour emails ─────────────────────────
alter table public.inquiries
  add column auto_emails           boolean not null default true,
  add column tour_reminder_sent_at timestamptz,
  add column followup_sent_at      timestamptz;

-- A new tour time is a new tour: both emails go out again for it.
create or replace function public.inquiries_tour_reset()
returns trigger language plpgsql as '
begin
  if new.tour_at is distinct from old.tour_at then
    new.tour_reminder_sent_at := null;
    new.followup_sent_at := null;
  end if;
  return new;
end';

create trigger inquiries_tour_reset before update of tour_at on public.inquiries
  for each row execute function public.inquiries_tour_reset();

-- What the hourly email job should send now (Miami time):
--   reminder  the day before the tour, from 9am, while the stage is still Tour scheduled
--   followup  7 to 10 days after the tour, from 10am, if the family is still at Tour scheduled
--             or Toured and nobody has logged a call, email or text with them since the tour.
create or replace function public.tour_emails_due(p_now timestamptz default now())
returns table (kind text, inquiry_id uuid, email text, parent_name text, child_name text, tour_at timestamptz)
language sql stable security definer set search_path = public as '
  with t as (select (p_now at time zone ''America/New_York'') as local_now)
  select ''reminder'', i.id, i.email, i.parent_name, i.child_name, i.tour_at
    from public.inquiries i, t
   where i.stage = ''tour_scheduled'' and i.tour_reminder_sent_at is null
     and (i.tour_at at time zone ''America/New_York'')::date = t.local_now::date + 1
     and extract(hour from t.local_now) >= 9
     and i.auto_emails and i.email is not null
     and (select emails_enabled from public.settings where id = 1)
  union all
  select ''followup'', i.id, i.email, i.parent_name, i.child_name, i.tour_at
    from public.inquiries i, t
   where i.stage in (''tour_scheduled'',''toured'') and i.followup_sent_at is null
     and (i.tour_at at time zone ''America/New_York'')::date between t.local_now::date - 10 and t.local_now::date - 7
     and extract(hour from t.local_now) >= 10
     and i.auto_emails and i.email is not null
     and (select emails_enabled from public.settings where id = 1)
     and not exists (select 1 from public.activities a
                      where a.inquiry_id = i.id and a.kind in (''call'',''email'',''text'') and a.created_at > i.tour_at)
';

-- Called by the email job after the email went out: stamps the inquiry and logs it on the timeline.
create or replace function public.tour_email_sent(p_inquiry uuid, p_kind text, p_to text)
returns void language plpgsql security definer set search_path = public as '
begin
  if p_kind = ''reminder'' then
    update public.inquiries set tour_reminder_sent_at = now() where id = p_inquiry;
  elsif p_kind = ''followup'' then
    update public.inquiries set followup_sent_at = now() where id = p_inquiry;
  else
    raise exception ''unknown email kind'';
  end if;
  insert into public.activities (inquiry_id, author, kind, body)
  values (p_inquiry, null, ''email'',
          case p_kind when ''reminder'' then ''Automatic tour reminder emailed to ''
                      else ''Automatic “how was your visit?” email sent to '' end || p_to);
end';

-- ───────────────────────── RLS ─────────────────────────
alter table public.classrooms      enable row level security;
alter table public.students        enable row level security;
alter table public.student_finance enable row level security;
alter table public.payments        enable row level security;
alter table public.settings        enable row level security;

revoke all on public.classrooms, public.students, public.student_finance, public.payments, public.settings from anon;
revoke all on sequence public.receipt_no_seq from anon;

create policy classrooms_select on public.classrooms for select to authenticated using (public.is_staff());
create policy classrooms_insert on public.classrooms for insert to authenticated with check (public.is_admin());
create policy classrooms_update on public.classrooms for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy classrooms_delete on public.classrooms for delete to authenticated using (public.is_admin());

-- students: any active staff member keeps the roster and documents; only admins delete.
create policy students_select on public.students for select to authenticated using (public.is_staff());
create policy students_insert on public.students for insert to authenticated with check (public.is_staff());
create policy students_update on public.students for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy students_delete on public.students for delete to authenticated using (public.is_admin());

create policy student_finance_select on public.student_finance for select to authenticated using (public.can_view_finance());
create policy student_finance_insert on public.student_finance for insert to authenticated with check (public.can_edit_finance());
create policy student_finance_update on public.student_finance for update to authenticated
  using (public.can_edit_finance()) with check (public.can_edit_finance());
create policy student_finance_delete on public.student_finance for delete to authenticated using (public.can_edit_finance());

create policy payments_select on public.payments for select to authenticated using (public.can_view_finance());
create policy payments_insert on public.payments for insert to authenticated
  with check (public.can_edit_finance() and created_by = auth.uid());
create policy payments_update on public.payments for update to authenticated
  using (public.can_edit_finance()) with check (public.can_edit_finance());
create policy payments_delete on public.payments for delete to authenticated using (public.can_edit_finance());

-- Receipt numbers are assigned by the database, never chosen or changed by the app.
create or replace function public.payments_guard()
returns trigger language plpgsql as '
begin
  if tg_op = ''INSERT'' then
    new.receipt_no := nextval(''public.receipt_no_seq'');
  elsif new.receipt_no <> old.receipt_no then
    raise exception ''Receipt numbers cannot be changed'';
  end if;
  return new;
end';
create trigger payments_guard before insert or update on public.payments
  for each row execute function public.payments_guard();

create policy settings_select on public.settings for select to authenticated using (public.is_staff());
create policy settings_update on public.settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Function privileges: Supabase grants EXECUTE to anon by default; tighten.
revoke execute on function public.can_view_finance() from public, anon;
revoke execute on function public.can_edit_finance() from public, anon;
revoke execute on function public.inquiries_tour_reset() from public, anon, authenticated;
revoke execute on function public.payments_guard() from public, anon, authenticated;
-- The email job signs in with the service_role key; nobody else may read the queue or stamp it.
revoke execute on function public.tour_emails_due(timestamptz) from public, anon, authenticated;
revoke execute on function public.tour_email_sent(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.tour_emails_due(timestamptz) to service_role;
grant  execute on function public.tour_email_sent(uuid, text, text) to service_role;
