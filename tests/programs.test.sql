-- Migration 038: one name per program (the class's name), whatever the spelling, and the cards already saved cleaned up.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
update public.classrooms set teachers = 'Ms. Rivera & Ms. Stone' where name = 'Late 3s';
update public.classrooms set teachers = 'Ms. Kim' where name = '18–23 months';
-- Saved before 038: messy, and last updated a while ago.
insert into public.inquiries (source, parent_name, phone, child_name, program, updated_at)
values ('manual', 'Old Card', '3055550111', 'Old Kid', 'late 2s', now() - interval '40 days');
\ir ../supabase/migrations/038_program_classes.sql
\ir ../supabase/migrations/038_program_classes.sql
select pg_temp.ok((select program = 'Late 2s' and updated_at < now() - interval '39 days' from public.inquiries where parent_name = 'Old Card'),
  'a card already saved is cleaned up, and keeps its last-updated date');
select pg_temp.ok(public._program_canon('Late 3''s Ms. Rivera') = 'Late 3s', 'Late 3''s Ms. Rivera');
select pg_temp.ok(public._program_canon('18-23 months (Ms.Kim)') = '18–23 months', '18-23 months (Ms.Kim)');
select pg_temp.ok(public._program_canon('Early Twos') = 'Early 2s', 'Early Twos');
select pg_temp.ok(public._program_canon('VPK (4–5 Years)') = 'VPK', 'VPK (4–5 Years)');
select pg_temp.ok(public._program_canon('Ms. Rivera') = 'Late 3s', 'only the teacher: her class');
select pg_temp.ok(public._program_canon('ms stone') = 'Late 3s', 'the second teacher too');
select pg_temp.ok(public._program_canon('Summer camp') = 'Summer camp', 'anything else stays as written');
select pg_temp.ok(public._program_canon('  ') is null, 'blank is empty');
update public.classrooms set name = '18-23 months' where name = '18–23 months';
select pg_temp.ok(public._program_canon('18–23 Months') = '18-23 months', 'spelled like the class on Settings');
update public.classrooms set name = '18–23 months' where name = '18-23 months';
update public.inquiries set program = 'late 3s ms rivera' where parent_name = 'Old Card';
select pg_temp.ok((select program = 'Late 3s' from public.inquiries where parent_name = 'Old Card'), 'a program typed on a card is cleaned up');
insert into public.inquiries (source, parent_name, phone, child_name, program) values ('manual', 'New Card', '3055550112', 'New Kid', 'kinder');
select pg_temp.ok((select program = 'Kindergarten' from public.inquiries where parent_name = 'New Card'), 'a new card too');
delete from public.inquiries where parent_name in ('Old Card', 'New Card');
update public.classrooms set teachers = null where name in ('Late 3s', '18–23 months');
\echo ALL PROGRAM TESTS PASSED
