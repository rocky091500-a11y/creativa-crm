-- Creativa CRM — fall re-registration: for each child, three separate answers for next school year (Enrollment →
-- Registration): coming back? (a family that hasn't answered is "No answer yet", not "Yes"), registration paid, and seat
-- reserved in next year's class. So the open spots for new families are each class's capacity minus the seats reserved and
-- the families who said yes, and the families who still owe an answer are a short list.
-- Run once in the Supabase SQL editor, after 030_pickup_health.sql. Safe to run again.
--
--   registrations.status       gains 'no_answer' (the default now): the family hasn't said yet.
--   registrations.reserved_on  the day their seat in next year's class was reserved: by itself when the registration is
--                              paid in full, or ticked by the office (registration_reserve). Saying "No" gives the seat up.
--                              When this column is first added, registrations already paid in full get their seat.
--   registration_pay           as in 023, and reserves the seat once the bill is paid in full.
--   registration_save          as in 023 (a new row starts as No answer yet), and "No" gives the seat up.
--   registration_reserve       reserves (or gives up) a child's seat; reserving means they're coming back.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.registrations drop constraint if exists registrations_status_check;
alter table public.registrations add constraint registrations_status_check
  check (status in ('returning', 'not_returning', 'undecided', 'no_answer'));
alter table public.registrations alter column status set default 'no_answer';

do '
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = ''public'' and table_name = ''registrations'' and column_name = ''reserved_on'') then
    alter table public.registrations add column reserved_on date;
    update public.registrations r
       set reserved_on = (select max(p.paid_on) from public.payments p where p.invoice_id = r.invoice_id)
      from public.invoices i
     where i.id = r.invoice_id and not i.void and r.status = ''returning'' and i.amount > 0
       and (select coalesce(sum(p.amount), 0) from public.payments p where p.invoice_id = i.id) >= i.amount;
  end if;
end';

create or replace function public.registration_save(p_student uuid, p_year text, p_next uuid, p_status text)
returns public.registrations language plpgsql security definer set search_path = public as '
declare
  r public.registrations;
  fee numeric;
  paid numeric;
begin
  if not public.can_edit_finance() then raise exception ''Only staff who record payments can change registrations''; end if;
  insert into public.registrations (school_year, student_id, next_classroom_id, status)
  values (p_year, p_student, p_next, coalesce(p_status, ''no_answer''))
  on conflict (school_year, student_id) do update set next_classroom_id = excluded.next_classroom_id, status = excluded.status
  returning * into r;
  if r.status = ''not_returning'' and r.reserved_on is not null then
    update public.registrations set reserved_on = null where id = r.id returning * into r;
  end if;
  if r.invoice_id is not null then
    select coalesce(sum(amount), 0) into paid from public.payments where invoice_id = r.invoice_id;
    if r.status <> ''returning'' and paid = 0 then
      update public.registrations set invoice_id = null where id = r.id returning * into r;
      delete from public.invoices i where i.kind = ''fee'' and i.student_id = p_student
        and not exists (select 1 from public.payments x where x.invoice_id = i.id)
        and i.id not in (select invoice_id from public.registrations where invoice_id is not null)
        and i.description = ''Registration '' || replace(p_year, ''-'', ''–'');
    else
      select registration_fee into fee from public.classrooms where id = r.next_classroom_id;
      if fee is not null then update public.invoices set amount = greatest(fee, paid) where id = r.invoice_id and not void; end if;
    end if;
  end if;
  return r;
end';

create or replace function public.registration_pay(p_student uuid, p_year text, p_next uuid, p_amount numeric, p_paid_on date,
  p_method text, p_payer text, p_reference text, p_note text)
returns public.payments language plpgsql security definer set search_path = public as '
declare
  r public.registrations;
  inv uuid;
  fee numeric;
  pay public.payments;
begin
  if not public.can_edit_finance() then raise exception ''Only staff who record payments can record registration''; end if;
  if p_amount is null or p_amount <= 0 then raise exception ''Type the amount''; end if;
  insert into public.registrations (school_year, student_id, next_classroom_id, status)
  values (p_year, p_student, p_next, ''returning'')
  on conflict (school_year, student_id) do update
    set status = ''returning'', next_classroom_id = coalesce(excluded.next_classroom_id, public.registrations.next_classroom_id)
  returning * into r;
  select * into r from public.registrations where id = r.id for update;   -- one bill per child per year, even from two devices
  select id into inv from public.invoices where id = r.invoice_id and not void;
  if inv is null then
    select registration_fee into fee from public.classrooms where id = r.next_classroom_id;
    insert into public.invoices (student_id, kind, description, invoice_date, due_date, amount, created_by)
    values (p_student, ''fee'', ''Registration '' || replace(p_year, ''-'', ''–''), coalesce(p_paid_on, current_date),
            public.reg_year_start(p_year), coalesce(fee, p_amount), auth.uid())
    returning id into inv;
    update public.registrations set invoice_id = inv where id = r.id;
  end if;
  insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, method, payer, reference, note, created_by)
  values (p_student, inv, coalesce(p_paid_on, current_date), public.reg_year_start(p_year), p_amount, coalesce(p_method, ''cash''),
          coalesce(p_payer, ''parent''), nullif(trim(p_reference), ''''), nullif(trim(p_note), ''''), auth.uid())
  returning * into pay;
  -- Paid in full: their seat is reserved.
  update public.registrations set reserved_on = coalesce(reserved_on, pay.paid_on)
   where id = r.id and (select coalesce(sum(p.amount), 0) from public.payments p where p.invoice_id = inv)
                       >= (select i.amount from public.invoices i where i.id = inv);
  return pay;
end';

create or replace function public.registration_reserve(p_student uuid, p_year text, p_next uuid, p_reserved boolean)
returns public.registrations language plpgsql security definer set search_path = public as '
declare
  r public.registrations;
begin
  if not public.can_edit_finance() then raise exception ''Only staff who record payments can reserve seats''; end if;
  insert into public.registrations (school_year, student_id, next_classroom_id, status, reserved_on)
  values (p_year, p_student, p_next, case when p_reserved then ''returning'' else ''no_answer'' end,
          case when p_reserved then current_date end)
  on conflict (school_year, student_id) do update
    set reserved_on = case when p_reserved then coalesce(public.registrations.reserved_on, current_date) end,
        status = case when p_reserved then ''returning'' else public.registrations.status end
  returning * into r;
  return r;
end';

revoke execute on function public.registration_reserve(uuid, text, uuid, boolean) from public, anon;
grant  execute on function public.registration_reserve(uuid, text, uuid, boolean) to authenticated;
