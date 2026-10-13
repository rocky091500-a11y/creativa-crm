-- Run: tests/run-db-tests.sh (after the other test files)
-- Automatic tour texts (005_text_reminders.sql): what is due, claiming, results, opt-outs, replies, access.
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
-- only this file's families (earlier test files leave other inquiries behind)
create or replace function pg_temp.due(p_now timestamptz) returns text language sql as $$
  select coalesce(string_agg(kind || ':' || parent_name || ':' || phone, ', ' order by kind, parent_name), '')
    from public.tour_texts_due(p_now) where parent_name like 'Tx %'
$$;
create or replace function pg_temp.inq(p_name text) returns uuid language sql as $$
  select id from public.inquiries where parent_name = p_name
$$;

select pg_temp.ok(public._e164('3055550101') = '+13055550101', 'e164: 10 digits');
select pg_temp.ok(public._e164('13055550101') = '+13055550101', 'e164: leading 1');
select pg_temp.ok(public._e164('0555550101') is null and public._e164('5550101') is null and public._e164('443055550101') is null,
                  'e164: not a US number → not texted');

-- Fixed clock: Friday Oct 9 2026, 10:30am in Miami (14:30 UTC).
insert into public.inquiries (parent_name, email, phone, child_name, stage, tour_at) values
  ('Tx Tomorrow', 'tx-tomorrow@example.com', '(305) 555-0101', 'Kid A', 'tour_scheduled', '2026-10-10 11:00-04'),
  ('Tx No Email', null, '1-305-555-0102', null, 'tour_scheduled', '2026-10-10 09:00-04'),
  ('Tx No Phone', 'tx-nophone@example.com', null, null, 'tour_scheduled', '2026-10-10 09:00-04'),
  ('Tx Bad Phone', null, '555-0103', null, 'tour_scheduled', '2026-10-10 09:00-04'),
  ('Tx Auto Off', null, '305 555 0104', null, 'tour_scheduled', '2026-10-10 09:00-04'),
  ('Tx Stopped', null, '305 555 0105', null, 'tour_scheduled', '2026-10-10 09:00-04'),
  ('Tx Two Days', null, '305 555 0106', null, 'tour_scheduled', '2026-10-11 10:00-04'),
  ('Tx Week Email', 'tx-week@example.com', '305 555 0107', null, 'toured', '2026-10-02 10:00-04'),
  ('Tx Week Phone Only', null, '305 555 0108', 'Kid C', 'toured', '2026-10-02 10:00-04'),
  ('Tx Week Called', null, '305 555 0109', null, 'toured', '2026-10-02 10:00-04');
update public.inquiries set auto_emails = false where parent_name = 'Tx Auto Off';
insert into public.text_opt_outs (phone) values ('+13055550105');
insert into public.activities (inquiry_id, author, kind, body)
  values (pg_temp.inq('Tx Week Called'), '00000000-0000-0000-0000-00000000000b', 'call', 'Called after the tour');

select pg_temp.ok((select texts_enabled = false from public.settings), 'texts start switched off');
select pg_temp.ok(pg_temp.due('2026-10-09 14:30+00') = '', 'switched off: nothing due');
update public.settings set texts_enabled = true;

select pg_temp.ok(pg_temp.due('2026-10-09 14:30+00')
  = 'followup:Tx Week Phone Only:+13055550108, reminder:Tx No Email:+13055550102, reminder:Tx Tomorrow:+13055550101',
  'due: reminders to every US number (email or not); follow-up text only where no email goes; opt-outs, auto-off, called, bad numbers skipped');
select pg_temp.ok(pg_temp.due('2026-10-09 12:30+00') = '', 'nothing before 9am Miami time');
select pg_temp.ok(pg_temp.due('2026-10-09 13:30+00') = 'reminder:Tx No Email:+13055550102, reminder:Tx Tomorrow:+13055550101',
                  '9:30am: reminders go, follow-ups wait for 10am');
select pg_temp.ok(pg_temp.due('2026-10-09 23:30+00') <> '', '7:30pm: still texting');
select pg_temp.ok(pg_temp.due('2026-10-10 00:30+00') = '', '8:30pm: no texts in the evening');
update public.settings set emails_enabled = false;
select pg_temp.ok(pg_temp.due('2026-10-09 14:30+00') like 'followup:Tx Week Email:+13055550107, followup:Tx Week Phone Only%',
                  'with emails switched off, the follow-up goes by text to families with email too');
update public.settings set emails_enabled = true;

-- ── access ──
set role anon;
do $$ begin
  perform * from public.tour_texts_due(); raise exception 'FAIL: anon reads the text queue';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform * from public.text_inbound('+13055550101', 'STOP'); raise exception 'FAIL: anon fakes a reply';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform count(*) from public.text_opt_outs; raise exception 'FAIL: anon reads opt-outs';
exception when insufficient_privilege then null; end $$;
reset role;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  perform * from public.tour_texts_due(); raise exception 'FAIL: staff reads the text queue';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.tour_text_claim(pg_temp.inq('Tx Tomorrow'), 'reminder'); raise exception 'FAIL: staff claims a text';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform * from public.text_inbound('+13055550101', 'START'); raise exception 'FAIL: staff fakes a reply';
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from public.text_opt_outs; raise exception 'FAIL: staff clears opt-outs';
exception when insufficient_privilege then null; end $$;
select pg_temp.ok((select count(*) >= 1 from public.text_opt_outs), 'staff can see who opted out');
reset role;
select pg_temp.as_user(null);

-- ── claim → send → result ──
set role service_role;
select pg_temp.ok(public.tour_text_claim(pg_temp.inq('Tx Tomorrow'), 'reminder'), 'first claim wins');
select pg_temp.ok(not public.tour_text_claim(pg_temp.inq('Tx Tomorrow'), 'reminder'), 'second claim (overlapping run) loses');
select public.tour_text_result(pg_temp.inq('Tx Tomorrow'), 'reminder', '+13055550101', 'sent');
select pg_temp.ok(public.tour_text_claim(pg_temp.inq('Tx No Email'), 'reminder'), 'claim No Email');
select public.tour_text_result(pg_temp.inq('Tx No Email'), 'reminder', '+13055550102', 'failed');
select pg_temp.ok(public.tour_text_claim(pg_temp.inq('Tx Week Phone Only'), 'followup'), 'claim follow-up');
select public.tour_text_result(pg_temp.inq('Tx Week Phone Only'), 'followup', '+13055550108', 'opted_out');
reset role;
select pg_temp.ok(pg_temp.due('2026-10-09 15:30+00') = 'reminder:Tx No Email:+13055550102',
                  'sent and opted-out texts are done; a failed one is retried next run');
select pg_temp.ok((select body = 'Automatic tour reminder texted to +13055550101' and author is null
                   from public.activities where inquiry_id = pg_temp.inq('Tx Tomorrow') and kind = 'text'), 'sent text logged on the timeline');
select pg_temp.ok(exists (select 1 from public.text_opt_outs where phone = '+13055550108' and source = 'carrier'), 'carrier opt-out recorded');
select pg_temp.ok((select count(*) = 0 from public.activities where inquiry_id = pg_temp.inq('Tx No Email') and kind = 'text'), 'failed text not logged');
select pg_temp.ok((select count(*) = 1 from public.tour_emails_due('2026-10-09 14:30+00') where parent_name = 'Tx Tomorrow'),
                  'the reminder text does not stop the reminder email');
update public.inquiries set tour_at = '2026-10-10 15:00-04' where parent_name = 'Tx Tomorrow';
select pg_temp.ok((select reminder_texted_at is null from public.inquiries where parent_name = 'Tx Tomorrow'),
                  'rescheduling a tour re-arms its reminder text');

-- ── replies ──
set role service_role;
select pg_temp.ok((select action = 'message' and parent_name = 'Tx Tomorrow' from public.text_inbound('+13055550101', 'Can we come at 3 instead?')),
                  'a reply finds the family');
select pg_temp.ok((select action = 'opt_out' from public.text_inbound('+13055550101', ' stop. ')), 'STOP (any case, punctuation) opts out');
select pg_temp.ok((select action = 'opt_out' and inquiry_id is null from public.text_inbound('+13055559999', 'STOP')), 'unknown number: opt-out still kept');
reset role;
select pg_temp.ok((select string_agg(body, ' | ' order by created_at, body) from public.activities
                    where inquiry_id = pg_temp.inq('Tx Tomorrow') and kind = 'text' and body not like 'Automatic%')
                  = 'Text from family: Can we come at 3 instead? | Replied STOP by text: no more automatic texts', 'replies logged as texts');
select pg_temp.ok(pg_temp.due('2026-10-09 15:30+00') not like '%Tx Tomorrow%', 'opted-out family is not texted');
select pg_temp.ok(exists (select 1 from public.text_opt_outs where phone = '+13055559999'), 'unknown-number opt-out stored');
set role service_role;
select pg_temp.ok((select action = 'opt_in' from public.text_inbound('+13055550101', 'Start')), 'START opts back in');
reset role;
select pg_temp.ok(pg_temp.due('2026-10-09 15:30+00') like '%reminder:Tx Tomorrow%', 'texted again after START');
-- a reply after the tour counts as being in touch: no follow-up text
insert into public.inquiries (parent_name, phone, stage, tour_at) values ('Tx Week Replies', '305 555 0110', 'toured', '2026-10-02 10:00-04');
select pg_temp.ok(pg_temp.due('2026-10-09 15:30+00') like '%followup:Tx Week Replies%', 'silent family gets the follow-up text');
set role service_role;
select * from public.text_inbound('+13055550110', 'We loved it!') \g /dev/null
reset role;
select pg_temp.ok(pg_temp.due('2026-10-09 15:30+00') not like '%followup:Tx Week Replies%', 'family that replied gets no follow-up text');

update public.settings set texts_enabled = false;
\echo ALL TEXT TESTS PASSED
