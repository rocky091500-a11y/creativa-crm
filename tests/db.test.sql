-- Run: tests/run-db-tests.sh   (needs a local Postgres 15+)
-- Every check raises on failure; the script ends by printing ALL TESTS PASSED.
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

-- users: admin (activated by bootstrap SQL), staff (activated by admin), pending (never activated)
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@creativaacademy.com', '{"full_name":"Owner"}'),
  ('00000000-0000-0000-0000-00000000000b', 'teacher@creativaacademy.com', '{}'),
  ('00000000-0000-0000-0000-00000000000c', 'stranger@example.com', '{}');

select pg_temp.ok((select count(*) = 3 from public.profiles where not active), 'new logins start inactive');
select pg_temp.ok((select full_name = 'teacher' from public.profiles where email = 'teacher@creativaacademy.com'), 'full_name falls back to email prefix');

-- README bootstrap step, run as the SQL editor (no auth.uid())
update public.profiles set role = 'admin', active = true where email = 'owner@creativaacademy.com';

-- ── website intake as anon ──
set role anon;
select pg_temp.as_user(null);

select public.submit_inquiry('schedule-tour', '{
  "form-name":"schedule-tour","bot-field":"","parent-first-name":"Maria","parent-last-name":"Lopez",
  "email":"Maria@Example.com","phone":"(786) 555-0101","contact-pref":"Text",
  "child-first-name":"Sofia","child-last-name":"Lopez","child-dob":"2024-03-15",
  "program":"Early 2''s","start-time":"January 2027","days[]":["Mon","Wed"],"notes":"Loves music"}'::jsonb);

select public.submit_inquiry('waitlist', '{
  "parent_name":"James Carter","phone":"305-555-0199","email":"jc@example.com",
  "child_name":"Ava Carter","child_dob":"not-a-date","program":"VPK (4–5 Years)","heard_from":"Instagram"}'::jsonb);

select public.submit_inquiry('bloom-interest', '{
  "parent-name":"Ana Ruiz","parent-phone":"7865550123","parent-email":"ana@example.com",
  "child-name":"Leo","referral-source[]":["Pediatrician","Friend"]}'::jsonb);

-- honeypot filled -> silently dropped
select public.submit_inquiry('contact', '{"first-name":"Bot","last-name":"Bot","email":"bot@spam.com","message":"buy","bot-field":"x"}'::jsonb);
-- resubmit of the same form within 2 minutes -> updates the first row, keeps fields the resubmit left blank
select public.submit_inquiry('schedule-tour', '{"parent-first-name":"Maria","parent-last-name":"Lopez",
  "email":"maria@example.com","child-first-name":"Sofia","child-last-name":"Lopez","child-dob":"2024-03-15",
  "program":"Early Twos","start-time":"January 2027","days[]":["Mon","Wed"],"notes":"Loves music"}'::jsonb);

do $$ begin
  begin perform public.submit_inquiry('pno-booking', '{"email":"a@b.co"}'::jsonb); raise exception 'FAIL: unknown form accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.submit_inquiry('contact', '{"first-name":"No contact"}'::jsonb); raise exception 'FAIL: no email/phone accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform public.submit_inquiry('contact', jsonb_build_object('email','a@b.co','message', repeat('x', 20000))); raise exception 'FAIL: oversized accepted';
  exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end;
  begin perform count(*) from public.inquiries; raise exception 'FAIL: anon can read inquiries';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.profiles; raise exception 'FAIL: anon can read profiles';
  exception when insufficient_privilege then null; end;
  begin insert into public.inquiries (parent_name) values ('x'); raise exception 'FAIL: anon can insert directly';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select pg_temp.ok((select count(*) = 3 from public.inquiries), 'three real submissions stored; spam, resubmit and invalid not added');
select pg_temp.ok((select parent_name = 'Maria Lopez' and child_name = 'Sofia Lopez' and child_dob = '2024-03-15'
                     and email = 'maria@example.com' and phone_digits = '7865550101' and contact_pref = 'Text'
                     and program = 'Early 2s' and desired_start = 'January 2027' and message = 'Loves music' and stage = 'new'
                     and raw->'days[]' = '["Mon","Wed"]' and not raw ? 'bot-field'
                   from public.inquiries where source = 'schedule-tour'), 'tour form fields mapped');
select pg_temp.ok((select child_dob is null and heard_from = 'Instagram' and program = 'VPK'
                   from public.inquiries where email = 'jc@example.com'), 'bad date ignored, waitlist mapped');
select pg_temp.ok((select program = 'Bloom' and heard_from = 'Pediatrician, Friend' and email = 'ana@example.com'
                   from public.inquiries where source = 'bloom-interest'), 'bloom: arrays joined, program set');
select pg_temp.ok((select count(*) = 3 from public.activities where kind = 'system'), 'intake logged on each inquiry');
select pg_temp.ok((select phone = '(786) 555-0101' and contact_pref = 'Text' and raw ? 'phone' is false
                   from public.inquiries where source = 'schedule-tour'), 'resubmit kept earlier phone, raw is the latest submission');

-- ── throttle: 4th submission from the same email in 10 minutes dropped ──
set role anon;
select public.submit_inquiry('contact', '{"first-name":"Ana","email":"ana@example.com","message":"1"}'::jsonb);
select public.submit_inquiry('waitlist', '{"parent_name":"Ana","email":"ana@example.com"}'::jsonb);
select public.submit_inquiry('family-support', '{"name":"Ana","email":"ana@example.com"}'::jsonb);
reset role;
select pg_temp.ok((select count(*) = 3 from public.inquiries where email = 'ana@example.com'), 'per-contact throttle');

-- ── pending user sees nothing but their own profile ──
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.ok((select count(*) = 0 from public.inquiries), 'pending user: no inquiries');
select pg_temp.ok((select count(*) = 1 from public.profiles), 'pending user: only own profile');
update public.profiles set active = true, role = 'admin' where id = '00000000-0000-0000-0000-00000000000c';
reset role;
select pg_temp.ok((select not active from public.profiles where email = 'stranger@example.com'), 'pending user cannot activate self');

-- ── admin activates staff ──
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update public.profiles set active = true where email = 'teacher@creativaacademy.com';
do $$ begin
  update public.profiles set active = false where id = auth.uid(); raise exception 'FAIL: admin deactivated self';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;
reset role;
select pg_temp.ok((select active and role = 'staff' from public.profiles where email = 'teacher@creativaacademy.com'), 'admin activated staff');

-- ── staff works the pipeline ──
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok((select count(*) = 5 from public.inquiries), 'staff sees all inquiries');
update public.inquiries set stage = 'tour_scheduled', tour_at = '2026-10-15 10:00-04',
       assigned_to = '00000000-0000-0000-0000-00000000000b' where source = 'schedule-tour';
update public.inquiries set stage = 'lost', lost_reason = 'Moved away' where email = 'jc@example.com';
update public.inquiries set next_follow_up = '2026-10-10' where source = 'bloom-interest';  -- no stage change, no log
insert into public.activities (inquiry_id, kind, body)
  select id, 'call', 'Left voicemail' from public.inquiries where source = 'schedule-tour';
insert into public.inquiries (parent_name, phone, created_by) values ('Walk-in Mom', '305 555 0000', auth.uid());
do $$ begin
  insert into public.activities (inquiry_id, kind, body)
    select id, 'stage', 'fake' from public.inquiries limit 1;
  raise exception 'FAIL: staff forged a stage entry';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;
do $$ begin
  insert into public.activities (inquiry_id, kind, body, author)
    select id, 'note', 'spoof', '00000000-0000-0000-0000-00000000000a' from public.inquiries limit 1;
  raise exception 'FAIL: staff wrote a note as someone else';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;
delete from public.inquiries;  -- staff may not delete: RLS filters to zero rows
update public.profiles set role = 'admin' where email = 'stranger@example.com';
reset role;

select pg_temp.ok((select count(*) = 6 from public.inquiries), 'staff delete removed nothing');
select pg_temp.ok((select role = 'staff' from public.profiles where email = 'stranger@example.com'), 'staff cannot change roles');
select pg_temp.ok((select body = 'New → Tour scheduled' and author = '00000000-0000-0000-0000-00000000000b'
                   from public.activities a join public.inquiries i on i.id = a.inquiry_id
                   where i.source = 'schedule-tour' and a.kind = 'stage'), 'stage change logged with author');
select pg_temp.ok((select body = 'New → Lost (Moved away)' from public.activities a join public.inquiries i on i.id = a.inquiry_id
                   where i.email = 'jc@example.com' and a.kind = 'stage'), 'lost reason in log');
select pg_temp.ok((select count(*) = 0 from public.activities a join public.inquiries i on i.id = a.inquiry_id
                   where i.source = 'bloom-interest' and a.kind = 'stage'), 'non-stage edits not logged');
select pg_temp.ok((select body = 'Added by staff' from public.activities a join public.inquiries i on i.id = a.inquiry_id
                   where i.parent_name = 'Walk-in Mom'), 'manual inquiry logged');
select pg_temp.ok((select updated_at > created_at from public.inquiries where source = 'schedule-tour'), 'updated_at touched');

-- ── admin can delete ──
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
delete from public.inquiries where parent_name = 'Walk-in Mom';
reset role;
select pg_temp.ok((select count(*) = 5 from public.inquiries), 'admin delete works');
select pg_temp.ok((select count(*) = 0 from public.activities a left join public.inquiries i on i.id = a.inquiry_id where i.id is null), 'activities cascade');

select pg_temp.ok(public._program_canon('15 – 17 Months') = '15–17 months'
               and public._program_canon('Late Threes') = 'Late 3s' and public._program_canon('Late 3''s') = 'Late 3s'
               and public._program_canon('VPK (Pre-K)') = 'VPK' and public._program_canon('Bloom by Creativa') = 'Bloom'
               and public._program_canon('Not sure — need guidance') = 'Not sure', 'program labels canonical');

\echo ALL TESTS PASSED
