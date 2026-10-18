-- Migration 018: weekly payers' late fees. Runs after money.test.sql (books = finance edit).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/018_weekly_late_fees.sql
select pg_temp.as_user(null);
update public.settings set late_fee_amount = 30 where id = 1;
insert into public.students (name, status) values ('Wendy Weekly', 'enrolled'), ('Wally Weekly', 'enrolled'), ('Bob Biweekly', 'enrolled');
insert into public.student_finance (student_id, tuition_amount, tuition_frequency)
  select id, case when name like 'W%' then 280 else 560 end, case when name like 'W%' then 'weekly' else 'biweekly' end
    from public.students where name in ('Wendy Weekly', 'Wally Weekly', 'Bob Biweekly');
-- a period that started 6 days ago: past the first Friday, not the second
insert into public.invoices (student_id, kind, description, period_start, invoice_date, due_date, amount)
  select s.id, 'tuition', 'Tuition', ((now() at time zone 'America/New_York')::date - 6), ((now() at time zone 'America/New_York')::date - 6), ((now() at time zone 'America/New_York')::date - 6), 560
    from public.students s where s.name in ('Wendy Weekly', 'Wally Weekly', 'Bob Biweekly');
insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, method)
  select i.student_id, i.id, ((now() at time zone 'America/New_York')::date - 6), date_trunc('month', i.invoice_date)::date, 280, 'zelle'
    from public.invoices i join public.students s on s.id = i.student_id where s.name in ('Wendy Weekly', 'Bob Biweekly') and i.kind = 'tuition';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok(public.create_late_fees(((now() at time zone 'America/New_York')::date - 6)) >= 2, 'after the first Friday: late fees added');
select pg_temp.ok((select count(distinct s.name) = 2 from public.invoices f join public.invoices i on i.id = f.late_fee_for join public.students s on s.id = i.student_id
  where s.name in ('Wally Weekly', 'Bob Biweekly')), '... for the unpaid weekly payer and the half-paid biweekly one');
select pg_temp.ok((select count(*) = 0 from public.invoices f join public.invoices i on i.id = f.late_fee_for join public.students s on s.id = i.student_id
  where s.name = 'Wendy Weekly'), 'a weekly payer who paid the first week isn''t late yet');
reset role;
select pg_temp.as_user(null);
update public.invoices set period_start = period_start - 7, invoice_date = invoice_date - 7, due_date = due_date - 7
 where kind = 'tuition' and student_id = (select id from public.students where name = 'Wendy Weekly');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok(public.create_late_fees(((now() at time zone 'America/New_York')::date - 13)) >= 1, 'after the second Friday the second week is late too');   -- (other tests' bills can share that period)
select pg_temp.ok((select note from public.invoices where kind = 'fee' and description = 'Late fee'
  and late_fee_for = (select i.id from public.invoices i join public.students s on s.id = i.student_id where s.name = 'Wendy Weekly' and i.kind = 'tuition'))
  like '%not paid by Friday%', 'the note says which Friday');
reset role;
\echo ALL WEEKLY LATE FEE TESTS PASSED
