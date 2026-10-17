-- Migration 019: start date and expected tuition on inquiries. Runs after weekly.test.sql.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/019_projection.sql
\ir ../supabase/migrations/019_projection.sql
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- staff can set it
update public.inquiries set start_on = '2026-11-02', expected_tuition = 560, expected_freq = 'biweekly'
 where id = (select id from public.inquiries order by created_at limit 1);
select pg_temp.ok((select count(*) = 1 from public.inquiries where start_on = '2026-11-02' and expected_tuition = 560), 'staff set the start day and tuition');
update public.inquiries set reg_paid_on = '2026-10-15', reg_amount = 150
 where id = (select id from public.inquiries order by created_at limit 1);
select pg_temp.ok((select count(*) = 1 from public.inquiries where reg_paid_on = '2026-10-15' and reg_amount = 150), 'staff record registration paid');
do 'begin update public.inquiries set reg_amount = -1; raise exception ''FAIL: amount''; exception when check_violation then null; end';
do 'begin update public.inquiries set expected_freq = ''daily''; raise exception ''FAIL: frequency''; exception when check_violation then null; end';
reset role;

-- Starting in the second week of a period: billed that one week, due that Monday.
select pg_temp.as_user(null);
create temp table p as select billing_anchor + billing_period_days * 30 as d from public.settings where id = 1;
grant select on p to authenticated;
insert into public.students (name, status, start_date) select x.n, 'enrolled', p.d + x.k from p,
  (values ('Nina Newstart', 7), ('Willa Weekstart', 8), ('Stan Fullperiod', 0)) as x(n, k);
insert into public.student_finance (student_id, tuition_amount, tuition_frequency)
  select id, case when name like 'W%' then 280 else 560 end, case when name like 'W%' then 'weekly' else 'biweekly' end
    from public.students where name in ('Nina Newstart', 'Willa Weekstart', 'Stan Fullperiod');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok(public.create_period_invoices((select d from p)) >= 3, 'billed the period');
select pg_temp.ok((select count(*) = 2 from public.invoices i join public.students s on s.id = i.student_id
  where s.name in ('Nina Newstart', 'Willa Weekstart') and i.amount = 280 and i.due_date = (select d + 7 from p) and i.note like 'Starts %: one week'),
  'starting the second week: one week, due that Monday');
select pg_temp.ok((select count(*) = 1 from public.invoices i join public.students s on s.id = i.student_id
  where s.name = 'Stan Fullperiod' and i.amount = 560 and i.due_date = (select d from p) and i.note is null), 'starting the first week: the whole period');
reset role;
\echo ALL PROJECTION TESTS PASSED
