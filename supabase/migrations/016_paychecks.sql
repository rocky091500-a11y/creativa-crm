-- Creativa CRM — paychecks from Patriot Software, kept in the CRM (Payroll → Paychecks).
-- Run once in the Supabase SQL editor, after 015_message_lists.sql. Safe to run again.
--
--   paychecks   one row per person per payroll run in Patriot: the pay date, the pay period, their name as Patriot
--               shows it ("SMITH, ANA"), the staff member it matches, hours, gross pay and net pay.
--               Patriot has no way to connect other programs, so these are pasted in from Patriot's
--               Payroll → Print Payrolls → View Details (or added by SQL). Only payroll access sees them.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create table if not exists public.paychecks (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  pay_date      date not null,
  period_start  date not null,
  period_end    date not null,
  employee_id   uuid references public.employees(id) on delete set null,
  name          text not null check (length(trim(name)) between 1 and 120),
  hours         numeric(7,2) check (hours >= 0),
  gross         numeric(10,2) not null check (gross >= 0),
  net           numeric(10,2) check (net >= 0),
  check (period_end >= period_start),
  unique (pay_date, name)
);
create index if not exists paychecks_employee_idx on public.paychecks (employee_id, pay_date desc);

alter table public.paychecks enable row level security;
revoke all on public.paychecks from anon;
drop policy if exists paychecks_select on public.paychecks;
drop policy if exists paychecks_insert on public.paychecks;
drop policy if exists paychecks_update on public.paychecks;
drop policy if exists paychecks_delete on public.paychecks;
create policy paychecks_select on public.paychecks for select to authenticated using (public.can_payroll());
create policy paychecks_insert on public.paychecks for insert to authenticated with check (public.can_payroll());
create policy paychecks_update on public.paychecks for update to authenticated using (public.can_payroll()) with check (public.can_payroll());
create policy paychecks_delete on public.paychecks for delete to authenticated using (public.can_payroll());

-- Added, changed and deleted paychecks show on the Changes page (012), under Payroll.
do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.paychecks;
    create trigger log_change after insert or update or delete on public.paychecks
      for each row execute function public.log_change(''payroll'');
  end if;
end';
