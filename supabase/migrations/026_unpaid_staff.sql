-- Creativa CRM — staff who aren't paid for now (Payroll → Staff → Paid).
-- Run once in the Supabase SQL editor, after 025_auto_lunch.sql. Safe to run again (and run it again after running 008,
-- 012 or 025 again, since those put back their own versions of the functions below).
--
--   employees.paid        off for someone working without pay for now (family helping while money is tight). They can
--                         still use the time clock, but their time isn't paid: it's left out of the Hours tab, the hours
--                         for Patriot and closing a pay period (a missing clock-out of theirs doesn't hold it up).
--   time_entries.paid     kept with each stretch of time when it's made, like lunch_minutes (025): turning Paid on or
--                         off changes their time from the current pay period on, never earlier periods (their hours may
--                         already be in Patriot) or ones entered in Patriot. Time with none counts as paid.
--   payroll_hours         the same as in 025, without unpaid time.
--   payroll_close_period  the same as in 008, without unpaid time.
--   _timeclock_status     the same as in 025, without asking about a missing clock-out of unpaid time.
--   employees_lunch       the same as in 025 as first run: from the current pay period on, and like employees_paid it
--                         updates an early clock-in still waiting for its start time too (it used to refuse that).
--   log_change            the same as in 012, without logging each stretch of time when Paid or the lunch changes (the
--                         person's own change is logged).
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.employees add column if not exists paid boolean not null default true;
alter table public.time_entries add column if not exists paid boolean;

-- New time keeps the person's Paid from that moment.
create or replace function public.time_entries_paid()
returns trigger language plpgsql security definer set search_path = public as '
begin
  if tg_op = ''INSERT'' or new.employee_id is distinct from old.employee_id then
    new.paid := (select e.paid from public.employees e where e.id = new.employee_id);
  end if;
  return new;
end';
drop trigger if exists time_entries_paid on public.time_entries;
create trigger time_entries_paid before insert or update of employee_id on public.time_entries
  for each row execute function public.time_entries_paid();

-- Turning Paid on or off (or changing the lunch) changes the person's time from the current pay period on.
-- The update runs as the time clock does (crm.timeclock), so it isn't counted as an office edit of the times and an early
-- clock-in still waiting for its start time is updated too.
create or replace function public.employees_paid()
returns trigger language plpgsql security definer set search_path = public as '
declare
  prev text := coalesce(current_setting(''crm.timeclock'', true), '''');
begin
  perform set_config(''crm.timeclock'', ''on'', true);
  update public.time_entries t set paid = new.paid
   where t.employee_id = new.id and t.paid is distinct from new.paid
     and t.work_date >= (public.payroll_period((now() at time zone ''America/New_York'')::date)).period_start
     and not exists (select 1 from public.payroll_periods p where t.work_date between p.period_start and p.period_end);
  perform set_config(''crm.timeclock'', prev, true);
  return new;
end';
drop trigger if exists employees_paid on public.employees;
create trigger employees_paid after update of paid on public.employees
  for each row when (new.paid is distinct from old.paid) execute function public.employees_paid();

create or replace function public.employees_lunch()
returns trigger language plpgsql security definer set search_path = public as '
declare
  prev text := coalesce(current_setting(''crm.timeclock'', true), '''');
begin
  perform set_config(''crm.timeclock'', ''on'', true);
  update public.time_entries t set lunch_minutes = new.lunch_minutes
   where t.employee_id = new.id and t.lunch_minutes is distinct from new.lunch_minutes
     and t.work_date >= (public.payroll_period((now() at time zone ''America/New_York'')::date)).period_start
     and not exists (select 1 from public.payroll_periods p where t.work_date between p.period_start and p.period_end);
  perform set_config(''crm.timeclock'', prev, true);
  return new;
end';

-- Time already in the CRM, outside pay periods entered in Patriot.
do '
begin
  perform set_config(''crm.timeclock'', ''on'', true);
  update public.time_entries t set paid = e.paid
    from public.employees e
   where e.id = t.employee_id and t.paid is null
     and not exists (select 1 from public.payroll_periods p where t.work_date between p.period_start and p.period_end);
  perform set_config(''crm.timeclock'', '''', true);
end';

-- Same as in 025, without unpaid time.
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
     where e.work_date between p_start - 6 and p_end and coalesce(e.paid, true)
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

-- Same as in 008, without unpaid time (their missing clock-outs don't hold up the period).
create or replace function public.payroll_close_period(p_start date, p_end date)
returns jsonb language plpgsql security definer set search_path = public as '
declare
  today date := (now() at time zone ''America/New_York'')::date;
  sent jsonb;
begin
  if not public.can_payroll() then raise exception ''Only payroll staff can close a pay period''; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception ''Pick a pay period''; end if;
  if p_end >= today then raise exception ''You can mark the pay period as entered once it is over (after %)'', to_char(p_end, ''FMMon FMDD''); end if;
  if exists (select 1 from public.payroll_periods p where p.period_start <= p_end and p.period_end >= p_start) then
    raise exception ''This pay period was already marked as entered in Patriot'';
  end if;
  if exists (select 1 from public.time_entries e where e.work_date between p_start and p_end and e.clock_out is null
               and coalesce(e.paid, true)) then
    raise exception ''Someone has a missing clock-out in this pay period. Fix it first.'';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           ''employee_id'', e.id, ''name'', btrim(e.first_name || '' '' || e.last_name), ''rate'', e.pay_rate,
           ''regular'', round(h.reg / 60, 2), ''overtime'', round(h.ot / 60, 2)) order by e.last_name, e.first_name), ''[]''::jsonb)
    into sent
    from (select employee_id, sum(regular) as reg, sum(overtime) as ot from public.payroll_hours(p_start, p_end) group by employee_id) h
    join public.employees e on e.id = h.employee_id
   where h.reg + h.ot > 0;
  insert into public.payroll_periods (period_start, period_end, closed_by, hours) values (p_start, p_end, auth.uid(), sent);
  return sent;
end';

-- Same as in 025, without asking about a missing clock-out of unpaid time.
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
                              where x.employee_id = e.id and x.clock_out is null and coalesce(x.paid, true)
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

-- Same as in 012, without a line on the Changes page for each stretch of time when someone's Paid or lunch changes.
create or replace function public.log_change()
returns trigger language plpgsql security definer set search_path = public as '
declare
  who uuid := auth.uid();
  o jsonb;
  n jsonb;
  r jsonb;
  d jsonb := ''{}''::jsonb;
  k text;
begin
  if who is null then return null; end if;
  if tg_op <> ''INSERT'' then o := to_jsonb(old); end if;
  if tg_op <> ''DELETE'' then n := to_jsonb(new); end if;
  if tg_op = ''UPDATE'' then
    for k in select jsonb_object_keys(n) loop
      if k not in (''updated_at'', ''edited_at'', ''edited_by'', ''created_at'', ''last_seen_at'', ''changes_seen_at'', ''pin_set_at'',
                   ''telegram_last_at'', ''telegram_last_result'', ''telegram_last_request'')
         and not (tg_table_name = ''time_entries'' and k in (''paid'', ''lunch_minutes''))
         and (o -> k) is distinct from (n -> k) then
        d := d || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k));
      end if;
    end loop;
    if d = ''{}''::jsonb then return null; end if;
  end if;
  r := coalesce(n, o);
  if tg_table_name = ''settings'' then r := ''{}''::jsonb; end if;   -- long email wording; the diff says what changed
  insert into public.change_log (actor, area, table_name, row_id, action, student_id, employee_id, data, diff)
  values (who, tg_argv[0], tg_table_name, coalesce(r ->> ''id'', r ->> ''student_id'', coalesce(n, o) ->> ''id''), lower(tg_op),
          case when tg_table_name = ''students'' then (coalesce(n, o) ->> ''id'')::uuid else (coalesce(n, o) ->> ''student_id'')::uuid end,
          case when tg_table_name = ''employees'' then (coalesce(n, o) ->> ''id'')::uuid else (coalesce(n, o) ->> ''employee_id'')::uuid end,
          r, case when tg_op = ''UPDATE'' then d end);
  return null;
end';

revoke execute on function public.time_entries_paid() from public, anon, authenticated;
revoke execute on function public.employees_paid() from public, anon, authenticated;
revoke execute on function public.employees_lunch() from public, anon, authenticated;
revoke execute on function public.log_change() from public, anon, authenticated;
revoke execute on function public.payroll_hours(date, date) from public, anon;
grant  execute on function public.payroll_hours(date, date) to authenticated;
revoke execute on function public._timeclock_status(uuid) from public, anon, authenticated;
revoke execute on function public.payroll_close_period(date, date) from public, anon;
grant  execute on function public.payroll_close_period(date, date) to authenticated;
