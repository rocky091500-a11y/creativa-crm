-- Migration 039: online registration from the website, reviewed and added to Enrollment by the office.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/039_online_registration.sql
\ir ../supabase/migrations/039_online_registration.sql
-- a = the owner (office); b = a teacher (no money, no payroll): not the office.
update public.profiles set active = true, role = 'staff', finance = 'none', payroll = false where id = '00000000-0000-0000-0000-00000000000b';

-- ── what the website sends (as anyone) ──
set role anon;
select public.submit_registration('{
  "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX", "bot-field": "",
  "child": {"first": " Reg ", "last": "Kid", "dob": "2023-04-05", "program": "late 3''s", "start_on": "2027-01-04", "schedule": "until_545"},
  "parents": [{"relationship": "Mother", "first": "Rosa", "last": "Kid", "cell": "(305) 555-0141", "email": "ROSA@EXAMPLE.COM",
               "address": "1 Palm St, Miami, FL 33184", "employer": "Hospital", "work_phone": "305 555 0142", "evil": "x"},
              {"relationship": "Father", "first": "Luis", "last": "Kid", "cell": "305 555 0143"},
              {"relationship": "Uncle", "first": "Third", "last": "Parent"}],
  "emergency": [{"relationship": "Aunt", "first": "Ana", "last": "Tia", "cell": "305 555 0144"}, {"first": "", "last": ""}],
  "pickups": [{"relationship": "Grandmother", "first": "Abuela", "last": "Kid", "cell": "305 555 0145"}],
  "allergies": "Peanuts", "medications": [{"name": "EpiPen Jr", "details": "Peanuts: one shot", "expires_on": "2027-02-30"}],
  "pediatrician": {"name": "Dr. Smith", "phone": "305 555 0146"},
  "rbt": "in_process", "rbt_note": "ABC Therapy", "therapy": ["speech", "ot", "dance"], "funding": ["sr", "vpk", "money"],
  "award_id": "A123", "photo_ok": "no", "notes": "Loves music", "signed_name": "Rosa Kid", "admin": true
}'::jsonb);
do 'begin perform public.submit_registration(''{"cf-turnstile-response":"XXXX.DUMMY.TOKEN.XXXX","child":{"first":"No"},
  "parents":[{"first":"P","cell":"1"}],"signed_name":"P"}''::jsonb); raise exception ''FAIL: no last name''; exception when raise_exception then
  if sqlerrm not like ''%first and last name%'' then raise; end if; end';
do 'begin perform public.submit_registration(''{"cf-turnstile-response":"XXXX.DUMMY.TOKEN.XXXX","child":{"first":"A","last":"B","dob":"2023-01-01"},
  "parents":[{"first":"P","cell":"1"}]}''::jsonb); raise exception ''FAIL: not signed''; exception when raise_exception then
  if sqlerrm not like ''%type your name%'' then raise; end if; end';
do 'begin perform public.submit_registration(''{"child":{"first":"A","last":"B","dob":"2023-01-01"},"parents":[{"first":"P","cell":"1"}],
  "signed_name":"P"}''::jsonb); raise exception ''FAIL: no robot check''; exception when raise_exception then
  if sqlerrm not like ''%not a robot%'' then raise; end if; end';
select public.submit_registration('{"bot-field": "spam", "child": {"first": "Bot", "last": "Kid", "dob": "2023-01-01"},
  "parents": [{"first": "B", "cell": "1"}], "signed_name": "B"}'::jsonb);
do 'begin perform count(*) from public.registration_forms; raise exception ''FAIL: anon reads''; exception when insufficient_privilege then null; end';
reset role;
select pg_temp.ok(true, 'the website: missing name, signature or robot check refused; anyone else can''t read the forms');

select pg_temp.ok((select count(*) = 1 from public.registration_forms), 'one form saved (not the bot''s)');
select pg_temp.ok((select child_name = 'Reg Kid' and child_dob = '2023-04-05' and start_on = '2027-01-04' and parent_name = 'Rosa Kid'
                     and status = 'new' from public.registration_forms), 'the child, start and parent on the list');
select pg_temp.ok((select data #>> '{child,program}' = 'Late 3s' and data #>> '{parents,0,email}' = 'rosa@example.com'
                     and data #> '{parents,0}' ? 'evil' = false and jsonb_array_length(data -> 'parents') = 2
                     and jsonb_array_length(data -> 'emergency') = 1 and data -> 'therapy' = '["ot", "speech"]'::jsonb
                     and data -> 'funding' = '["sr", "vpk"]'::jsonb and data #>> '{medications,0,expires_on}' is null
                     and not data ? 'admin' and (data ->> 'photo_ok')::boolean = false
                   from public.registration_forms), 'cleaned up: only what the CRM uses, at most 2 parents, a bad date dropped');

-- ── who can see and add ──
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok((select count(*) = 0 from public.registration_forms), 'a teacher doesn''t see them');
do 'begin perform public.registration_add((select id from public.registration_forms limit 1), null, ''waitlist'', null, null);
  raise exception ''FAIL: teacher adds''; exception when raise_exception then if sqlerrm not like ''%Only the office%'' then raise; end if; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.ok((select count(*) = 1 from public.registration_forms), 'the office does');
select public.registration_add((select id from public.registration_forms where child_name = 'Reg Kid'), null, 'enrolled',
  (select id from public.classrooms where name = 'Late 3s'), null);
reset role;
select pg_temp.ok((select s.status = 'enrolled' and s.dob = '2023-04-05' and s.start_date = '2027-01-04' and c.name = 'Late 3s'
                     and s.parent_name = 'Rosa Kid' and s.parent_phone = '(305) 555-0141' and s.parent_email = 'rosa@example.com'
                     and s.allergies = 'Peanuts' and s.rbt = 'in_process' and s.therapy = 'Speech, OT' and s.pediatrician = 'Dr. Smith · 305 555 0146'
                     and s.photo_ok = false and s.notes like 'Online registration %Schedule: until 5:45 (after care)%RBT: ABC Therapy%From the family: Loves music'
                   from public.students s join public.classrooms c on c.id = s.classroom_id where s.name = 'Reg Kid'), 'a new child, with everything');
select pg_temp.ok((select count(*) = 4 from public.student_contacts sc join public.students s on s.id = sc.student_id where s.name = 'Reg Kid')
  and (select role = 'primary' and address = '1 Palm St, Miami, FL 33184' and employer = 'Hospital' and work_phone = '305 555 0142'
         from public.student_contacts where first_name = 'Rosa' and student_id = (select id from public.students where name = 'Reg Kid'))
  and (select role = 'secondary' from public.student_contacts where first_name = 'Luis' and student_id = (select id from public.students where name = 'Reg Kid'))
  and (select role = 'emergency' and relationship = 'Aunt' from public.student_contacts where first_name = 'Ana' and student_id = (select id from public.students where name = 'Reg Kid'))
  and (select role = 'pickup' from public.student_contacts where first_name = 'Abuela' and student_id = (select id from public.students where name = 'Reg Kid')), 'both parents, an emergency contact and a pick-up');
select pg_temp.ok((select count(*) = 1 from public.student_medications m join public.students s on s.id = m.student_id where s.name = 'Reg Kid' and m.name = 'EpiPen Jr'),
  'the medicine at school');
select pg_temp.ok((select f.funding @> array['sr', 'vpk'] and f.award_id = 'A123' from public.student_finance f join public.students s on s.id = f.student_id
                   where s.name = 'Reg Kid'), 'the programs and the award ID');
select pg_temp.ok((select status = 'added' and student_id = (select id from public.students where name = 'Reg Kid')
                     and reviewed_by = '00000000-0000-0000-0000-00000000000a' from public.registration_forms where child_name = 'Reg Kid'), 'marked added, to that child');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do 'begin perform public.registration_add((select id from public.registration_forms where child_name = ''Reg Kid''), null, null, null, null);
  raise exception ''FAIL: twice''; exception when raise_exception then if sqlerrm not like ''%already added%'' then raise; end if; end';
reset role;
select pg_temp.ok(true, 'not added twice');

-- ── the same child again (a returning family): fills in what's missing, keeps who's there ──
set role anon;
select public.submit_registration('{"cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX",
  "child": {"first": "Reg", "last": "Kid", "dob": "2023-04-05"},
  "parents": [{"first": "Rosa", "last": "Kid", "cell": "305 555 0999", "address": "2 New Ave"}],
  "pickups": [{"first": "Tio", "last": "Kid", "cell": "305 555 0147"}],
  "allergies": "Eggs", "medications": [{"name": "epipen jr"}], "signed_name": "Rosa Kid"}'::jsonb);
reset role;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select public.registration_add((select id from public.registration_forms where status = 'new'), (select id from public.students where name = 'Reg Kid'),
  null, null, null);
update public.registration_forms set status = 'dismissed' where false;   -- the office may dismiss (policy allows the update)
reset role;
select pg_temp.ok((select count(*) = 5 from public.student_contacts sc join public.students s on s.id = sc.student_id where s.name = 'Reg Kid')
  and (select cell_phone = '(305) 555-0141' and address = '2 New Ave' from public.student_contacts where first_name = 'Rosa' and student_id = (select id from public.students where name = 'Reg Kid')),
  'Rosa kept (her phone stays, the new address is saved), Tio added');
select pg_temp.ok((select allergies = 'Peanuts; Eggs' and status = 'enrolled' from public.students where name = 'Reg Kid'), 'allergies added to, status kept');
select pg_temp.ok((select count(*) = 1 from public.student_medications m join public.students s on s.id = m.student_id where s.name = 'Reg Kid'),
  'the same medicine isn''t added twice');

-- clean up
delete from public.registration_forms;
delete from public.students where name = 'Reg Kid';
\echo ALL ONLINE REGISTRATION TESTS PASSED
