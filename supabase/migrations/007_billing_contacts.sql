-- Creativa CRM — biweekly billing (invoices) and family contacts.
-- Run once in the Supabase SQL editor, after 001–006 (in that order). Safe to run again.
--
-- Billing rules (school year 2026-27): one tuition invoice per student every 14 days, dated the
-- billing Monday (first one 2026-10-05) and due the same day; the billing system gives grace
-- through that Friday. A billing period runs Monday to the Friday of the following week.
--
--   invoices          one row per bill: biweekly tuition, or a fee (activity fee, registration…).
--                     Finance access only, like payments.
--   payments          gain invoice_id: a payment either pays an invoice or sits as a credit
--                     (unapplied) until it is applied.
--   student_contacts  every parent/guardian/emergency contact for a child (Primary = mother,
--                     Secondary = father, Emergency/Authorized = other family). Staff see these.
--   student_finance   gains billing_program (the billing system's item, e.g. Preschool Full-Time),
--                     bill_family (false when the family is not invoiced, e.g. FES paid by Step Up),
--                     and the funding type "stepup_pending" (Kindergarten: Step Up eligibility
--                     pending, nothing billed, not delinquent).
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

-- ───────────────────────── funding, billing settings ─────────────────────────
alter table public.student_finance drop constraint if exists student_finance_funding_check;
alter table public.student_finance add constraint student_finance_funding_check
  check (funding <@ array['private','sr','sr_bpiece','fes_ua','fes_eo','vpk','stepup_pending']::text[]);
alter table public.student_finance
  add column if not exists billing_program text check (length(billing_program) <= 80),
  add column if not exists bill_family boolean not null default true;

alter table public.students add column if not exists family_account text check (length(family_account) <= 80);

alter table public.settings
  add column if not exists billing_anchor date not null default '2026-10-05',
  add column if not exists billing_period_days int not null default 14 check (billing_period_days between 7 and 31);

-- ───────────────────────── contacts ─────────────────────────
create table if not exists public.student_contacts (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  student_id    uuid not null references public.students(id) on delete cascade,
  role          text not null default 'primary' check (role in ('primary','secondary','emergency')),
  relationship  text check (length(relationship) <= 60),
  first_name    text check (length(first_name) <= 80),
  last_name     text check (length(last_name) <= 80),
  cell_phone    text check (length(cell_phone) <= 40),
  work_phone    text check (length(work_phone) <= 40),
  home_phone    text check (length(home_phone) <= 40),
  sms_phone     text check (length(sms_phone) <= 40),
  email         text check (length(email) <= 200),
  notes         text check (length(notes) <= 500)
);
create index if not exists student_contacts_student_idx on public.student_contacts (student_id, role);

alter table public.student_contacts enable row level security;
revoke all on public.student_contacts from anon;
drop policy if exists student_contacts_select on public.student_contacts;
drop policy if exists student_contacts_insert on public.student_contacts;
drop policy if exists student_contacts_update on public.student_contacts;
drop policy if exists student_contacts_delete on public.student_contacts;
create policy student_contacts_select on public.student_contacts for select to authenticated using (public.is_staff());
create policy student_contacts_insert on public.student_contacts for insert to authenticated with check (public.is_staff());
create policy student_contacts_update on public.student_contacts for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy student_contacts_delete on public.student_contacts for delete to authenticated using (public.is_staff());

-- ───────────────────────── invoices ─────────────────────────
create table if not exists public.invoices (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  student_id    uuid not null references public.students(id) on delete restrict,
  kind          text not null default 'tuition' check (kind in ('tuition','fee','other')),
  description   text not null check (length(description) between 1 and 120),
  period_start  date,                     -- billing Monday, for tuition
  invoice_date  date not null,
  due_date      date not null,
  amount        numeric(10,2) not null check (amount >= 0 and amount < 100000),
  void          boolean not null default false,
  note          text check (length(note) <= 500),
  source        text not null default 'crm' check (source in ('crm','import')),
  created_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  check (kind <> 'tuition' or period_start is not null)
);
create unique index if not exists invoices_one_tuition_per_period
  on public.invoices (student_id, period_start) where kind = 'tuition' and not void;
create index if not exists invoices_date_idx on public.invoices (invoice_date);

alter table public.payments add column if not exists invoice_id uuid references public.invoices(id) on delete set null;
create index if not exists payments_invoice_idx on public.payments (invoice_id);

alter table public.invoices enable row level security;
revoke all on public.invoices from anon;
drop policy if exists invoices_select on public.invoices;
drop policy if exists invoices_insert on public.invoices;
drop policy if exists invoices_update on public.invoices;
drop policy if exists invoices_delete on public.invoices;
create policy invoices_select on public.invoices for select to authenticated using (public.can_view_finance());
create policy invoices_insert on public.invoices for insert to authenticated with check (public.can_edit_finance());
create policy invoices_update on public.invoices for update to authenticated
  using (public.can_edit_finance()) with check (public.can_edit_finance());
create policy invoices_delete on public.invoices for delete to authenticated using (public.can_edit_finance());

-- A payment can only pay an invoice of the same child.
create or replace function public.payments_invoice_guard()
returns trigger language plpgsql security definer set search_path = public as '
begin
  if new.invoice_id is not null and not exists (
       select 1 from public.invoices i where i.id = new.invoice_id and i.student_id = new.student_id) then
    raise exception ''That invoice belongs to another child'' using errcode = ''23514'';
  end if;
  return new;
end';
drop trigger if exists payments_invoice_guard on public.payments;
create trigger payments_invoice_guard before insert or update of invoice_id, student_id on public.payments
  for each row execute function public.payments_invoice_guard();

-- Finance editors: bill every enrolled child for one billing period (a billing Monday).
-- Skips children already billed for it, with no biweekly rate, not billed to the family, on
-- Step Up (pending), starting after the period, or withdrawn before it. Returns how many were added.
create or replace function public.create_period_invoices(p_period date)
returns int language plpgsql security definer set search_path = public as '
declare
  s public.settings;
  n int;
begin
  if not public.can_edit_finance() then raise exception ''Only staff who can record payments can create invoices''; end if;
  select * into s from public.settings where id = 1;
  if p_period is null or (p_period - s.billing_anchor) % s.billing_period_days <> 0 then
    raise exception ''% is not a billing Monday'', p_period;
  end if;
  insert into public.invoices (student_id, kind, description, period_start, invoice_date, due_date, amount, created_by)
  select st.id, ''tuition'', coalesce(f.billing_program, ''Tuition''), p_period, p_period, p_period,
         case f.tuition_frequency when ''weekly'' then f.tuition_amount * 2 else f.tuition_amount end, auth.uid()
    from public.students st
    join public.student_finance f on f.student_id = st.id
   where f.bill_family and f.tuition_amount > 0 and f.tuition_frequency in (''biweekly'', ''weekly'')
     and not (''stepup_pending'' = any (f.funding))
     and (st.status = ''enrolled'' or (st.status = ''withdrawn'' and st.withdrawn_on >= p_period))
     and (st.start_date is null or st.start_date < p_period + s.billing_period_days)
     and not exists (select 1 from public.invoices i
                      where i.student_id = st.id and i.kind = ''tuition'' and i.period_start = p_period and not i.void);
  get diagnostics n = row_count;
  return n;
end';

revoke execute on function public.payments_invoice_guard() from public, anon, authenticated;
revoke execute on function public.create_period_invoices(date) from public, anon;
grant  execute on function public.create_period_invoices(date) to authenticated;
