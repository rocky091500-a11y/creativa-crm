insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@creativaacademy.com', '{"full_name":"Emily Owner"}'),
  ('00000000-0000-0000-0000-00000000000b', 'teacher@creativaacademy.com', '{"full_name":"Ms. Laura"}'),
  ('00000000-0000-0000-0000-00000000000c', 'newhire@creativaacademy.com', '{"full_name":"New Hire"}');
update public.profiles set role = 'admin', active = true where email = 'owner@creativaacademy.com';
update public.profiles set active = true where email = 'teacher@creativaacademy.com';

set role anon;
select public.submit_inquiry('schedule-tour', '{"parent-first-name":"Maria","parent-last-name":"Lopez","email":"maria@example.com",
  "phone":"(786) 555-0101","contact-pref":"Text","child-first-name":"Sofia","child-last-name":"Lopez","child-dob":"2024-03-15",
  "program":"Early Twos","start-time":"January 2027","days[]":["Mon","Wed"],"notes":"Loves music"}'::jsonb);
select public.submit_inquiry('waitlist', '{"parent_name":"James Carter","phone":"305-555-0199","email":"jc@example.com",
  "child_name":"Ava Carter","child_dob":"2022-01-10","program":"VPK (4–5 Years)","heard_from":"Instagram"}'::jsonb);
select public.submit_inquiry('contact', '{"first-name":"<img src=x onerror=window.__xss=1>","last-name":"Test","email":"xss@example.com",
  "message":"<script>window.__xss=2</script>"}'::jsonb);
select public.submit_inquiry('bloom-interest', '{"parent-name":"Ana Ruiz","parent-phone":"7865550123","parent-email":"ana@example.com",
  "child-name":"Leo","child-dob":"2023-06-01","referral-source[]":["Pediatrician","Friend"]}'::jsonb);
reset role;

-- Enrollment roster (fake names; the real roster is imported separately and never committed)
insert into public.students (name, dob, classroom_id, status, parent_name, parent_phone, doc_registration, reg_fee)
  select 'Test Kid Alpha', '2023-05-02', id, 'enrolled', 'Alpha Parent', '305 555 0101', '2026-08-01', 'paid' from public.classrooms where name = 'Early 3s';
insert into public.students (name, dob, classroom_id, status, rbt, therapy)
  select 'Test Kid Beta', '2021-09-01', id, 'enrolled', 'yes', 'Speech' from public.classrooms where name = 'VPK';
insert into public.students (name, classroom_id, status, notes)
  select 'Test Kid Gamma', id, 'waitlist', 'Starting January' from public.classrooms where name = '18–23 months';
insert into public.student_finance (student_id, funding, tuition_amount, tuition_frequency, award_id)
  select id, '{fes_ua}', 560, 'monthly', 'TEST-123' from public.students where name = 'Test Kid Alpha';
insert into public.student_finance (student_id, funding, tuition_amount, tuition_frequency)
  select id, '{sr,vpk}', 80, 'biweekly' from public.students where name = 'Test Kid Beta';
update public.settings set receipt_header = '123 Test Street, Miami FL', receipt_signer = 'Emily Owner, Director';
