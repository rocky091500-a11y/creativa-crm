-- Migration 023: registration for next school year. Runs after school_calendar.test.sql.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/023_registration.sql
\ir ../supabase/migrations/023_registration.sql
select pg_temp.as_user(null);
select pg_temp.ok((select reg_year = '2027-28' and reg_opens = '2026-11-09' from public.settings where id = 1), 'registration for 2027-28, from Nov 9');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- records payments
insert into public.registrations (school_year, student_id, status)
  select '2027-28', id, 'returning' from public.students where name = 'Nina Newstart';
do 'begin insert into public.registrations (school_year, student_id) select ''2027-28'', id from public.students where name = ''Nina Newstart'';
  raise exception ''FAIL: two for one year''; exception when unique_violation then null; end';
do 'begin update public.registrations set status = ''maybe''; raise exception ''FAIL: status''; exception when check_violation then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- finance view only
select pg_temp.ok((select count(*) = 1 from public.registrations), 'finance view sees registrations');
do 'begin update public.registrations set status = ''not_returning''; if found then raise exception ''FAIL: view-only changed one''; end if; end';
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select status = 'returning' from public.registrations), 'unchanged');
\echo ALL REGISTRATION TESTS PASSED
