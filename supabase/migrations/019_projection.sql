-- Creativa CRM — when a family in the Pipeline will start, and at what tuition, for the money projection (Money → Projection),
-- and whether a family on the waiting list has paid registration (that's what holds their spot).
-- Run once in the Supabase SQL editor, after 018_weekly_late_fees.sql. Safe to run again.
--
--   inquiries.start_on          the day the child is expected to start (staff set it; the website's "wants to start" stays as typed)
--   inquiries.expected_tuition  what the family will pay, and how often (expected_freq: weekly, biweekly or monthly), so the
--                               projection can count them from that day. Carried over when the inquiry becomes a student.
--   inquiries.reg_paid_on       the day the family paid registration, and how much (reg_amount), for families who aren't
--   inquiries.reg_amount        in the CRM as students yet. Carried over when they're added to the waiting list or enrolled.
--   create_period_invoices      a child who starts in the second week of a two-week period is billed just that week, due
--                               their first Monday ("Bill this period" used to bill them the whole two weeks).
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.inquiries
  add column if not exists start_on date,
  add column if not exists expected_tuition numeric(10,2) check (expected_tuition >= 0 and expected_tuition < 100000),
  add column if not exists expected_freq text not null default 'biweekly' check (expected_freq in ('weekly', 'biweekly', 'monthly')),
  add column if not exists reg_paid_on date,
  add column if not exists reg_amount numeric(10,2) check (reg_amount >= 0 and reg_amount < 100000);

-- Same as in 011, but a child whose start date is in the second week is billed one week, due that Monday.
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
  insert into public.invoices (student_id, kind, description, period_start, invoice_date, due_date, amount, note, created_by)
  select st.id, ''tuition'', coalesce(f.billing_program, ''Tuition''), p_period, p_period,
         case when wk2 then p_period + 7 else p_period end,
         round((case f.tuition_frequency when ''weekly'' then f.tuition_amount * 2 else f.tuition_amount end) / (case when wk2 then 2 else 1 end), 2),
         case when wk2 then ''Starts '' || to_char(st.start_date, ''Mon FMDD'') || '': one week'' end,
         auth.uid()
    from public.students st
    join public.student_finance f on f.student_id = st.id
    cross join lateral (select st.start_date is not null and st.start_date >= p_period + 7 as wk2) w
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
