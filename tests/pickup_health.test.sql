-- Migration 030: Authorized pick-up contacts, allergies and medicine at school.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/030_pickup_health.sql
\ir ../supabase/migrations/030_pickup_health.sql

insert into public.students (name, status, allergies) values ('Pick Kid', 'enrolled', 'Peanuts');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- a teacher
insert into public.student_contacts (student_id, role, relationship, first_name, last_name, cell_phone)
  select id, 'pickup', 'Grandmother', 'Ana', 'Pérez', '(305) 555-0101' from public.students where name = 'Pick Kid';
select pg_temp.ok((select count(*) = 1 from public.student_contacts where role = 'pickup'), 'staff add an Authorized pick-up person');
do 'begin insert into public.student_contacts (student_id, role, first_name) select id, ''nanny'', ''X'' from public.students where name = ''Pick Kid'';
  raise exception ''FAIL: odd role''; exception when check_violation then null; end';
select pg_temp.ok(true, 'an unknown contact role is refused');
insert into public.student_medications (student_id, name, details, expires_on)
  select id, 'EpiPen Jr', 'Peanuts: one shot, call 911', '2026-12-01' from public.students where name = 'Pick Kid';
update public.student_medications set expires_on = '2027-03-01' where name = 'EpiPen Jr';
select pg_temp.ok((select expires_on = '2027-03-01' from public.student_medications where name = 'EpiPen Jr'), 'staff add medicine and change its expiration');
do 'begin insert into public.student_medications (student_id, name) select id, ''  '' from public.students where name = ''Pick Kid'';
  raise exception ''FAIL: blank medicine''; exception when check_violation then null; end';
select pg_temp.ok(true, 'medicine needs a name');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.ok((select allergies = 'Peanuts' from public.students where name = 'Pick Kid'), 'allergies are on the child');
reset role;
select pg_temp.ok((select count(*) >= 2 from public.change_log where table_name = 'student_medications'
                     and student_id = (select id from public.students where name = 'Pick Kid')), 'medicine changes show on the child''s changes');
set role anon;
do 'begin perform 1 from public.student_medications; raise exception ''FAIL: anon read''; exception when insufficient_privilege then null; end';
reset role;
delete from public.students where name = 'Pick Kid';
select pg_temp.ok((select count(*) = 0 from public.student_medications), 'a child''s medicine goes with them');
\echo ALL PICK-UP AND HEALTH TESTS PASSED
