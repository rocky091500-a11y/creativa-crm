-- Creativa CRM — time clock PINs kept on file for payroll staff (Payroll → Staff), so the office can look one up when
-- someone forgets it, and easy temporary PINs (like 7777) while people choose their own.
-- Run once in the Supabase SQL editor, after 021_school_calendar.sql. Safe to run again.
--
--   employee_pins.pin   the PIN itself, kept from now on whenever a PIN is set (before, it was only kept scrambled, so nobody
--                       could look it up). Only payroll staff can read it, through payroll_pins(); the time clock still checks
--                       the scrambled copy. PINs set before this can't be unscrambled: set each one again and it's on file.
--   payroll_set_pin     a PIN typed in by payroll staff can be an easy one (7777) for now; the CRM marks it to change.
--                       A PIN the CRM makes up is never an easy one.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.employee_pins add column if not exists pin text check (pin ~ '^[0-9]{4}$');

-- Same as in 008, but it keeps the PIN on file, and a typed-in easy PIN is allowed.
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
  insert into public.employee_pins (employee_id, pin_hash, pin) values (p_employee, extensions.crypt(pin, extensions.gen_salt(''bf'', 8)), pin)
  on conflict (employee_id) do update set pin_hash = excluded.pin_hash, pin = excluded.pin, fails = 0, locked_until = null;
  update public.employees set pin_set_at = now() where id = p_employee;
  return pin;
end';

-- Everyone's PIN, for payroll staff only (null for a PIN set before this file was run).
create or replace function public.payroll_pins()
returns table (employee_id uuid, pin text) language sql stable security definer set search_path = public as '
  select p.employee_id, p.pin from public.employee_pins p where public.can_payroll();
';
revoke execute on function public.payroll_pins() from public, anon;
grant  execute on function public.payroll_pins() to authenticated;
revoke execute on function public.payroll_set_pin(uuid, text) from public, anon;
grant  execute on function public.payroll_set_pin(uuid, text) to authenticated;
