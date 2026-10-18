-- Migration 020: class rates, Kindergarten's school-year rate, and monthly bills. Runs after projection.test.sql.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/020_class_rates_and_bills.sql
select pg_temp.as_user(null);
select pg_temp.ok((select rate_full = 280 and rate_after_care = 300 and rate_per = 'week' and registration_fee = 300 from public.classrooms where name = 'Early 2s'), 'toddlers: $280 / $300 a week');
select pg_temp.ok((select rate_full = 270 and rate_after_care = 280 from public.classrooms where name = 'Late 3s'), '3s: $270 / $280');
select pg_temp.ok((select rate_full = 180 and rate_after_care = 200 from public.classrooms where name = 'VPK'), 'VPK: $180 / $200');
select pg_temp.ok((select rate_full = 9700 and rate_after_care = 10700 and rate_per = 'school_year' and registration_fee = 350 and book_fee = 350
  from public.classrooms where name = 'Kindergarten'), 'Kindergarten: $9,700 / $10,700 a school year');
update public.classrooms set rate_full = 285 where name = 'Early 2s';
\ir ../supabase/migrations/020_class_rates_and_bills.sql
select pg_temp.ok((select rate_full = 285 from public.classrooms where name = 'Early 2s'), 'running it again keeps a changed rate');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- records payments
update public.student_finance set tuition_amount = 9700, tuition_frequency = 'school_year'
 where student_id = (select id from public.students where name = 'Nina Newstart');
select pg_temp.ok((select count(*) = 1 from public.student_finance where tuition_frequency = 'school_year'), 'a school-year rate');
update public.student_finance set rate_note = '10% sibling discount' where student_id = (select id from public.students where name = 'Nina Newstart');
insert into public.bills (name, category, amount, days, parts, starts_on) values
  ('Test rent', 'Rent', 1000, '{15,30}', '[{"label":"Base rent","amount":1500},{"label":"CAM","amount":500}]', '2026-10-01');
do 'begin insert into public.bills (name, category, amount, days) values (''Bad'', ''Rent'', 1, ''{32}''); raise exception ''FAIL: day 32'';
  exception when check_violation then null; end';
do 'begin insert into public.bills (name, category, amount, days, starts_on, ends_on) values (''Bad'', ''Rent'', 1, ''{1}'', ''2026-10-01'', ''2026-09-01'');
  raise exception ''FAIL: ends before it starts''; exception when check_violation then null; end';
insert into public.money_entries (on_date, kind, category, amount, bill_id, bill_due)
  select '2026-10-15', 'out', 'Rent', 1000, id, '2026-10-15' from public.bills where name = 'Test rent';
do 'begin insert into public.money_entries (on_date, kind, category, amount, bill_id, bill_due)
  select ''2026-10-16'', ''out'', ''Rent'', 1000, id, ''2026-10-15'' from public.bills where name = ''Test rent'';
  raise exception ''FAIL: paid twice''; exception when unique_violation then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- finance view only
select pg_temp.ok((select count(*) = 1 from public.bills), 'finance view sees the bills');
do 'begin insert into public.bills (name, category, amount, days) values (''Nope'', ''Rent'', 1, ''{1}''); raise exception ''FAIL: view-only added a bill'';
  exception when insufficient_privilege then null; end';
reset role;
select pg_temp.as_user(null);
delete from public.bills where name = 'Test rent';
select pg_temp.ok((select count(*) = 1 from public.money_entries where category = 'Rent' and bill_id is null and bill_due = '2026-10-15'), 'deleting a bill keeps its payments');
select pg_temp.ok((select count(*) >= 1 from public.change_log where area = 'finance' and table_name = 'bills'), 'bills show on Changes');
\echo ALL RATES / BILLS TESTS PASSED
