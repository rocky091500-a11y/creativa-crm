-- Creativa CRM — late fees, receipt license number and signature, and payroll: a time clock for staff.
-- Run once in the Supabase SQL editor, after 001–007 (in that order). Safe to run again.
--
-- Late fees
--   Tuition is due on the billing Monday, with grace through that Friday. A tuition invoice still
--   not fully paid after the Friday gets one late fee (settings.late_fee_amount, $30), added from
--   the Tuition page with create_late_fees(). invoices.late_fee_for links the fee to its tuition
--   invoice; voiding the fee waives it for good.
--
-- Receipts
--   settings.receipt_license   the school's license number, printed on every receipt.
--   receipt_signature          one row: the signature image printed above "Signed by" on receipts.
--                              Finance access sees it; only admins change it (Settings → Receipts).
--
-- Payroll (staff are paid by the hour; the hours are typed into Patriot Software, which runs payroll)
--   employees          one row per person on payroll: name, position, hourly rate, scheduled lunch.
--   employee_pins      their 4-digit time clock PIN, hashed. No login can read it, admins included.
--   time_entries       one row per stretch of work: clock in → clock out (for lunch, or for the day).
--   timeclock_devices  tablets or computers set up as the time clock. The clock page holds only its
--                      device key; staff tap their name and type their PIN.
--   payroll_periods    pay periods marked "entered in Patriot": their time is locked and the hours
--                      that were sent are kept.
--   profiles.payroll   who opens the Payroll page (admins always do).
--   settings           pay schedule: payroll_frequency and payroll_anchor (the first day of any pay
--                      period). Workweeks, for overtime after 40 hours, start on that weekday.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

-- ───────────────────────── late fees ─────────────────────────
alter table public.settings
  add column if not exists late_fee_amount numeric(10,2) not null default 30 check (late_fee_amount >= 0 and late_fee_amount < 1000);

alter table public.invoices add column if not exists late_fee_for uuid references public.invoices(id) on delete cascade;
alter table public.invoices drop constraint if exists invoices_late_fee_kind;
alter table public.invoices add constraint invoices_late_fee_kind check (late_fee_for is null or kind = 'fee');
create unique index if not exists invoices_one_late_fee on public.invoices (late_fee_for) where late_fee_for is not null and not void;

-- Finance editors: add the late fee to every tuition invoice of one billing period that still has a
-- balance after its Friday grace day. Skips invoices that already have a late fee, or had one waived.
-- Returns how many fees were added.
create or replace function public.create_late_fees(p_period date)
returns int language plpgsql security definer set search_path = public as '
declare
  fee numeric := (select late_fee_amount from public.settings where id = 1);
  today date := (now() at time zone ''America/New_York'')::date;
  n int;
begin
  if not public.can_edit_finance() then raise exception ''Only staff who can record payments can add late fees''; end if;
  if coalesce(fee, 0) <= 0 then return 0; end if;
  insert into public.invoices (student_id, kind, description, invoice_date, due_date, amount, late_fee_for, note, created_by)
  select i.student_id, ''fee'', ''Late fee'', today, today, fee, i.id,
         ''Tuition for the period starting '' || to_char(i.period_start, ''FMMon FMDD'') || '' not paid by Friday '' || to_char(i.due_date + 4, ''FMMon FMDD''),
         auth.uid()
    from public.invoices i
   where i.kind = ''tuition'' and not i.void and i.period_start = p_period and today > i.due_date + 4
     and i.amount > coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0)
     and not exists (select 1 from public.invoices f where f.late_fee_for = i.id);
  get diagnostics n = row_count;
  return n;
end';

-- ───────────────────────── receipts ─────────────────────────
alter table public.settings
  add column if not exists receipt_license text default 'C11MD1517' check (length(receipt_license) <= 40);

create table if not exists public.receipt_signature (
  id          int primary key default 1 check (id = 1),
  image       text check (length(image) <= 400000 and image ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+=*$'),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);
insert into public.receipt_signature (id) values (1) on conflict (id) do nothing;

create or replace function public.receipt_signature_touch()
returns trigger language plpgsql as '
begin
  new.id := 1;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end';
drop trigger if exists receipt_signature_touch on public.receipt_signature;
create trigger receipt_signature_touch before update on public.receipt_signature
  for each row execute function public.receipt_signature_touch();

alter table public.receipt_signature enable row level security;
revoke all on public.receipt_signature from anon;
drop policy if exists receipt_signature_select on public.receipt_signature;
drop policy if exists receipt_signature_update on public.receipt_signature;
create policy receipt_signature_select on public.receipt_signature for select to authenticated using (public.can_view_finance());
create policy receipt_signature_update on public.receipt_signature for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ───────────────────────── payroll access, pay schedule ─────────────────────────
alter table public.profiles add column if not exists payroll boolean not null default false;

create or replace function public.can_payroll()
returns boolean language sql stable security definer set search_path = public as '
  select exists (select 1 from public.profiles where id = auth.uid() and active and (role = ''admin'' or payroll));
';

-- Nobody changes their own role or access (payroll included).
create or replace function public.profiles_guard()
returns trigger language plpgsql as '
begin
  if new.id = auth.uid() and (new.role <> old.role or new.active <> old.active or new.finance <> old.finance
                              or new.payroll <> old.payroll) then
    raise exception ''You cannot change your own role or access'';
  end if;
  return new;
end';

alter table public.settings
  add column if not exists payroll_frequency text not null default 'biweekly'
    check (payroll_frequency in ('weekly','biweekly','semimonthly','monthly')),
  add column if not exists payroll_anchor date not null default '2026-10-05';

-- The pay period a day falls in. Weekly and every-two-weeks periods count from payroll_anchor;
-- twice a month is the 1st–15th and the 16th–end of the month.
create or replace function public.payroll_period(p_day date, out period_start date, out period_end date)
language plpgsql stable set search_path = public as '
declare
  s public.settings;
begin
  select * into s from public.settings where id = 1;
  if s.payroll_frequency in (''weekly'', ''biweekly'') then
    period_start := s.payroll_anchor + floor((p_day - s.payroll_anchor)::numeric / case s.payroll_frequency when ''weekly'' then 7 else 14 end)::int
                    * case s.payroll_frequency when ''weekly'' then 7 else 14 end;
    period_end := period_start + case s.payroll_frequency when ''weekly'' then 6 else 13 end;
  elsif s.payroll_frequency = ''semimonthly'' then
    period_start := date_trunc(''month'', p_day)::date + case when extract(day from p_day) > 15 then 15 else 0 end;
    period_end := case when extract(day from p_day) > 15 then (date_trunc(''month'', p_day) + interval ''1 month - 1 day'')::date
                       else period_start + 14 end;
  else
    period_start := date_trunc(''month'', p_day)::date;
    period_end := (date_trunc(''month'', p_day) + interval ''1 month - 1 day'')::date;
  end if;
end';

-- First day of the workweek a day falls in (overtime is counted per workweek).
create or replace function public.payroll_week_start(p_day date)
returns date language sql stable set search_path = public as '
  select p_day - ((extract(isodow from p_day)::int - extract(isodow from s.payroll_anchor)::int + 7) % 7)
    from public.settings s where s.id = 1;
';

-- ───────────────────────── employees ─────────────────────────
create table if not exists public.employees (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  first_name     text not null check (length(btrim(first_name)) between 1 and 60),
  last_name      text not null default '' check (length(last_name) <= 60),
  position       text check (length(position) <= 60),
  pay_rate       numeric(7,2) check (pay_rate >= 0 and pay_rate < 1000),   -- dollars per hour
  lunch_minutes  int not null default 0 check (lunch_minutes between 0 and 120),   -- scheduled, unpaid
  schedule       text check (length(schedule) <= 60),
  active         boolean not null default true,
  pin_set_at     timestamptz,                 -- set by payroll_set_pin(); the PIN itself is in employee_pins
  notes          text check (length(notes) <= 500)
);

create table if not exists public.employee_pins (
  employee_id   uuid primary key references public.employees(id) on delete cascade,
  pin_hash      text not null,
  fails         int not null default 0,
  locked_until  timestamptz
);

create table if not exists public.timeclock_devices (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  name          text not null check (length(btrim(name)) between 1 and 60),
  token_hash    text not null unique,
  last_seen_at  timestamptz
);

-- ───────────────────────── time entries ─────────────────────────
create table if not exists public.time_entries (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees(id) on delete restrict,
  clock_in      timestamptz not null,
  clock_out     timestamptz,
  out_reason    text check (out_reason in ('lunch','out')),   -- why the stretch ended
  work_date     date generated always as ((clock_in at time zone 'America/New_York')::date) stored,
  source        text not null default 'office' check (source in ('clock','office')),
  device_id     uuid references public.timeclock_devices(id) on delete set null,
  note          text check (length(note) <= 300),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null,
  edited_at     timestamptz,
  edited_by     uuid references public.profiles(id) on delete set null,
  original_in   timestamptz,          -- what the time clock recorded, before the office changed it
  original_out  timestamptz,
  check (clock_out is null or (clock_out > clock_in and clock_out <= clock_in + interval '20 hours')),
  check (clock_out is not null or out_reason is null)
);
create index if not exists time_entries_employee_idx on public.time_entries (employee_id, clock_in);
create index if not exists time_entries_date_idx on public.time_entries (work_date);
create index if not exists time_entries_open_idx on public.time_entries (employee_id) where clock_out is null;

create table if not exists public.payroll_periods (
  period_start  date primary key,
  period_end    date not null check (period_end >= period_start),
  closed_at     timestamptz not null default now(),
  closed_by     uuid references public.profiles(id) on delete set null default auth.uid(),
  hours         jsonb not null default '[]'::jsonb   -- what was entered in Patriot, per person
);

-- Time clock punches come only through the timeclock_* functions below, which set crm.timeclock.
-- Anything else is the office: it is stamped as such, and changing a clocked time keeps the original.
-- Nothing may change inside a pay period already entered in Patriot, and stretches of one person may
-- not overlap.
create or replace function public.time_entries_guard()
returns trigger language plpgsql security definer set search_path = public as '
declare
  kiosk boolean := coalesce(current_setting(''crm.timeclock'', true), '''') = ''on'';
  d date;
begin
  if tg_op <> ''INSERT'' and exists (select 1 from public.payroll_periods p
       where (old.clock_in at time zone ''America/New_York'')::date between p.period_start and p.period_end) then
    raise exception ''That pay period was already entered in Patriot. Reopen it on the Payroll page to change it.'' using errcode = ''23514'';
  end if;
  if tg_op = ''DELETE'' then return old; end if;
  d := (new.clock_in at time zone ''America/New_York'')::date;
  if exists (select 1 from public.payroll_periods p where d between p.period_start and p.period_end) then
    raise exception ''That pay period was already entered in Patriot. Reopen it on the Payroll page to change it.'' using errcode = ''23514'';
  end if;
  if tg_op = ''INSERT'' then
    new.created_at := now();
    new.edited_at := null; new.edited_by := null; new.original_in := null; new.original_out := null;
    if kiosk then
      new.source := ''clock'';
    else
      new.source := ''office''; new.device_id := null; new.created_by := auth.uid();
    end if;
  else
    new.source := old.source; new.device_id := old.device_id; new.created_at := old.created_at; new.created_by := old.created_by;
    new.original_in := old.original_in; new.original_out := old.original_out;
    new.edited_at := old.edited_at; new.edited_by := old.edited_by;
    if not kiosk and (new.clock_in, new.clock_out, new.employee_id) is distinct from (old.clock_in, old.clock_out, old.employee_id) then
      if old.source = ''clock'' and old.edited_at is null then
        new.original_in := old.clock_in; new.original_out := old.clock_out;
      end if;
      new.edited_at := now(); new.edited_by := auth.uid();
    end if;
  end if;
  if not kiosk then
    if new.clock_in > now() + interval ''5 minutes'' or new.clock_out > now() + interval ''5 minutes'' then
      raise exception ''Time can’t be entered for later than now'' using errcode = ''23514'';
    end if;
    -- A stretch still open counts until now (or as a moment, if it was left open for days).
    if exists (select 1 from public.time_entries e
                where e.employee_id = new.employee_id and e.id <> new.id
                  and e.clock_in < coalesce(new.clock_out, case when new.clock_in > now() - interval ''20 hours''
                                                                then greatest(now(), new.clock_in + interval ''1 second'')
                                                                else new.clock_in + interval ''1 second'' end)
                  and coalesce(e.clock_out, case when e.clock_in > now() - interval ''20 hours''
                                                 then greatest(now(), e.clock_in + interval ''1 second'')
                                                 else e.clock_in + interval ''1 second'' end) > new.clock_in) then
      raise exception ''That time overlaps other time already recorded for this person'' using errcode = ''23514'';
    end if;
  end if;
  return new;
end';
drop trigger if exists time_entries_guard on public.time_entries;
create trigger time_entries_guard before insert or update or delete on public.time_entries
  for each row execute function public.time_entries_guard();

-- ───────────────────────── row-level security ─────────────────────────
alter table public.employees         enable row level security;
alter table public.employee_pins     enable row level security;
alter table public.timeclock_devices enable row level security;
alter table public.time_entries      enable row level security;
alter table public.payroll_periods   enable row level security;
revoke all on public.employees, public.employee_pins, public.timeclock_devices, public.time_entries, public.payroll_periods from anon;
revoke all on public.employee_pins from authenticated;
revoke insert, update on public.timeclock_devices from authenticated;
revoke insert, update on public.payroll_periods from authenticated;

drop policy if exists employees_all on public.employees;
drop policy if exists time_entries_all on public.time_entries;
drop policy if exists timeclock_devices_select on public.timeclock_devices;
drop policy if exists timeclock_devices_delete on public.timeclock_devices;
drop policy if exists payroll_periods_select on public.payroll_periods;
drop policy if exists payroll_periods_delete on public.payroll_periods;
create policy employees_all on public.employees for all to authenticated
  using (public.can_payroll()) with check (public.can_payroll());
create policy time_entries_all on public.time_entries for all to authenticated
  using (public.can_payroll()) with check (public.can_payroll());
create policy timeclock_devices_select on public.timeclock_devices for select to authenticated using (public.can_payroll());
create policy timeclock_devices_delete on public.timeclock_devices for delete to authenticated using (public.can_payroll());
create policy payroll_periods_select on public.payroll_periods for select to authenticated using (public.can_payroll());
create policy payroll_periods_delete on public.payroll_periods for delete to authenticated using (public.can_payroll());   -- reopen

-- ───────────────────────── hours ─────────────────────────
-- Minutes worked per person per day from p_start to p_end, split into regular and overtime: in each
-- workweek the first 40 hours (2400 minutes) are regular, the rest overtime. Days before p_start in
-- its first workweek count toward that week's 40 hours. Open stretches (no clock-out yet) are counted
-- in open_entries, not in minutes. Sees only what the caller may see (payroll access).
create or replace function public.payroll_hours(p_start date, p_end date)
returns table (employee_id uuid, work_date date, minutes numeric, regular numeric, overtime numeric, open_entries int)
language sql stable set search_path = public as '
  with d as (
    select e.employee_id as emp, e.work_date as day,
           coalesce(sum(extract(epoch from e.clock_out - e.clock_in) / 60) filter (where e.clock_out is not null), 0) as mins,
           (count(*) filter (where e.clock_out is null))::int as open_n
      from public.time_entries e
     where e.work_date between p_start - 6 and p_end
     group by e.employee_id, e.work_date
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

-- Mark a pay period as entered in Patriot: keeps the hours that were sent and locks its time.
-- Only once the period is over, with no missing clock-outs, and not overlapping another closed period.
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
  if exists (select 1 from public.time_entries e where e.work_date between p_start and p_end and e.clock_out is null) then
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

-- ───────────────────────── PINs and devices (office) ─────────────────────────
-- Set a person's 4-digit time clock PIN, or make one up when p_pin is null. Returns the PIN; it
-- can't be looked up later, only replaced.
create or replace function public.payroll_set_pin(p_employee uuid, p_pin text default null)
returns text language plpgsql security definer set search_path = public as '
declare
  -- Same digit four times, or four in a row up or down.
  weak text[] := array[''0000'', ''1111'', ''2222'', ''3333'', ''4444'', ''5555'', ''6666'', ''7777'', ''8888'', ''9999'',
                       ''0123'', ''1234'', ''2345'', ''3456'', ''4567'', ''5678'', ''6789'',
                       ''3210'', ''4321'', ''5432'', ''6543'', ''7654'', ''8765'', ''9876''];
  pin text := p_pin;
  b bytea;
begin
  if not public.can_payroll() then raise exception ''Only payroll staff can set PINs''; end if;
  if not exists (select 1 from public.employees where id = p_employee) then raise exception ''No such person''; end if;
  if pin is null then
    loop
      b := extensions.gen_random_bytes(4);
      pin := lpad(((get_byte(b, 0)::bigint * 16777216 + get_byte(b, 1) * 65536 + get_byte(b, 2) * 256 + get_byte(b, 3)) % 10000)::text, 4, ''0'');
      exit when not (pin = any (weak));
    end loop;
  end if;
  if pin !~ ''^[0-9]{4}$'' then raise exception ''A PIN is 4 digits''; end if;
  if pin = any (weak) then raise exception ''That PIN is too easy to guess. Pick another.''; end if;
  insert into public.employee_pins (employee_id, pin_hash) values (p_employee, extensions.crypt(pin, extensions.gen_salt(''bf'', 8)))
  on conflict (employee_id) do update set pin_hash = excluded.pin_hash, fails = 0, locked_until = null;
  update public.employees set pin_set_at = now() where id = p_employee;
  return pin;
end';

-- Set up a device as the time clock. Returns its key (shown once; the device keeps it).
create or replace function public.timeclock_add_device(p_name text)
returns text language plpgsql security definer set search_path = public as '
declare
  token text := encode(extensions.gen_random_bytes(24), ''hex'');
begin
  if not public.can_payroll() then raise exception ''Only payroll staff can set up the time clock''; end if;
  insert into public.timeclock_devices (name, token_hash, created_by)
  values (coalesce(nullif(btrim(p_name), ''''), ''Time clock''), encode(extensions.digest(token, ''sha256''), ''hex''), auth.uid());
  return token;
end';

-- ───────────────────────── the time clock (callable without a login) ─────────────────────────
create or replace function public._timeclock_device(p_token text)
returns uuid language sql stable security definer set search_path = public as '
  select id from public.timeclock_devices
   where length(coalesce(p_token, '''')) >= 32 and token_hash = encode(extensions.digest(p_token, ''sha256''), ''hex'');
';

-- null when the device and PIN are good; otherwise device | unknown | locked | pin.
-- Five wrong PINs in a row lock that person out of the clock for 15 minutes.
create or replace function public._timeclock_check(p_token text, p_employee uuid, p_pin text)
returns text language plpgsql security definer set search_path = public as '
declare
  pin public.employee_pins;
begin
  if public._timeclock_device(p_token) is null then return ''device''; end if;
  select p.* into pin from public.employee_pins p join public.employees e on e.id = p.employee_id
   where p.employee_id = p_employee and e.active for update of p;
  if not found then return ''unknown''; end if;
  if pin.locked_until > now() then return ''locked''; end if;
  if pin.pin_hash = extensions.crypt(coalesce(p_pin, ''''), pin.pin_hash) then
    if pin.fails > 0 or pin.locked_until is not null then
      update public.employee_pins set fails = 0, locked_until = null where employee_id = p_employee;
    end if;
    return null;
  end if;
  update public.employee_pins
     set fails = case when pin.fails + 1 >= 5 then 0 else pin.fails + 1 end,
         locked_until = case when pin.fails + 1 >= 5 then now() + interval ''15 minutes'' end
   where employee_id = p_employee;
  return case when pin.fails + 1 >= 5 then ''locked'' else ''pin'' end;
end';

-- Where a person stands: in (clocked in, since), lunch (out for lunch in the last 3 hours, since),
-- or out; their minutes today, this workweek and this pay period; and the last day they left without
-- clocking out (a stretch open for more than 16 hours), if any in the last two weeks.
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
    left join (select t.work_date, extract(epoch from coalesce(t.clock_out, now()) - t.clock_in) / 60 as mins
                 from public.time_entries t
                where t.employee_id = p_employee and t.work_date >= least(wk, pp)
                  and (t.clock_out is not null or t.clock_in > now() - interval ''16 hours'')) m on true
   where e.id = p_employee
   group by e.id);
end';

-- The names on the clock: active people with a PIN, and whether each is clocked in right now.
create or replace function public.timeclock_roster(p_token text)
returns jsonb language plpgsql security definer set search_path = public as '
declare
  dev uuid := public._timeclock_device(p_token);
begin
  if dev is null then return jsonb_build_object(''error'', ''device''); end if;
  update public.timeclock_devices set last_seen_at = now()
   where id = dev and (last_seen_at is null or last_seen_at < now() - interval ''5 minutes'');
  return jsonb_build_object(
    ''school'', (select school_name from public.settings where id = 1),
    ''people'', coalesce((select jsonb_agg(jsonb_build_object(
                  ''id'', e.id, ''name'', btrim(e.first_name || '' '' || e.last_name),
                  ''in'', exists (select 1 from public.time_entries t where t.employee_id = e.id and t.clock_out is null
                                  and t.clock_in > now() - interval ''16 hours''))
                  order by e.first_name, e.last_name)
                from public.employees e where e.active and e.pin_set_at is not null), ''[]''::jsonb));
end';

create or replace function public.timeclock_state(p_token text, p_employee uuid, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as '
declare
  err text := public._timeclock_check(p_token, p_employee, p_pin);
begin
  if err is not null then return jsonb_build_object(''error'', err); end if;
  return public._timeclock_status(p_employee);
end';

-- p_action: in (clock in, or back from lunch) | lunch (out for lunch) | out (done for the day).
-- Always the server's time. Returns the new status with done = the action, or error = state when
-- the action doesn't fit (already clocked in, already out).
create or replace function public.timeclock_punch(p_token text, p_employee uuid, p_pin text, p_action text)
returns jsonb language plpgsql security definer set search_path = public as '
declare
  err text := public._timeclock_check(p_token, p_employee, p_pin);
  st jsonb;
begin
  if err is not null then return jsonb_build_object(''error'', err); end if;
  st := public._timeclock_status(p_employee);
  perform set_config(''crm.timeclock'', ''on'', true);
  if p_action = ''in'' and st->>''status'' in (''out'', ''lunch'') then
    insert into public.time_entries (employee_id, clock_in, source, device_id)
    values (p_employee, now(), ''clock'', public._timeclock_device(p_token));
  elsif p_action in (''lunch'', ''out'') and st->>''status'' = ''in'' then
    update public.time_entries set clock_out = now(), out_reason = p_action
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
  return public._timeclock_status(p_employee) || jsonb_build_object(''done'', p_action, ''at'', now());
end';

-- ───────────────────────── function privileges ─────────────────────────
-- Supabase grants EXECUTE to anon by default; tighten.
revoke execute on function public.create_late_fees(date) from public, anon;
grant  execute on function public.create_late_fees(date) to authenticated;
revoke execute on function public.receipt_signature_touch() from public, anon, authenticated;
revoke execute on function public.can_payroll() from public, anon;
revoke execute on function public.time_entries_guard() from public, anon, authenticated;
revoke execute on function public.payroll_period(date) from public, anon;
grant  execute on function public.payroll_period(date) to authenticated;
revoke execute on function public.payroll_week_start(date) from public, anon;
grant  execute on function public.payroll_week_start(date) to authenticated;
revoke execute on function public.payroll_hours(date, date) from public, anon;
grant  execute on function public.payroll_hours(date, date) to authenticated;
revoke execute on function public.payroll_close_period(date, date) from public, anon;
grant  execute on function public.payroll_close_period(date, date) to authenticated;
revoke execute on function public.payroll_set_pin(uuid, text) from public, anon;
grant  execute on function public.payroll_set_pin(uuid, text) to authenticated;
revoke execute on function public.timeclock_add_device(text) from public, anon;
grant  execute on function public.timeclock_add_device(text) to authenticated;
revoke execute on function public._timeclock_device(text) from public, anon, authenticated;
revoke execute on function public._timeclock_check(text, uuid, text) from public, anon, authenticated;
revoke execute on function public._timeclock_status(uuid) from public, anon, authenticated;
revoke execute on function public.timeclock_roster(text) from public;
grant  execute on function public.timeclock_roster(text) to anon, authenticated;
revoke execute on function public.timeclock_state(text, uuid, text) from public;
grant  execute on function public.timeclock_state(text, uuid, text) to anon, authenticated;
revoke execute on function public.timeclock_punch(text, uuid, text, text) from public;
grant  execute on function public.timeclock_punch(text, uuid, text, text) to anon, authenticated;
