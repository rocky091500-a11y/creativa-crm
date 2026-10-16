-- Migration 012: who changed what. Runs last (users from db.test.sql: owner = admin, teacher = staff, books = finance edit).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/012_change_log.sql
select pg_temp.as_user(null);
update public.profiles set finance = 'edit', payroll = false where email = 'books@creativaacademy.com';
update public.profiles set finance = 'none', payroll = false where email = 'teacher@creativaacademy.com';
truncate public.change_log;
insert into public.students (name, status) values ('Log Kid', 'enrolled');   -- no one signed in: not logged
select pg_temp.ok((select count(*) = 0 from public.change_log), 'imports and the system are not logged');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- the bookkeeper (finance edit)
update public.students set notes = 'Allergic to nuts' where name = 'Log Kid';
update public.students set notes = 'Allergic to nuts' where name = 'Log Kid';   -- no real change
insert into public.student_finance (student_id, funding, tuition_amount, tuition_frequency)
  select id, '{}', 560, 'biweekly' from public.students where name = 'Log Kid';
insert into public.payments (student_id, paid_on, covers_month, amount, payer, method)
  select id, current_date, date_trunc('month', current_date)::date, 560, 'parent', 'zelle' from public.students where name = 'Log Kid';
update public.payments set amount = 500 where student_id = (select id from public.students where name = 'Log Kid');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 4 from public.change_log), 'four real changes logged (an update that changes nothing is not)');
select pg_temp.ok((select actor = '00000000-0000-0000-0000-00000000000d' and student_id = (select id from public.students where name = 'Log Kid')
                     and diff = '{"notes": [null, "Allergic to nuts"]}' from public.change_log where table_name = 'students'), 'who, which child, what changed');
select pg_temp.ok((select diff -> 'amount' = '[560.00, 500.00]' and data ->> 'method' = 'zelle' from public.change_log where table_name = 'payments' and action = 'update'),
                  'payment change: old and new amount');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- staff without finance
select pg_temp.ok((select string_agg(table_name, ',') from public.change_log) = 'students', 'staff see enrollment changes, not tuition');
do 'begin insert into public.change_log (area, table_name, action) values (''finance'', ''x'', ''insert''); raise exception ''FAIL: wrote the log'';
exception when insufficient_privilege then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
do 'begin delete from public.change_log; raise exception ''FAIL: deleted from the log''; exception when insufficient_privilege then null; end';
select pg_temp.ok(public.mark_changes_seen() is not null, 'mark the Changes page as seen');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 4 from public.change_log), 'nobody can delete the log');
select pg_temp.ok((select changes_seen_at is not null from public.profiles where email = 'books@creativaacademy.com'), 'seen time saved');
select pg_temp.ok((select count(*) = 4 from public.change_log), 'marking seen is not itself a change');
set role anon;
do 'begin perform count(*) from public.change_log; raise exception ''FAIL: anon reads the log''; exception when insufficient_privilege then null; end';
reset role;
\echo ALL CHANGE LOG TESTS PASSED
