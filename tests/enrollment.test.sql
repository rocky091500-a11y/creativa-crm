-- Run: tests/run-db-tests.sh (after db.test.sql, which creates the users and inquiries used here)
-- Enrollment roster, finance access, payments/receipts, automatic tour emails.
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'FAIL: %', label; end if;
  raise notice 'ok - %', label;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
end $$;

-- owner = admin (a), teacher = staff without finance (b); add a bookkeeper with view-only finance (d)
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000d', 'books@creativaacademy.com', '{"full_name":"Bookkeeper"}');
update public.profiles set active = true, finance = 'view' where email = 'books@creativaacademy.com';

select pg_temp.ok((select count(*) = 7 from public.classrooms), 'seven classrooms created');

-- ── staff keeps the roster ──
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
insert into public.students (name, dob, classroom_id, parent_name, doc_registration)
  select 'Test Child One', '2023-04-01', id, 'Parent One', '2026-08-01' from public.classrooms where name = 'Early 3s';
insert into public.students (name, classroom_id, status)
  select 'Test Waiter', id, 'waitlist' from public.classrooms where name = 'Early 3s';
update public.students set doc_blue_form = '2026-08-15' where name = 'Test Child One';
select pg_temp.ok((select count(*) = 2 from public.students), 'staff adds and sees students');
select pg_temp.ok((select created_by = '00000000-0000-0000-0000-00000000000b' from public.students where name = 'Test Child One'),
                  'student remembers who added it');
-- staff cannot see or write finance
select pg_temp.ok((select count(*) = 0 from public.payments), 'staff sees no payments');
do $$ begin
  insert into public.student_finance (student_id, tuition_amount) select id, 500 from public.students limit 1;
  raise exception 'FAIL: staff wrote finance';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into public.payments (student_id, covers_month, amount, created_by)
    select id, '2026-10-01', 100, auth.uid() from public.students limit 1;
  raise exception 'FAIL: staff recorded a payment';
exception when insufficient_privilege then null; end $$;
delete from public.students;   -- staff cannot delete: RLS filters to nothing
update public.classrooms set capacity = 5;   -- only admins edit classes: no rows change
update public.settings set school_name = 'Hacked';
reset role;
select pg_temp.ok((select count(*) = 2 from public.students), 'staff delete removed nothing');
select pg_temp.ok((select count(*) = 0 from public.classrooms where capacity = 5), 'staff cannot change classes');
select pg_temp.ok((select school_name = 'Creativa Academy' from public.settings), 'staff cannot change settings');

-- ── admin records finance ──
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into public.student_finance (student_id, funding, tuition_amount, tuition_frequency, award_id)
  select id, '{fes_ua}', 560, 'monthly', 'TEST-AWARD-1' from public.students where name = 'Test Child One';
do $$ begin
  insert into public.student_finance (student_id, funding) select id, '{bitcoin}' from public.students where name = 'Test Waiter';
  raise exception 'FAIL: unknown funding accepted';
exception when check_violation then null; end $$;
insert into public.payments (student_id, covers_month, paid_on, amount, payer, method, created_by)
  select id, '2026-10-01', '2026-10-03', 300, 'parent', 'zelle', auth.uid() from public.students where name = 'Test Child One';
insert into public.payments (student_id, covers_month, paid_on, amount, payer, method, receipt_no, created_by)
  select id, '2026-10-01', '2026-10-20', 260, 'parent', 'cash', 1, auth.uid() from public.students where name = 'Test Child One';
do $$ begin
  insert into public.payments (student_id, covers_month, amount, created_by)
    select id, '2026-10-15', 10, auth.uid() from public.students limit 1;
  raise exception 'FAIL: covers_month must be the 1st';
exception when check_violation then null; end $$;
do $$ begin
  update public.payments set receipt_no = 5 where amount = 300;
  raise exception 'FAIL: receipt number changed';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;
update public.classrooms set capacity = 12, teachers = 'Ms. Test' where name = 'Early 3s';
update public.settings set receipt_header = '123 Test St';
-- an admin cannot change their own finance access, and can give it to others
do $$ begin
  update public.profiles set finance = 'edit' where id = auth.uid(); raise exception 'FAIL: changed own finance';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;
reset role;
select pg_temp.ok((select min(receipt_no) >= 1001 and max(receipt_no) - min(receipt_no) = 1 and bool_and(receipt_no <> 1) from public.payments),
                  'receipt numbers assigned in order by the database, ignoring what the app sends');
select pg_temp.ok((select sum(amount) = 560 from public.payments where covers_month = '2026-10-01'), 'October paid in full');
select pg_temp.ok((select capacity = 12 from public.classrooms where name = 'Early 3s'), 'admin edits classes');

-- ── view-only finance ──
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok((select count(*) = 2 from public.payments), 'bookkeeper (view) sees payments');
select pg_temp.ok((select award_id = 'TEST-AWARD-1' from public.student_finance), 'bookkeeper sees award ID');
update public.payments set amount = 1;
delete from public.payments;
do $$ begin
  insert into public.payments (student_id, covers_month, amount, created_by)
    select id, '2026-10-01', 10, auth.uid() from public.students limit 1;
  raise exception 'FAIL: view-only recorded a payment';
exception when insufficient_privilege then null; end $$;
reset role;
select pg_temp.ok((select count(*) = 2 and sum(amount) = 560 from public.payments), 'view-only finance cannot change payments');

select pg_temp.as_user(null);
update public.profiles set finance = 'edit' where email = 'books@creativaacademy.com';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
insert into public.payments (student_id, covers_month, amount, payer, created_by)
  select id, '2026-11-01', 280, 'fes', auth.uid() from public.students where name = 'Test Child One';
do $$ begin
  insert into public.payments (student_id, covers_month, amount, created_by)
    select id, '2026-11-01', 10, '00000000-0000-0000-0000-00000000000a' from public.students limit 1;
  raise exception 'FAIL: payment recorded as someone else';
exception when insufficient_privilege then null; end $$;
reset role;
select pg_temp.ok((select count(*) = 3 from public.payments), 'finance editor records payments');

-- a student with payments cannot be deleted (history is kept); withdraw instead
do $$ begin
  delete from public.students where name = 'Test Child One'; raise exception 'FAIL: deleted a student with payments';
exception when foreign_key_violation then null; end $$;

-- anon sees nothing
set role anon;
do $$ begin
  perform count(*) from public.students; raise exception 'FAIL: anon reads students';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform * from public.tour_emails_due(); raise exception 'FAIL: anon reads email queue';
exception when insufficient_privilege then null; end $$;
reset role;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  perform * from public.tour_emails_due(); raise exception 'FAIL: staff reads email queue';
exception when insufficient_privilege then null; end $$;
reset role;

-- ── automatic tour emails ──
-- Fixed clock: Friday Oct 9 2026, 10:30am in Miami (14:30 UTC).
insert into public.inquiries (parent_name, email, phone, child_name, stage, tour_at) values
  ('Tomorrow Mom', 'tomorrow@example.com', null, 'Kid A', 'tour_scheduled', '2026-10-10 11:00-04'),
  ('Late Night Tour', 'latenight@example.com', null, 'Kid B', 'tour_scheduled', '2026-10-10 23:30-04'),  -- still tomorrow in Miami, Oct 11 in UTC
  ('Two Days Out', 'later@example.com', null, null, 'tour_scheduled', '2026-10-11 10:00-04'),
  ('No Email', null, '305 555 1111', null, 'tour_scheduled', '2026-10-10 09:00-04'),
  ('Opted Out', 'optout@example.com', null, null, 'tour_scheduled', '2026-10-10 09:00-04'),
  ('Last Week Silent', 'silent@example.com', null, 'Kid C', 'toured', '2026-10-02 10:00-04'),
  ('Last Week Called', 'called@example.com', null, null, 'toured', '2026-10-02 10:00-04'),
  ('Last Week Enrolled', 'enrolled@example.com', null, null, 'enrolled', '2026-10-02 10:00-04'),
  ('Too Long Ago', 'old@example.com', null, null, 'toured', '2026-09-20 10:00-04');
update public.inquiries set auto_emails = false where parent_name = 'Opted Out';
insert into public.activities (inquiry_id, author, kind, body)
  select id, '00000000-0000-0000-0000-00000000000b', 'call', 'Called after the tour' from public.inquiries where parent_name = 'Last Week Called';

select pg_temp.ok((select string_agg(kind || ':' || parent_name, ', ' order by kind, parent_name)
                     from public.tour_emails_due('2026-10-09 14:30+00'))
                  = 'followup:Last Week Silent, reminder:Late Night Tour, reminder:Tomorrow Mom',
                  'due: day-before reminders (Miami dates) and silent 1-week follow-ups only');
select pg_temp.ok((select count(*) = 0 from public.tour_emails_due('2026-10-09 12:30+00')), 'nothing before 9am Miami time');
select pg_temp.ok((select string_agg(parent_name, ',') = 'Late Night Tour,Tomorrow Mom' from (select parent_name from public.tour_emails_due('2026-10-09 13:30+00') order by 1) x),
                  '9:30am: reminders go, follow-ups wait for 10am');

set role service_role;
select public.tour_email_sent(id, 'reminder', email) from public.inquiries where parent_name = 'Tomorrow Mom';
select public.tour_email_sent(id, 'followup', email) from public.inquiries where parent_name = 'Last Week Silent';
reset role;
select pg_temp.ok((select string_agg(parent_name, ',') = 'Late Night Tour' from public.tour_emails_due('2026-10-09 15:30+00')),
                  'sent emails are not sent again');
select pg_temp.ok((select body = 'Automatic tour reminder emailed to tomorrow@example.com' and author is null
                   from public.activities a join public.inquiries i on i.id = a.inquiry_id
                   where i.parent_name = 'Tomorrow Mom' and a.kind = 'email'), 'sent reminder logged on the timeline');
update public.inquiries set tour_at = '2026-10-10 15:00-04' where parent_name = 'Tomorrow Mom';
select pg_temp.ok((select tour_reminder_sent_at is null from public.inquiries where parent_name = 'Tomorrow Mom'),
                  'rescheduling a tour re-arms its reminder');
update public.settings set emails_enabled = false;
select pg_temp.ok((select count(*) = 0 from public.tour_emails_due('2026-10-09 15:30+00')), 'emails switched off in settings: nothing due');
update public.settings set emails_enabled = true;

\echo ALL ENROLLMENT TESTS PASSED
