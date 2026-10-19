-- Creativa CRM — registration for next school year (Enrollment → Registration): who's returning, the class they move up
-- to, and their registration payment.
-- Run once in the Supabase SQL editor, after 022_pins_on_file.sql. Safe to run again.
--
--   settings.reg_year    the school year registration is for ('2027-28'), and from when (reg_opens: the second week of
--   settings.reg_opens   November 2026, Monday Nov 9).
--   registrations        one per child per school year: the class they'll be in, whether they're returning (returning /
--                        not_returning / undecided), and the registration bill (an invoice, kind fee, "Registration 2027–28")
--                        their payments go on, so receipts, Money and Reports count them like any payment.
--                        A child without a row is shown as returning to the next class, with that class's registration fee.
--   registration_pay     records a registration payment in one step: the child's row, their bill (made once, at the class's fee,
--                        due when the school year starts) and the payment on it, dated to that school year for the receipt.
--                        Nothing is made until the payment is saved, and one child never gets two bills for a year.
--   registration_save    saves the class and "coming back?"; the bill's amount follows the class's fee (never below what's
--                        paid), and an unpaid bill goes away when they aren't coming back.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.settings
  add column if not exists reg_year text check (reg_year ~ '^[0-9]{4}-[0-9]{2}$'),
  add column if not exists reg_opens date;
update public.settings set reg_year = coalesce(reg_year, '2027-28'), reg_opens = coalesce(reg_opens, '2026-11-09') where id = 1;

create table if not exists public.registrations (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  created_by         uuid references public.profiles(id) on delete set null default auth.uid(),
  school_year        text not null check (school_year ~ '^[0-9]{4}-[0-9]{2}$'),
  student_id         uuid not null references public.students(id) on delete cascade,
  next_classroom_id  uuid references public.classrooms(id) on delete set null,
  status             text not null default 'returning' check (status in ('returning', 'not_returning', 'undecided')),
  invoice_id         uuid references public.invoices(id) on delete set null,
  note               text check (length(note) <= 300),
  unique (school_year, student_id)
);

alter table public.registrations enable row level security;
revoke all on public.registrations from anon;
drop policy if exists registrations_select on public.registrations;
drop policy if exists registrations_write on public.registrations;
create policy registrations_select on public.registrations for select to authenticated using (public.can_view_finance());
create policy registrations_write on public.registrations for all to authenticated
  using (public.can_edit_finance()) with check (public.can_edit_finance());

-- Changes to registrations show on the Changes page (012), under Tuition & payments, on the child's history.
do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.registrations;
    create trigger log_change after insert or update or delete on public.registrations
      for each row execute function public.log_change(''finance'');
  end if;
end';

-- The registration year's first day ('2027-28' → Aug 1, 2027): the bill's due date and the payments' school year.
create or replace function public.reg_year_start(p_year text)
returns date language sql immutable as 'select make_date(left(p_year, 4)::int, 8, 1)';

create or replace function public.registration_save(p_student uuid, p_year text, p_next uuid, p_status text)
returns public.registrations language plpgsql security definer set search_path = public as '
declare
  r public.registrations;
  fee numeric;
  paid numeric;
begin
  if not public.can_edit_finance() then raise exception ''Only staff who record payments can change registrations''; end if;
  insert into public.registrations (school_year, student_id, next_classroom_id, status)
  values (p_year, p_student, p_next, coalesce(p_status, ''returning''))
  on conflict (school_year, student_id) do update set next_classroom_id = excluded.next_classroom_id, status = excluded.status
  returning * into r;
  if r.invoice_id is not null then
    select coalesce(sum(amount), 0) into paid from public.payments where invoice_id = r.invoice_id;
    if r.status <> ''returning'' and paid = 0 then
      update public.registrations set invoice_id = null where id = r.id returning * into r;
      delete from public.invoices i where i.kind = ''fee'' and i.student_id = p_student
        and not exists (select 1 from public.payments x where x.invoice_id = i.id)
        and i.id not in (select invoice_id from public.registrations where invoice_id is not null)
        and i.description = ''Registration '' || replace(p_year, ''-'', ''–'');
    else
      select registration_fee into fee from public.classrooms where id = r.next_classroom_id;
      if fee is not null then update public.invoices set amount = greatest(fee, paid) where id = r.invoice_id and not void; end if;
    end if;
  end if;
  return r;
end';

create or replace function public.registration_pay(p_student uuid, p_year text, p_next uuid, p_amount numeric, p_paid_on date,
  p_method text, p_payer text, p_reference text, p_note text)
returns public.payments language plpgsql security definer set search_path = public as '
declare
  r public.registrations;
  inv uuid;
  fee numeric;
  pay public.payments;
begin
  if not public.can_edit_finance() then raise exception ''Only staff who record payments can record registration''; end if;
  if p_amount is null or p_amount <= 0 then raise exception ''Type the amount''; end if;
  insert into public.registrations (school_year, student_id, next_classroom_id, status)
  values (p_year, p_student, p_next, ''returning'')
  on conflict (school_year, student_id) do update
    set status = ''returning'', next_classroom_id = coalesce(excluded.next_classroom_id, public.registrations.next_classroom_id)
  returning * into r;
  select * into r from public.registrations where id = r.id for update;   -- one bill per child per year, even from two devices
  select id into inv from public.invoices where id = r.invoice_id and not void;
  if inv is null then
    select registration_fee into fee from public.classrooms where id = r.next_classroom_id;
    insert into public.invoices (student_id, kind, description, invoice_date, due_date, amount, created_by)
    values (p_student, ''fee'', ''Registration '' || replace(p_year, ''-'', ''–''), coalesce(p_paid_on, current_date),
            public.reg_year_start(p_year), coalesce(fee, p_amount), auth.uid())
    returning id into inv;
    update public.registrations set invoice_id = inv where id = r.id;
  end if;
  insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, method, payer, reference, note, created_by)
  values (p_student, inv, coalesce(p_paid_on, current_date), public.reg_year_start(p_year), p_amount, coalesce(p_method, ''cash''),
          coalesce(p_payer, ''parent''), nullif(trim(p_reference), ''''), nullif(trim(p_note), ''''), auth.uid())
  returning * into pay;
  return pay;
end';

revoke execute on function public.registration_save(uuid, text, uuid, text) from public, anon;
revoke execute on function public.registration_pay(uuid, text, uuid, numeric, date, text, text, text, text) from public, anon;
grant  execute on function public.registration_save(uuid, text, uuid, text) to authenticated;
grant  execute on function public.registration_pay(uuid, text, uuid, numeric, date, text, text, text, text) to authenticated;
