-- Migration 040: the accountant's books. Staff who see the money see them; each person's pay only for staff who do payroll.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/040_accountant_books.sql
\ir ../supabase/migrations/040_accountant_books.sql
-- a = the owner (admin: everything); d = sees the money, no payroll; b = a teacher (no money).
insert into auth.users (id, email, raw_user_meta_data) select '00000000-0000-0000-0000-00000000000d', 'books@creativaacademy.com', '{}'
 where not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-00000000000d');
update public.profiles set active = true, role = 'staff', finance = 'view', payroll = false where id = '00000000-0000-0000-0000-00000000000d';
update public.profiles set active = true, role = 'staff', finance = 'none', payroll = false where id = '00000000-0000-0000-0000-00000000000b';
insert into public.books_pl (period_start, period_end, section, grp, line, amount, pay, sort) values
  ('2031-01-01', '2031-01-31', 'income', null, 'Tuition', 1000, false, 0),
  ('2031-01-01', '2031-01-31', 'expense', 'Payroll expenses', 'Teacher One', 300, true, 1),
  ('2031-01-01', '2031-01-31', 'expense', 'Payroll expenses', 'Teacher Two', 200, true, 2),
  ('2031-01-01', '2031-01-31', 'expense', 'Payroll expenses', 'Payroll Taxes', 50, false, 3),
  ('2031-01-01', '2031-01-31', 'expense', null, 'Rent', 400, false, 4);
do 'begin insert into public.books_pl (period_start, period_end, section, line, amount) values (''2031-01-01'', ''2031-01-31'', ''income'', ''Tuition'', 1);
  raise exception ''FAIL: twice''; exception when unique_violation then null; end';
select pg_temp.ok(true, 'one amount per line and period');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.ok((select count(*) = 5 and count(*) filter (where line = 'Teacher One') = 1 from public.books_pl_rows(2031)), 'the owner sees every line, pay by name');
select pg_temp.ok((select year = 2031 and periods = 1 from public.books_pl_years() where year = 2031), 'the years with reports');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok((select count(*) = 4 and sum(amount) = 1950 and count(*) filter (where line like 'Teacher%') = 0
                     and (select amount = 500 from public.books_pl_rows(2031) where line = 'Pay, by person on Payroll')
                   from public.books_pl_rows(2031)), 'money but no payroll: pay as one line, same totals');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok((select count(*) = 0 from public.books_pl_rows(2031)) and (select count(*) = 0 from public.books_pl_years()), 'a teacher sees nothing');
do 'begin perform count(*) from public.books_pl; raise exception ''FAIL: table read''; exception when insufficient_privilege then null; end';
reset role;
set role anon;
do 'begin perform count(*) from public.books_pl_rows(2031); raise exception ''FAIL: anon''; exception when insufficient_privilege then null; end';
reset role;
select pg_temp.ok(true, 'only through the CRM: not the table itself, and not without a login');
-- Balance sheets: for staff who see the money.
insert into public.books_bs (as_of, section, grp, line, amount, sort) values
  ('2031-06-30', 'asset', 'Bank Accounts', 'Checking', 900, 0), ('2031-06-30', 'liability', null, 'Loan', 100, 1),
  ('2031-06-30', 'equity', null, 'Retained Earnings', 800, 2);
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok((select count(*) = 3 from public.books_bs_rows(2031)) and (select balance_sheets = 1 from public.books_pl_years() where year = 2031),
  'balance sheets for staff who see the money');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok((select count(*) = 0 from public.books_bs_rows(2031)), 'not for a teacher');
reset role;
delete from public.books_bs where as_of >= '2031-01-01';
delete from public.books_pl where period_start >= '2031-01-01';
\echo ALL ACCOUNTANT BOOKS TESTS PASSED
