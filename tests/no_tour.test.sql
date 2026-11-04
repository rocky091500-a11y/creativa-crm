-- Migration 035: no tour needed for a returning or former family; new students on next year's registration.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
\ir ../supabase/migrations/035_no_tour.sql
\ir ../supabase/migrations/035_no_tour.sql
insert into public.inquiries (parent_name, phone, no_tour) values ('Returning Mom', '305 555 0190', 'returning'), ('Former Dad', '305 555 0191', 'former');
select pg_temp.ok((select count(*) = 2 from public.inquiries where no_tour is not null), 'returning and former families need no tour');
do 'begin insert into public.inquiries (parent_name, phone, no_tour) values (''x'', ''305 555 0192'', ''maybe''); raise exception ''FAIL: odd value'';
  exception when check_violation then null; end';
select pg_temp.ok(true, 'only returning or former');
-- A past tour on a closed day is fine; a new one from today on isn't.
insert into public.school_closures (name, starts_on, ends_on) values ('Test Closed Day', current_date - 30, current_date - 30), ('Test Closed Day 2', current_date + 30, current_date + 30);
insert into public.inquiries (parent_name, phone, tour_at) values ('Past Tour', '305 555 0193', ((current_date - 30)::text || ' 15:00:00+00')::timestamptz);
select pg_temp.ok(true, 'an old tour on what is now a closed day is kept');
do 'begin insert into public.inquiries (parent_name, phone, tour_at) values (''Future Tour'', ''305 555 0194'', ((current_date + 30)::text || '' 15:00:00+00'')::timestamptz);
  raise exception ''FAIL: future tour on a closed day''; exception when check_violation then null; end';
select pg_temp.ok(true, 'a new tour on a closed day is refused');
delete from public.school_closures where name like 'Test Closed Day%';
delete from public.inquiries where parent_name in ('Returning Mom', 'Former Dad', 'Past Tour');
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
insert into public.students (name, status) values ('New Kid', 'waitlist');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- records payments
select pg_temp.ok((select (public.registration_mark_new(id, '2027-28', null, true)).new_student from public.students where name = 'New Kid'), 'marked a new student');
select pg_temp.ok((select (public.registration_mark_new(id, '2027-28', null, true)).status = 'returning' from public.students where name = 'New Kid'), '... coming, marked again: same row');
select pg_temp.ok((select count(*) = 1 from public.registrations where student_id = (select id from public.students where name = 'New Kid')), 'one registration');
select pg_temp.ok((select (public.registration_mark_new(id, '2027-28', null, false)).new_student = false from public.students where name = 'New Kid'), 'and unmarked');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do 'begin perform public.registration_mark_new((select id from public.students where name = ''New Kid''), ''2027-28'', null, true); raise exception ''FAIL: no finance'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
reset role;
select pg_temp.as_user(null);
delete from public.students where name = 'New Kid';
\echo ALL NO TOUR / NEW STUDENT TESTS PASSED
