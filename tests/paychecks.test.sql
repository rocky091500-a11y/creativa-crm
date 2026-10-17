-- Migration 016: paychecks from Patriot. Runs after lists.test.sql (owner = admin, teacher = staff, books = finance edit).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/016_paychecks.sql
\ir ../supabase/migrations/016_paychecks.sql
select pg_temp.as_user(null);
update public.profiles set payroll = false where email = 'books@creativaacademy.com';
insert into public.employees (first_name, last_name, position, pay_rate) values ('Pat', 'Check', 'Teacher', 15.50);

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- finance, no payroll
do 'begin insert into public.paychecks (pay_date, period_start, period_end, name, gross) values (''2026-10-22'', ''2026-10-02'', ''2026-10-15'', ''X'', 1);
  raise exception ''FAIL: no payroll access added a paycheck''; exception when insufficient_privilege then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');   -- admin
insert into public.paychecks (pay_date, period_start, period_end, employee_id, name, hours, gross, net)
  select '2026-10-22', '2026-10-02', '2026-10-15', id, 'CHECK, PAT', 80, 1240, 1145.14 from public.employees where first_name = 'Pat' and last_name = 'Check';
do 'begin insert into public.paychecks (pay_date, period_start, period_end, name, gross) values (''2026-10-22'', ''2026-10-02'', ''2026-10-15'', ''CHECK, PAT'', 1);
  raise exception ''FAIL: the same person twice in one payroll''; exception when unique_violation then null; end';
do 'begin insert into public.paychecks (pay_date, period_start, period_end, name, gross) values (''2026-10-22'', ''2026-10-15'', ''2026-10-02'', ''Y'', 1);
  raise exception ''FAIL: period ends before it starts''; exception when check_violation then null; end';
update public.paychecks set net = 1145.15 where name = 'CHECK, PAT';
update public.profiles set payroll = true where email = 'books@creativaacademy.com';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- now with payroll access
select pg_temp.ok((select count(*) = 1 from public.paychecks), 'payroll access sees paychecks');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- staff
select pg_temp.ok((select count(*) = 0 from public.paychecks), 'staff without payroll access see none');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 2 from public.change_log where table_name = 'paychecks' and area = 'payroll'
  and actor = '00000000-0000-0000-0000-00000000000a'), 'adding and changing paychecks show on Changes, under Payroll');
select pg_temp.ok((select count(*) = 2 from public.change_log where table_name = 'paychecks' and employee_id is not null), '... linked to the staff member');
set role anon;
do 'begin perform count(*) from public.paychecks; raise exception ''FAIL: anon reads paychecks''; exception when insufficient_privilege then null; end';
reset role;
\echo ALL PAYCHECK TESTS PASSED
