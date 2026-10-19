-- Migration 023: registration for next school year. Runs after school_calendar.test.sql.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/023_registration.sql
\ir ../supabase/migrations/023_registration.sql
select pg_temp.as_user(null);
select pg_temp.ok((select reg_year = '2027-28' and reg_opens = '2026-11-09' from public.settings where id = 1), 'registration for 2027-28, from Nov 9');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- records payments
insert into public.registrations (school_year, student_id, status)
  select '2027-28', id, 'returning' from public.students where name = 'Nina Newstart';
do 'begin insert into public.registrations (school_year, student_id) select ''2027-28'', id from public.students where name = ''Nina Newstart'';
  raise exception ''FAIL: two for one year''; exception when unique_violation then null; end';
do 'begin update public.registrations set status = ''maybe''; raise exception ''FAIL: status''; exception when check_violation then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- finance view only
select pg_temp.ok((select count(*) = 1 from public.registrations), 'finance view sees registrations');
do 'begin update public.registrations set status = ''not_returning''; if found then raise exception ''FAIL: view-only changed one''; end if; end';
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select status = 'returning' from public.registrations), 'unchanged');

-- Paying registration: one bill per child per year, at the class's fee, paid in parts; dated to that school year.
create temp table rc as select (select id from public.classrooms where name = 'Late 3s') as late3, (select id from public.classrooms where name = 'VPK') as vpk,
  (select id from public.students where name = 'Willa Weekstart') as kid;
grant select on rc to authenticated;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok((select (public.registration_pay(kid, '2027-28', late3, 100, '2026-11-10', 'zelle', 'parent', null, null)).covers_month = '2027-08-01' from rc), 'a part payment, for the 2027-28 school year');
select pg_temp.ok((select (public.registration_pay(kid, '2027-28', late3, 200, '2026-11-20', 'cash', 'parent', null, null)).amount = 200 from rc), 'the rest');
select pg_temp.ok((select count(*) = 1 and sum(amount) = 300 and min(due_date) = '2027-08-01' from public.invoices where description = 'Registration 2027–28'
  and student_id = (select kid from rc)), 'one bill, at the class fee, due when the year starts');
select pg_temp.ok((select sum(p.amount) = 300 from public.payments p join public.registrations r on r.invoice_id = p.invoice_id where r.student_id = (select kid from rc)), 'both payments on it');
select pg_temp.ok((select (public.registration_save(kid, '2027-28', null, 'not_returning')).invoice_id is not null from rc), 'paid: the bill stays when they leave');
-- Not returning before paying: the bill (if any) goes away; a class change moves the fee.
select pg_temp.ok((select (public.registration_save(id, '2027-28', (select vpk from rc), 'returning')).status = 'returning' from public.students where name = 'Stan Fullperiod'), 'saved');
reset role;
select pg_temp.as_user(null);
insert into public.invoices (student_id, kind, description, invoice_date, due_date, amount)
  select id, 'fee', 'Registration 2027–28', current_date, '2027-08-01', 300 from public.students where name = 'Stan Fullperiod';
update public.registrations set invoice_id = (select id from public.invoices where description = 'Registration 2027–28' and student_id = registrations.student_id)
 where student_id = (select id from public.students where name = 'Stan Fullperiod');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok((select (public.registration_save(id, '2027-28', (select vpk from rc), 'returning')).invoice_id is not null from public.students where name = 'Stan Fullperiod'), 'class change keeps the bill');
select pg_temp.ok((select amount = (select registration_fee from public.classrooms where name = 'VPK') from public.invoices where description = 'Registration 2027–28'
  and student_id = (select id from public.students where name = 'Stan Fullperiod')), 'and its amount follows the class');
select pg_temp.ok((select (public.registration_save(id, '2027-28', (select vpk from rc), 'not_returning')).invoice_id is null from public.students where name = 'Stan Fullperiod'), 'not returning: unpaid bill removed');
select pg_temp.ok((select count(*) = 0 from public.invoices where description = 'Registration 2027–28' and student_id = (select id from public.students where name = 'Stan Fullperiod')), 'gone');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- finance view only
do 'begin perform public.registration_pay((select kid from rc), ''2027-28'', null, 1, current_date, ''cash'', ''parent'', null, null); raise exception ''FAIL: view-only paid'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
reset role;
\echo ALL REGISTRATION TESTS PASSED
