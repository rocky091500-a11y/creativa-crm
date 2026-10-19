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
