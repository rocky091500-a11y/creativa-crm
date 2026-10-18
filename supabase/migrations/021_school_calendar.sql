-- Creativa CRM — the school calendar: holidays and closed days, and whether staff are paid for them.
-- Run once in the Supabase SQL editor, after 020_class_rates_and_bills.sql. Safe to run again.
--
--   school_closures   a name and the days (from–to). Families pay full tuition through holidays and breaks (no credit),
--                     so tuition doesn't change; staff_paid = false is for days teachers aren't paid (one of the two
--                     weeks of winter break), which the projection takes out of payroll. Set on Settings → School calendar.
--   Starts with the 2026–27 holidays (only when the calendar is empty). Winter break is in two parts: the first week paid,
--   the second week not.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create table if not exists public.school_closures (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  starts_on   date not null,
  ends_on     date not null,
  staff_paid  boolean not null default true,
  check (ends_on >= starts_on and ends_on - starts_on <= 60)
);

alter table public.school_closures enable row level security;
revoke all on public.school_closures from anon;
drop policy if exists school_closures_select on public.school_closures;
drop policy if exists school_closures_write on public.school_closures;
create policy school_closures_select on public.school_closures for select to authenticated using (public.is_staff());
create policy school_closures_write on public.school_closures for all to authenticated using (public.is_admin()) with check (public.is_admin());

insert into public.school_closures (name, starts_on, ends_on, staff_paid, created_by)
select x.name, x.s::date, x.e::date, x.paid, null
  from (values
    ('Teacher Planning Days', '2026-06-04', '2026-06-05', true),
    ('Independence Day', '2026-07-03', '2026-07-03', true),
    ('Teacher Planning Days', '2026-08-06', '2026-08-07', true),
    ('Labor Day', '2026-09-07', '2026-09-07', true),
    ('Veterans Day', '2026-11-11', '2026-11-11', true),
    ('Thanksgiving', '2026-11-26', '2026-11-27', true),
    ('Winter Break (staff paid)', '2026-12-21', '2026-12-25', true),
    ('Winter Break (staff not paid)', '2026-12-28', '2027-01-01', false),
    ('Martin Luther King, Jr. Day', '2027-01-18', '2027-01-18', true),
    ('Presidents Day', '2027-02-15', '2027-02-15', true),
    ('Good Friday', '2027-03-26', '2027-03-26', true),
    ('Memorial Day', '2027-05-31', '2027-05-31', true),
    ('Teacher Planning Days', '2027-06-03', '2027-06-04', true),
    ('Juneteenth', '2027-06-18', '2027-06-18', true)
  ) as x(name, s, e, paid)
 where not exists (select 1 from public.school_closures);

-- Changes to the calendar show on the Changes page (012), under Settings & access.
do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.school_closures;
    create trigger log_change after insert or update or delete on public.school_closures
      for each row execute function public.log_change(''settings'');
  end if;
end';
