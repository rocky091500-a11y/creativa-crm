-- Migration 031: fall re-registration (no answer yet / said yes / seat reserved). Runs after registration.test.sql.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
select pg_temp.as_user(null);

-- When the seat column is first added, a registration already paid in full gets its seat.
alter table public.registrations drop column if exists reserved_on;
insert into public.students (name, status) values ('Paid Early', 'enrolled'), ('Rory Return', 'enrolled'), ('Una Unsure', 'enrolled');
insert into public.invoices (student_id, kind, description, invoice_date, due_date, amount)
  select id, 'fee', 'Registration 2027–28', '2026-11-05', '2027-08-01', 300 from public.students where name = 'Paid Early';
insert into public.registrations (school_year, student_id, status, invoice_id)
  select '2027-28', s.id, 'returning', i.id from public.students s join public.invoices i on i.student_id = s.id where s.name = 'Paid Early';
insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, method, payer)
  select student_id, id, '2026-11-05', '2027-08-01', 300, 'cash', 'parent' from public.invoices where student_id = (select id from public.students where name = 'Paid Early');
\ir ../supabase/migrations/031_reregistration.sql
\ir ../supabase/migrations/031_reregistration.sql
select pg_temp.ok((select reserved_on = '2026-11-05' from public.registrations where student_id = (select id from public.students where name = 'Paid Early')),
  'already paid in full: seat reserved (the day it was paid)');
select pg_temp.ok((select count(*) = 1 from public.registrations where reserved_on is not null), '... and no one else');

create temp table rr as select (select id from public.classrooms where name = 'VPK') as vpk,
  (select id from public.students where name = 'Rory Return') as rory, (select id from public.students where name = 'Una Unsure') as una;
grant select on rr to authenticated;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- records payments
select pg_temp.ok((select (public.registration_save(una, '2027-28', vpk, null)).status = 'no_answer' from rr), 'a new row starts as No answer yet');
select pg_temp.ok((select (public.registration_pay(rory, '2027-28', vpk, 100, '2026-11-10', 'cash', 'parent', null, null)).amount = 100 from rr), 'a part payment');
select pg_temp.ok((select status = 'returning' and reserved_on is null from public.registrations where student_id = (select rory from rr)), 'paying says yes, but a part payment doesn''t reserve the seat');
select public.registration_pay(rory, '2027-28', vpk, 200, '2026-11-17', 'cash', 'parent', null, null) from rr;
select pg_temp.ok((select reserved_on = '2026-11-17' from public.registrations where student_id = (select rory from rr)), 'paid in full: seat reserved');
select pg_temp.ok((select (public.registration_save(rory, '2027-28', vpk, 'not_returning')).reserved_on is null from rr), 'saying No gives the seat up');
select pg_temp.ok((select (public.registration_reserve(una, '2027-28', vpk, true)).status = 'returning' from rr), 'the office reserves a seat: they''re coming back');
select pg_temp.ok((select reserved_on = current_date from public.registrations where student_id = (select una from rr)), '... from today');
select pg_temp.ok((select r.reserved_on is null and r.status = 'returning' from rr, public.registration_reserve(una, '2027-28', vpk, false) r), 'and un-reserves it (still coming back)');
select pg_temp.ok((select (public.registration_reserve(id, '2027-28', (select vpk from rr), true)).reserved_on is not null from public.students where name = 'Nina Newstart'),
  'reserving works for a child with a row already');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- finance view only
do 'begin perform public.registration_reserve((select una from rr), ''2027-28'', null, true); raise exception ''FAIL: view-only reserved'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
reset role;
\echo ALL RE-REGISTRATION TESTS PASSED
