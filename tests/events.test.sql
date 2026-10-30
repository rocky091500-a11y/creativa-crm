-- Migration 029: the school's calendar of activities, reminders, themes and menus.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/029_school_events.sql
\ir ../supabase/migrations/029_school_events.sql

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');   -- an admin
insert into public.school_events (kind, title, details, starts_on, ends_on) values
  ('event', 'Christmas pictures', '1st floor', '2026-11-09', null),
  ('theme', 'Fall harvest', null, '2026-11-09', '2026-11-13');
select pg_temp.ok((select count(*) = 2 from public.school_events), 'the office adds to the calendar');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- records payments: office
update public.school_events set details = '1st floor and Ms. Paty''s class' where title = 'Christmas pictures';
select pg_temp.ok((select details like '%Paty%' from public.school_events where title = 'Christmas pictures'), '... and changes it');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- a teacher: sees it, can't change it
select pg_temp.ok((select count(*) = 2 from public.school_events), 'all staff see the calendar');
do 'begin insert into public.school_events (title, starts_on) values (''Party'', ''2026-11-20''); raise exception ''FAIL: a teacher added'';
exception when insufficient_privilege then null; end';
update public.school_events set title = 'Changed' where title = 'Fall harvest';
select pg_temp.ok((select count(*) = 0 from public.school_events where title = 'Changed'), 'a teacher can''t change it');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do 'begin insert into public.school_events (title, starts_on, ends_on) values (''Backwards'', ''2026-11-20'', ''2026-11-19''); raise exception ''FAIL: backwards'';
exception when check_violation then null; end';
do 'begin insert into public.school_events (kind, title, starts_on) values (''party'', ''Odd'', ''2026-11-20''); raise exception ''FAIL: kind'';
exception when check_violation then null; end';
select pg_temp.ok(true, 'an end before the start, or an unknown kind, is refused');
reset role;
select pg_temp.ok((select count(*) >= 2 from public.change_log where table_name = 'school_events'), 'shows on the Changes page');
set role anon;
do 'begin perform 1 from public.school_events; raise exception ''FAIL: anon read''; exception when insufficient_privilege then null; end';
reset role;
\echo ALL CALENDAR EVENT TESTS PASSED
