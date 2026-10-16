-- Creativa CRM — "Graduated" next to "Withdrawn", and what families paid in Aug–Sep (old billing system) for
-- annual statements.
-- Run once in the Supabase SQL editor, after 001–010 (in that order). Safe to run again.
--
--   students.status        gains 'graduated' (finished at the school; withdrawn_on is their last day). Like a
--                          withdrawn child, a graduated one is billed only for periods that started on or before it.
--   billing_history        gains paid: what the family paid through the old billing system for that sheet's
--                          period, used on annual statements for the months before the CRM (school year from
--                          Aug 10), and needs_check: a best guess finance staff should confirm (Reports →
--                          Annual statements), set where a family carried a balance or had a credit.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.students drop constraint if exists students_status_check;
alter table public.students add constraint students_status_check
  check (status in ('enrolled','waitlist','withdrawn','graduated'));

-- Same as in 007, with graduated children treated like withdrawn ones.
create or replace function public.create_period_invoices(p_period date)
returns int language plpgsql security definer set search_path = public as '
declare
  s public.settings;
  n int;
begin
  if not public.can_edit_finance() then raise exception ''Only staff who can record payments can create invoices''; end if;
  select * into s from public.settings where id = 1;
  if p_period is null or (p_period - s.billing_anchor) % s.billing_period_days <> 0 then
    raise exception ''% is not a billing Monday'', p_period;
  end if;
  insert into public.invoices (student_id, kind, description, period_start, invoice_date, due_date, amount, created_by)
  select st.id, ''tuition'', coalesce(f.billing_program, ''Tuition''), p_period, p_period, p_period,
         case f.tuition_frequency when ''weekly'' then f.tuition_amount * 2 else f.tuition_amount end, auth.uid()
    from public.students st
    join public.student_finance f on f.student_id = st.id
   where f.bill_family and f.tuition_amount > 0 and f.tuition_frequency in (''biweekly'', ''weekly'')
     and not (''stepup_pending'' = any (f.funding))
     and (st.status = ''enrolled'' or (st.status in (''withdrawn'', ''graduated'') and st.withdrawn_on >= p_period))
     and (st.start_date is null or st.start_date < p_period + s.billing_period_days)
     and not exists (select 1 from public.invoices i
                      where i.student_id = st.id and i.kind = ''tuition'' and i.period_start = p_period and not i.void);
  get diagnostics n = row_count;
  return n;
end';
revoke execute on function public.create_period_invoices(date) from public, anon;
grant  execute on function public.create_period_invoices(date) to authenticated;

alter table public.billing_history
  add column if not exists paid numeric(10,2) check (paid >= 0 and paid < 100000),
  add column if not exists needs_check boolean not null default false;
