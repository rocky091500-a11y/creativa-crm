-- Creativa CRM — the scheduled lunch comes off automatically (Payroll → Staff → Lunch).
-- Run once in the Supabase SQL editor, after 024_scheduled_start.sql. Safe to run again (and run it again after running
-- 008 or 024 again, since those put back their own versions of the functions below).
--
--   Staff no longer clock out and back in for lunch: the time clock has just Clock in and Clock out.
--   lunch_off            the minutes that come off a day: when someone is clocked in more than 6 hours that day, their
--                        scheduled lunch (30 minutes, 1 hour, none), less any break already off the clock that day (a lunch
--                        they did clock out for, or leaving and coming back). A short day keeps all its time.
--   time_entries.lunch_minutes   the scheduled lunch, kept with each stretch of time when it's made, so changing someone's
--                        lunch on the Staff page changes their days from then on and in pay periods not yet entered in
--                        Patriot, never ones already entered. Time from before this file (in periods already entered in
--                        Patriot) has none, so it stays as it was sent.
--   payroll_hours        the same as in 008, with lunch_off taken off each day before overtime is worked out (the
--                        timesheet shows it as "N min lunch off" under the day's hours).
--   _timeclock_status    the time clock's hours (today, this week, this pay period) have lunch off the same way, and it
--                        says the person's lunch (lunch_minutes), which also tells the time clock that this file has run.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.time_entries add column if not exists lunch_minutes int check (lunch_minutes between 0 and 180);

-- New time (from the time clock or the office) keeps the person's lunch from that moment.
create or replace function public.time_entries_lunch()
returns trigger language plpgsql security definer set search_path = public as '
begin
  if tg_op = ''INSERT'' or new.employee_id is distinct from old.employee_id then
    new.lunch_minutes := (select e.lunch_minutes from public.employees e where e.id = new.employee_id);
  end if;
  return new;
end';
drop trigger if exists time_entries_lunch on public.time_entries;
create trigger time_entries_lunch before insert or update of employee_id on public.time_entries
  for each row execute function public.time_entries_lunch();

-- Changing someone's lunch changes their time in pay periods not yet entered in Patriot.
create or replace function public.employees_lunch()
returns trigger language plpgsql security definer set search_path = public as '
begin
  update public.time_entries t set lunch_minutes = new.lunch_minutes
   where t.employee_id = new.id and t.lunch_minutes is distinct from new.lunch_minutes
     and not exists (select 1 from public.payroll_periods p where t.work_date between p.period_start and p.period_end);
  return new;
end';
drop trigger if exists employees_lunch on public.employees;
create trigger employees_lunch after update of lunch_minutes on public.employees
  for each row when (new.lunch_minutes is distinct from old.lunch_minutes) execute function public.employees_lunch();

-- Time already in the CRM, outside pay periods entered in Patriot.
update public.time_entries t set lunch_minutes = e.lunch_minutes
  from public.employees e
 where e.id = t.employee_id and t.lunch_minutes is null
   and not exists (select 1 from public.payroll_periods p where t.work_date between p.period_start and p.period_end);

-- p_worked: minutes clocked in that day; p_span: from the first clock-in to the last clock-out; p_lunch: the scheduled lunch.
create or replace function public.lunch_off(p_worked numeric, p_span numeric, p_lunch int)
returns numeric language sql immutable as '
  select case when p_worked > 360
              then greatest(coalesce(p_lunch, 0) - greatest(coalesce(p_span, p_worked) - p_worked, 0), 0)::numeric
              else 0 end
';
drop function if exists public.lunch_off(numeric, int, boolean);   -- an earlier draft of this file

create or replace function public.payroll_hours(p_start date, p_end date)
returns table (employee_id uuid, work_date date, minutes numeric, regular numeric, overtime numeric, open_entries int)
language sql stable set search_path = public as '
  with r as (
    select e.employee_id as emp, e.work_date as day,
           coalesce(sum(extract(epoch from e.clock_out - e.clock_in) / 60) filter (where e.clock_out is not null), 0) as worked,
           extract(epoch from max(e.clock_out) - min(e.clock_in) filter (where e.clock_out is not null)) / 60 as span,
           max(e.lunch_minutes) filter (where e.clock_out is not null) as lunch,
           (count(*) filter (where e.clock_out is null))::int as open_n
      from public.time_entries e
     where e.work_date between p_start - 6 and p_end
     group by e.employee_id, e.work_date
  ), d as (
    select r.emp, r.day, r.open_n, r.worked - public.lunch_off(r.worked, r.span, r.lunch) as mins
      from r
  ), c as (
    select d.*, sum(d.mins) over (partition by d.emp, public.payroll_week_start(d.day) order by d.day) - d.mins as before
      from d
  )
  select c.emp, c.day, round(c.mins, 2),
         round(greatest(0, least(c.mins, 2400 - c.before)), 2),
         round(c.mins - greatest(0, least(c.mins, 2400 - c.before)), 2),
         c.open_n
    from c
   where c.day between p_start and p_end
   order by 1, 2;
';

-- Same as in 024, with each day's lunch taken off its minutes (a stretch still open counts until now) and lunch_minutes added.
create or replace function public._timeclock_status(p_employee uuid)
returns jsonb language plpgsql security definer set search_path = public as '
declare
  today date := (now() at time zone ''America/New_York'')::date;
  wk date := public.payroll_week_start(today);
  pp date := (public.payroll_period(today)).period_start;
  cur public.time_entries;
  lst public.time_entries;
  st text := ''out'';
  since timestamptz;
begin
  select * into cur from public.time_entries
   where employee_id = p_employee and clock_out is null and clock_in > now() - interval ''16 hours''
   order by clock_in desc limit 1;
  if found then
    st := ''in''; since := cur.clock_in;
  else
    select * into lst from public.time_entries where employee_id = p_employee and clock_out is not null
     order by clock_out desc limit 1;
    if found and lst.out_reason = ''lunch'' and lst.clock_out > now() - interval ''3 hours'' then st := ''lunch''; end if;
    since := lst.clock_out;
  end if;
  return (select jsonb_build_object(
      ''id'', e.id, ''name'', btrim(e.first_name || '' '' || e.last_name), ''first_name'', e.first_name,
      ''status'', st, ''since'', since, ''lunch_minutes'', e.lunch_minutes,
      ''today_minutes'', round(coalesce(sum(m.mins) filter (where m.work_date = today), 0)),
      ''week_minutes'', round(coalesce(sum(m.mins) filter (where m.work_date >= wk), 0)),
      ''period_minutes'', round(coalesce(sum(m.mins) filter (where m.work_date >= pp), 0)),
      ''missed_clock_out'', (select max(x.work_date) from public.time_entries x
                              where x.employee_id = e.id and x.clock_out is null
                                and x.clock_in <= now() - interval ''16 hours'' and x.work_date >= today - 14))
    from public.employees e
    left join (select y.work_date, y.worked - public.lunch_off(y.worked, y.span, y.lunch) as mins
                 from (select t.work_date,
                              sum(greatest(extract(epoch from coalesce(t.clock_out, now()) - t.clock_in), 0) / 60) as worked,
                              greatest(extract(epoch from max(coalesce(t.clock_out, now())) - min(t.clock_in)), 0) / 60 as span,
                              max(t.lunch_minutes) as lunch
                         from public.time_entries t
                        where t.employee_id = p_employee and t.work_date >= least(wk, pp)
                          and (t.clock_out is not null or t.clock_in > now() - interval ''16 hours'')
                        group by t.work_date) y) m on true
   where e.id = p_employee
   group by e.id);
end';

revoke execute on function public.time_entries_lunch() from public, anon, authenticated;
revoke execute on function public.employees_lunch() from public, anon, authenticated;
revoke execute on function public.lunch_off(numeric, numeric, int) from public, anon;
grant  execute on function public.lunch_off(numeric, numeric, int) to authenticated;
revoke execute on function public.payroll_hours(date, date) from public, anon;
grant  execute on function public.payroll_hours(date, date) to authenticated;
revoke execute on function public._timeclock_status(uuid) from public, anon, authenticated;
