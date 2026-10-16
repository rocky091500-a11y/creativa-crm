-- Migration 010: billing system balance sheets kept as history. Finance access only.
-- Runs after the other tests (users from db.test.sql: owner = admin, teacher = staff, books = finance edit).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/010_billing_history.sql
select pg_temp.as_user(null);
update public.profiles set finance = 'none' where email = 'teacher@creativaacademy.com';
update public.profiles set finance = 'edit' where email = 'books@creativaacademy.com';
insert into public.billing_history (as_of, period_start, period_end, customer, family_account, balance)
values ('2026-08-12', '2026-08-10', '2026-08-21', 'DOE, JANE', 'DOE, JANE', 560),
       ('2026-08-25', '2026-08-24', '2026-09-04', 'DOE, JANE', 'DOE, JANE', -80);
do 'begin insert into public.billing_history (as_of, customer, balance) values (''2026-08-12'', ''DOE, JANE'', 1);
  raise exception ''FAIL: same family twice on one sheet''; exception when unique_violation then null; end';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- staff, no finance
select pg_temp.ok((select count(*) = 0 from public.billing_history), 'staff without finance see no balances');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- finance editor
select pg_temp.ok((select sum(balance) = 480 from public.billing_history), 'finance sees them (a credit is negative)');
reset role;
select pg_temp.as_user(null);
update public.profiles set finance = 'view' where email = 'books@creativaacademy.com';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- view only
delete from public.billing_history;
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 2 from public.billing_history), 'view-only finance can''t delete them');
update public.profiles set finance = 'edit' where email = 'books@creativaacademy.com';
set role anon;
do 'begin perform count(*) from public.billing_history; raise exception ''FAIL: anon reads balances'';
exception when insufficient_privilege then null; end';
reset role;
delete from public.billing_history;
\echo ALL HISTORY TESTS PASSED

-- ═════════════ 011: graduated, what was paid in Aug–Sep ═════════════
\ir ../supabase/migrations/011_graduated_earlier_payments.sql
select pg_temp.as_user(null);
insert into public.students (name, status, withdrawn_on) values ('Grad Kid', 'graduated', '2026-10-10');
insert into public.student_finance (student_id, funding, tuition_amount, tuition_frequency)
  select id, '{}', 500, 'biweekly' from public.students where name = 'Grad Kid';
do 'begin insert into public.students (name, status) values (''Bad Status'', ''alumni''); raise exception ''FAIL: bad status'';
exception when check_violation then null; end';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select public.create_period_invoices('2026-10-05');
select public.create_period_invoices('2026-10-19');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select string_agg(i.period_start::text, ',' order by i.period_start) from public.invoices i join public.students s on s.id = i.student_id
                    where s.name = 'Grad Kid') = '2026-10-05', 'a graduated child is billed only through their last day');
insert into public.billing_history (as_of, period_start, period_end, customer, family_account, balance, paid, needs_check)
values ('2026-08-12', '2026-08-10', '2026-08-21', 'DOE, JANE', 'DOE, JANE', 560, 560, false);
do 'begin update public.billing_history set paid = -1; raise exception ''FAIL: negative paid''; exception when check_violation then null; end';
select pg_temp.ok((select paid = 560 and not needs_check from public.billing_history), 'paid and needs_check are kept');
delete from public.billing_history;
\echo ALL GRADUATED / EARLIER PAYMENT TESTS PASSED
