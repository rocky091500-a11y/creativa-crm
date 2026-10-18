-- Migration 021: the school calendar. Runs after rates_bills.test.sql.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/021_school_calendar.sql
\ir ../supabase/migrations/021_school_calendar.sql
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 14 from public.school_closures), 'the 2026–27 holidays, once');
select pg_temp.ok((select count(*) = 1 from public.school_closures where not staff_paid and starts_on = '2026-12-28' and ends_on = '2027-01-01'),
  'one week of winter break unpaid for staff');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- staff
select pg_temp.ok((select count(*) = 14 from public.school_closures), 'staff see the calendar');
do 'begin insert into public.school_closures (name, starts_on, ends_on) values (''x'', ''2027-01-04'', ''2027-01-04''); raise exception ''FAIL: staff added a day'';
  exception when insufficient_privilege then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');   -- admin
update public.school_closures set staff_paid = true where not staff_paid;
do 'begin insert into public.school_closures (name, starts_on, ends_on) values (''x'', ''2027-01-05'', ''2027-01-04''); raise exception ''FAIL: ends before it starts'';
  exception when check_violation then null; end';
reset role;
\echo ALL SCHOOL CALENDAR TESTS PASSED
