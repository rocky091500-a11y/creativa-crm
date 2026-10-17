-- Creativa CRM — late fees for families who pay by the week.
-- Run once in the Supabase SQL editor, after 017_money_food_program_todos.sql. Safe to run again.
--
--   A child on a weekly rate gets a two-week bill each billing period, but the family pays one week at a time. The
--   first week is late after the period's first Friday, as before; the second week only after the second Friday. So a
--   weekly payer who has paid half the bill by then isn't late (no late fee) until the following Friday.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

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
         ''Tuition for the period starting '' || to_char(i.period_start, ''FMMon FMDD'') || '' not paid by Friday ''
           || to_char(i.due_date + case when w.weekly and w.paid >= i.amount / 2 then 11 else 4 end, ''FMMon FMDD''),
         auth.uid()
    from public.invoices i
    cross join lateral (select coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0) as paid,
                               exists (select 1 from public.student_finance f where f.student_id = i.student_id
                                         and f.tuition_frequency = ''weekly'') as weekly) w
   where i.kind = ''tuition'' and not i.void and i.period_start = p_period and today > i.due_date + 4
     and i.amount > w.paid
     and not (w.weekly and w.paid >= i.amount / 2 and today <= i.due_date + 11)
     and not exists (select 1 from public.invoices f where f.late_fee_for = i.id);
  get diagnostics n = row_count;
  return n;
end';
revoke execute on function public.create_late_fees(date) from public, anon;
grant  execute on function public.create_late_fees(date) to authenticated;
