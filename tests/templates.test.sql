-- Migration 014: saved texts ("My messages"). Runs after messages.test.sql (owner = admin, teacher = staff, books = finance edit).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/014_message_templates.sql
select pg_temp.as_user(null);
select pg_temp.ok((select string_agg(name, ',' order by sort) from public.message_templates) = 'Payment reminder,Activity reminder,School closed',
  'starts with three examples');
\ir ../supabase/migrations/014_message_templates.sql
select pg_temp.ok((select count(*) = 3 from public.message_templates), 'running it again adds nothing');
update public.profiles set finance = 'edit' where email = 'books@creativaacademy.com';
update public.profiles set finance = 'view' where email = 'teacher@creativaacademy.com';

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- view-only finance: can't see or save them
select pg_temp.ok((select count(*) = 0 from public.message_templates), 'view-only finance sees no saved texts');
do 'begin insert into public.message_templates (name, body) values (''x'', ''y''); raise exception ''FAIL: view-only saved a text'';
exception when insufficient_privilege then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- finance editor
insert into public.message_templates (name, body, sort) values ('Picture day', 'Hi {parent}, picture day for {child} is Friday!', 4);
select pg_temp.ok((select created_by = '00000000-0000-0000-0000-00000000000d' from public.message_templates where name = 'Picture day'), 'saved, with who saved it');
update public.message_templates set body = 'Hi {parent}, picture day is Friday. - {me}' where name = 'Picture day';
delete from public.message_templates where name = 'School closed';
do 'begin insert into public.message_templates (name, body) values ('' '', ''y''); raise exception ''FAIL: saved without a name'';
exception when check_violation then null; end';
select pg_temp.ok((select string_agg(name, ',' order by sort) from public.message_templates) = 'Payment reminder,Activity reminder,Picture day',
  'change and delete');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 3 from public.change_log where table_name = 'message_templates' and actor = '00000000-0000-0000-0000-00000000000d'),
  'saving, changing and deleting show on Changes');
set role anon;
do 'begin perform count(*) from public.message_templates; raise exception ''FAIL: anon reads saved texts''; exception when insufficient_privilege then null; end';
reset role;
\echo ALL SAVED MESSAGE TESTS PASSED
