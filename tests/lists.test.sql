-- Migration 015: lists of families to text, and who gets group texts. Runs after templates.test.sql.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/015_message_lists.sql
select pg_temp.as_user(null);
create temp view lc as select l.name, l.funding, (select string_agg(c.name, ',' order by c.sort) from public.classrooms c where c.id = any (l.classes)) as cls
  from public.message_lists l order by l.sort;
select pg_temp.ok((select count(*) = 8 from public.message_lists), 'starts with eight lists');
select pg_temp.ok((select cls = '18–23 months,Early 2s,Late 2s' from lc where name = 'Moms 1st Floor'), '1st floor: 18–23 months, Early 2s, Late 2s');
select pg_temp.ok((select cls = 'Early 3s,Late 3s' from lc where name = 'Moms 2nd Floor'), '2nd floor: Early 3s, Late 3s');
select pg_temp.ok((select cls = 'Kindergarten' from lc where name = 'Kinder Moms') and (select cls = 'VPK' from lc where name = 'VPK Moms'), 'Kinder, VPK');
select pg_temp.ok((select cls is null and funding = '{fes_ua,fes_eo}' from lc where name = 'FES Moms'), 'FES Moms: by funding, any class');
\ir ../supabase/migrations/015_message_lists.sql
select pg_temp.ok((select count(*) = 8 from public.message_lists), 'running it again adds nothing');
select pg_temp.ok((select count(*) = 1 from public.message_templates where name = 'Missing paperwork' and body like '%{missing}%'), 'a Missing paperwork message');
select pg_temp.ok((select count(*) = 1 from information_schema.columns where table_name = 'student_contacts' and column_name = 'group_texts'), 'contacts: group texts');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- view-only finance
select pg_temp.ok((select count(*) = 0 from public.message_lists), 'view-only finance sees no lists');
do 'begin insert into public.message_lists (name) values (''x''); raise exception ''FAIL: view-only made a list'';
exception when insufficient_privilege then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- finance editor
insert into public.message_lists (name, funding, extra) values ('Front desk test', '{private}', '[{"name": "Front desk", "phone": "+17865550100"}]');
do 'begin insert into public.message_lists (name, funding) values (''x'', ''{gold}''); raise exception ''FAIL: unknown funding'';
exception when check_violation then null; end';
update public.message_lists set both_parents = true where name = 'Front desk test';
delete from public.message_lists where name = 'Front desk test';
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 3 from public.change_log where table_name = 'message_lists' and actor = '00000000-0000-0000-0000-00000000000d'),
  'making, changing and deleting a list show on Changes');
set role anon;
do 'begin perform count(*) from public.message_lists; raise exception ''FAIL: anon reads lists''; exception when insufficient_privilege then null; end';
reset role;
\echo ALL LIST TESTS PASSED
