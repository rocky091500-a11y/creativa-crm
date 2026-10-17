-- Migration 017: money in and out, the food program, and the to-do list. Runs after paychecks.test.sql.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/017_money_food_program_todos.sql
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 3 from public.todos where repeat = 'monthly' and extract(day from due_on) = 1 and remind_days = 7),
  'starts with the food program, SR and VPK, due the 1st, reminded a week before');
\ir ../supabase/migrations/017_money_food_program_todos.sql
select pg_temp.ok((select count(*) = 3 from public.todos), 'running it again adds nothing');
update public.profiles set finance = 'edit', payroll = false where email = 'books@creativaacademy.com';
update public.profiles set finance = 'view', payroll = false where email = 'teacher@creativaacademy.com';

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- records payments
insert into public.money_entries (on_date, kind, category, amount, party, reference, ccfp_col) values
  ('2026-09-01', 'out', 'Food', 500, 'Test Market', '1001', 'food'),
  ('2026-09-30', 'out', 'Food service labor', 1000, 'Cook', null, 'labor');
update public.money_entries set in_totals = false where ccfp_col = 'labor';
do 'begin insert into public.money_entries (on_date, kind, category, amount) values (''2026-09-01'', ''sideways'', ''x'', 1);
  raise exception ''FAIL: kind''; exception when check_violation then null; end';
insert into public.ccfp_claims (claim_month, breakfasts, lunches, pm_snacks, meal_earnings, cash_in_lieu, food_cost, non_food_cost, status, submitted_on)
  values ('2026-09-01', 1000, 1200, 1100, 7000, 400, 500, 1080, 'submitted', '2026-10-01');
do 'begin insert into public.ccfp_claims (claim_month) values (''2026-09-01''); raise exception ''FAIL: two claims for a month'';
  exception when unique_violation then null; end';
do 'begin insert into public.ccfp_claims (claim_month) values (''2026-09-15''); raise exception ''FAIL: claim month not the 1st'';
  exception when check_violation then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- view-only finance
select pg_temp.ok((select count(*) = 2 from public.money_entries) and (select count(*) = 1 from public.ccfp_claims), 'view-only finance sees money');
do 'begin insert into public.money_entries (on_date, kind, category, amount) values (''2026-09-01'', ''in'', ''x'', 1);
  raise exception ''FAIL: view-only added money''; exception when insufficient_privilege then null; end';
select pg_temp.ok((select count(*) = 0 from public.todos), 'to-dos are for the office, not view-only staff');

-- to-dos
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
insert into public.todos (title, due_on, repeat, remind_days, assigned_to)
  values ('Pay rent', '2026-11-01', 'monthly', 3, '00000000-0000-0000-0000-00000000000d'), ('Call the plumber', '2026-10-20', 'none', 0, null);
create temp table nx as select public.todo_done((select id from public.todos where title = 'Pay rent')) as id;
select pg_temp.ok((select due_on = '2026-12-01' and done_at is null and assigned_to = '00000000-0000-0000-0000-00000000000d'
  from public.todos where id = (select id from nx)), 'a monthly to-do comes back for next month, for the same person');
select pg_temp.ok(public.todo_done((select id from public.todos where title = 'Call the plumber')) is null, 'a one-time to-do doesn''t come back');
select public.todo_undone((select id from public.todos where title = 'Pay rent' and done_at is not null));
select pg_temp.ok((select count(*) = 1 from public.todos where title = 'Pay rent') and (select done_at is null from public.todos where title = 'Pay rent'),
  'undo: open again, and next month''s copy is gone');
reset role;

select pg_temp.as_user(null);
select pg_temp.ok((select count(*) >= 3 from public.change_log where table_name = 'money_entries'), 'money shows on Changes');
set role anon;
do 'begin perform count(*) from public.money_entries; raise exception ''FAIL: anon reads money''; exception when insufficient_privilege then null; end';
do 'begin perform count(*) from public.todos; raise exception ''FAIL: anon reads to-dos''; exception when insufficient_privilege then null; end';
reset role;
\echo ALL MONEY / FOOD PROGRAM / TO-DO TESTS PASSED
