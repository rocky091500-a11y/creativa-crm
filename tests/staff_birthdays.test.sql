-- Migration 037: staff birthdays (month and day) for the calendar, without the rest of Payroll.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/037_staff_birthdays.sql
\ir ../supabase/migrations/037_staff_birthdays.sql

insert into public.employees (first_name, last_name, pay_rate, birthday) values ('Bday', 'Teacher', 15, '05-27'), ('Gone', 'Helper', 14, '05-28');
update public.employees set active = false where first_name = 'Gone';
do 'begin update public.employees set birthday = ''02-30'' where first_name = ''Bday''; raise exception ''FAIL: Feb 30''; exception when check_violation then null; end';
do 'begin update public.employees set birthday = ''5-27'' where first_name = ''Bday''; raise exception ''FAIL: 5-27''; exception when check_violation then null; end';
select pg_temp.ok(true, 'only a real month and day');
update public.employees set birthday = '02-29' where first_name = 'Bday';
update public.employees set birthday = '05-27' where first_name = 'Bday';
select pg_temp.ok(true, 'Feb 29 is fine');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- a teacher: no Payroll
select pg_temp.ok((select count(*) = 0 from public.employees), 'a teacher still can''t see Payroll');
select pg_temp.ok((select count(*) = 1 from public.staff_birthdays() where name = 'Bday Teacher' and birthday = '05-27'), 'but sees the staff birthdays');
select pg_temp.ok((select count(*) = 0 from public.staff_birthdays() where name = 'Gone Helper'), 'not someone no longer active');
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 0 from public.staff_birthdays()), 'nothing without a login');
reset role;
set role anon;
do 'begin perform public.staff_birthdays(); raise exception ''FAIL: anon''; exception when insufficient_privilege then null; end';
reset role;
select pg_temp.ok(true, 'the public can''t call it');
delete from public.employees where first_name in ('Bday', 'Gone') and last_name in ('Teacher', 'Helper');
\echo ALL STAFF BIRTHDAY TESTS PASSED
