-- Creativa CRM — staff birthdays on the calendar (Payroll → Staff → the person → Birthday).
-- Run once in the Supabase SQL editor, after 036_health_forms.sql. Safe to run again.
--
--   employees.birthday     the month and day ("05-27"), no year. Only payroll can see or change it on the person, like
--                          the rest of Payroll.
--   staff_birthdays()      for everyone who signs in to the CRM: the name and month-day of each active person with a
--                          birthday, and nothing else (no pay, no position), for the Calendar (the month, the staff print,
--                          and this week on Today). Family calendars don't show birthdays.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.employees add column if not exists birthday text
  check (birthday ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' and birthday not in ('02-30', '02-31', '04-31', '06-31', '09-31', '11-31'));

create or replace function public.staff_birthdays()
returns table (name text, birthday text) language sql stable security definer set search_path = public as '
  select btrim(e.first_name || '' '' || e.last_name), e.birthday
    from public.employees e
   where e.active and e.birthday is not null and public.is_staff()
   order by e.birthday, e.first_name, e.last_name';
revoke execute on function public.staff_birthdays() from public, anon;
grant execute on function public.staff_birthdays() to authenticated;
