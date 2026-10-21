-- Creativa CRM — pause a child who's out for a while (sick, a long trip): no tuition until they're back
-- (Enrollment → the child → Paused until). Run once in the Supabase SQL editor, after 026_unpaid_staff.sql. Safe to run again.
--
--   students.paused_from     the day the pause starts (the CRM fills in today), and
--   students.paused_until    the day they come back (a Saturday or Sunday counts as the Monday after). Meanwhile they stay
--                            enrolled (class counts, inspection list), but they aren't billed and aren't in the tuition
--                            expected (Tuition's weekly box, Money's projection). Billing starts again by itself.
--   students.pause_note      why (out sick), shown with the pause.
--   create_period_invoices   the same as in 019, but for a billing period the pause has started by (the one it starts in,
--                            and later ones) the day they're back counts like a start date: no bill for a period they're
--                            away for, one week if they're back in its second week (due that Monday), the whole period if
--                            they're back in its first week. Earlier periods are billed as usual.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.students
  add column if not exists paused_from date,
  add column if not exists paused_until date,
  add column if not exists pause_note text check (length(pause_note) <= 200);

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
         case when wk2 then (case when back then ''Back '' else ''Starts '' end) || to_char(d.first_day, ''Mon FMDD'') || '': one week'' end,
         auth.uid()
    from public.students st
    join public.student_finance f on f.student_id = st.id
    cross join lateral (select case when coalesce(st.paused_from, ''-infinity''::date) < p_period + s.billing_period_days
                                    then st.paused_until + (case extract(isodow from st.paused_until) when 6 then 2 when 7 then 1 else 0 end)::int
                               end as back_day) b
    cross join lateral (select greatest(st.start_date, b.back_day) as first_day,
                               b.back_day is not null and b.back_day > coalesce(st.start_date, b.back_day - 1) as back) d
    cross join lateral (select d.first_day is not null and d.first_day >= p_period + 7 as wk2) w
   where f.bill_family and f.tuition_amount > 0 and f.tuition_frequency in (''biweekly'', ''weekly'')
     and not (''stepup_pending'' = any (f.funding))
     and (st.status = ''enrolled'' or (st.status in (''withdrawn'', ''graduated'') and st.withdrawn_on >= p_period))
     and (d.first_day is null or d.first_day < p_period + s.billing_period_days)
     and not exists (select 1 from public.invoices i
                      where i.student_id = st.id and i.kind = ''tuition'' and i.period_start = p_period and not i.void);
  get diagnostics n = row_count;
  return n;
end';

revoke execute on function public.create_period_invoices(date) from public, anon;
grant  execute on function public.create_period_invoices(date) to authenticated;
