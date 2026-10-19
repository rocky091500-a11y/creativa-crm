-- Creativa CRM — early clock-ins count from the scheduled start (Payroll → Staff → Starts at).
-- Run once in the Supabase SQL editor, after 023_registration.sql. Safe to run again.
--
--   employees.start_time     when the person's day starts (8:00). Clocking in earlier on the time clock (traffic, getting
--                            ready before class) is saved as that time, so pay starts then; the real tap is kept in
--                            time_entries.punched_in and shows on their timesheet. Back from lunch, and anyone without a
--                            start time, counts from the tap as before. Starts with the time at the front of each person's
--                            Schedule ("8:00 – 4:30" → 8:00; 1:00 to 5:59 → afternoon), only where none is set.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.employees add column if not exists start_time time;
alter table public.time_entries add column if not exists punched_in timestamptz;

update public.employees e
   set start_time = make_time(case when m[1]::int between 1 and 5 then m[1]::int + 12 else m[1]::int end, m[2]::int, 0)
  from (select id, regexp_match(schedule, '^ *([0-9]{1,2}):([0-9]{2})') as m from public.employees) x
 where x.id = e.id and e.start_time is null and x.m is not null and x.m[1]::int between 1 and 12 and x.m[2]::int < 60;

-- Same as in 008, with the time clock's minutes never below zero (a stretch can start at the scheduled time, after the tap).
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
  worked numeric;
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
      ''status'', st, ''since'', since,
      ''today_minutes'', round(coalesce(sum(m.mins) filter (where m.work_date = today), 0)),
      ''week_minutes'', round(coalesce(sum(m.mins) filter (where m.work_date >= wk), 0)),
      ''period_minutes'', round(coalesce(sum(m.mins) filter (where m.work_date >= pp), 0)),
      ''missed_clock_out'', (select max(x.work_date) from public.time_entries x
                              where x.employee_id = e.id and x.clock_out is null
                                and x.clock_in <= now() - interval ''16 hours'' and x.work_date >= today - 14))
    from public.employees e
    left join (select t.work_date, greatest(extract(epoch from coalesce(t.clock_out, now()) - t.clock_in), 0) / 60 as mins
                 from public.time_entries t
                where t.employee_id = p_employee and t.work_date >= least(wk, pp)
                  and (t.clock_out is not null or t.clock_in > now() - interval ''16 hours'')) m on true
   where e.id = p_employee
   group by e.id);
end';

-- Same as in 008, with early clock-ins counting from the scheduled start.
create or replace function public.timeclock_punch(p_token text, p_employee uuid, p_pin text, p_action text)
returns jsonb language plpgsql security definer set search_path = public as '
declare
  err text := public._timeclock_check(p_token, p_employee, p_pin);
  st jsonb;
  sched timestamptz;
  at timestamptz := now();
begin
  if err is not null then return jsonb_build_object(''error'', err); end if;
  st := public._timeclock_status(p_employee);
  perform set_config(''crm.timeclock'', ''on'', true);
  if p_action = ''in'' and st->>''status'' in (''out'', ''lunch'') then
    -- Early for the day (not back from lunch): the time counts from their scheduled start; the tap is kept.
    select ((now() at time zone ''America/New_York'')::date + e.start_time) at time zone ''America/New_York'' into sched
      from public.employees e where e.id = p_employee and e.start_time is not null;
    if sched is not null and now() < sched and st->>''status'' = ''out'' and not exists (select 1 from public.time_entries t
         where t.employee_id = p_employee and t.work_date = (now() at time zone ''America/New_York'')::date) then
      insert into public.time_entries (employee_id, clock_in, punched_in, source, device_id)
      values (p_employee, sched, now(), ''clock'', public._timeclock_device(p_token));
      at := sched;
    else
      insert into public.time_entries (employee_id, clock_in, source, device_id)
      values (p_employee, now(), ''clock'', public._timeclock_device(p_token));
    end if;
  elsif p_action in (''lunch'', ''out'') and st->>''status'' = ''in'' then
    -- Out again before their start time: the stretch is from the real tap.
    update public.time_entries set clock_in = case when now() <= clock_in then coalesce(punched_in, clock_in) else clock_in end,
           punched_in = case when now() <= clock_in then null else punched_in end, clock_out = now(), out_reason = p_action
     where employee_id = p_employee and clock_out is null and clock_in > now() - interval ''16 hours'';
  elsif p_action = ''out'' and st->>''status'' = ''lunch'' then
    -- Not coming back after lunch: the lunch clock-out was the end of the day.
    update public.time_entries set out_reason = ''out''
     where id = (select id from public.time_entries where employee_id = p_employee and clock_out is not null
                  order by clock_out desc limit 1);
  else
    perform set_config(''crm.timeclock'', '''', true);
    return st || jsonb_build_object(''error'', ''state'');
  end if;
  perform set_config(''crm.timeclock'', '''', true);
  return public._timeclock_status(p_employee) || jsonb_build_object(''done'', p_action, ''at'', at, ''tapped'', now());
end';
revoke execute on function public._timeclock_status(uuid) from public, anon, authenticated;
