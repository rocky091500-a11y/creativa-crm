-- Migration 036: yellow / blue form expirations, and a to-do a month before each expires.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
\ir ../supabase/migrations/036_health_forms.sql
\ir ../supabase/migrations/036_health_forms.sql
insert into public.students (name, status, physical_expires, immunization_status, immunization_expires)
values ('Form Kid', 'enrolled', current_date + 20, 'part_b', current_date + 90);
select pg_temp.ok((select count(*) = 2 from public.todos where ref like 'form-%:' || (select id from public.students where name = 'Form Kid')), 'a reminder for each form');
select pg_temp.ok((select remind_days = 30 and due_on = current_date + 20 from public.todos where ref = 'form-yellow:' || (select id from public.students where name = 'Form Kid')),
  'due the day it expires, shown a month before');
update public.students set physical_expires = current_date + 200 where name = 'Form Kid';
select pg_temp.ok((select count(*) = 1 and min(due_on) = current_date + 200 from public.todos where ref = 'form-yellow:' || (select id from public.students where name = 'Form Kid')), 'a new date moves it');
update public.todos set done_at = now() where ref = 'form-yellow:' || (select id from public.students where name = 'Form Kid');
update public.students set name = 'Form Kid' where name = 'Form Kid';
select pg_temp.ok((select count(*) = 0 from public.todos where ref = 'form-yellow:' || (select id from public.students where name = 'Form Kid') and done_at is null), 'checked off: not again for the same date');
update public.students set physical_expires = current_date + 400 where name = 'Form Kid';
select pg_temp.ok((select count(*) = 1 from public.todos where ref = 'form-yellow:' || (select id from public.students where name = 'Form Kid') and done_at is null), 'a new form: a new reminder');
update public.students set immunization_status = 'part_a', immunization_expires = null where name = 'Form Kid';
select pg_temp.ok((select count(*) = 0 from public.todos where ref = 'form-blue:' || (select id from public.students where name = 'Form Kid') and done_at is null), 'completed (Part A): no reminder');
update public.students set status = 'withdrawn', withdrawn_on = current_date where name = 'Form Kid';
select pg_temp.ok((select count(*) = 0 from public.todos where ref like 'form-%:' || (select id from public.students where name = 'Form Kid') and done_at is null), 'gone when the child leaves');
do 'begin update public.students set immunization_status = ''sometimes'' where name = ''Form Kid''; raise exception ''FAIL: odd status''; exception when check_violation then null; end';
delete from public.todos where ref like 'form-%:' || (select id from public.students where name = 'Form Kid');
delete from public.students where name = 'Form Kid';
\echo ALL FORM TESTS PASSED
