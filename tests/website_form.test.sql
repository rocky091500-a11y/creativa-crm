-- Migration 028: Netlify's copy of a website form, saved by the server unless the CRM already has it.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
\ir ../supabase/migrations/028_website_form_backup.sql
\ir ../supabase/migrations/028_website_form_backup.sql

create temp table tour as select jsonb_build_object('form-name', 'schedule-tour', 'parent-first-name', 'Nora', 'parent-last-name', 'Backup',
  'email', 'Nora.Backup@example.com', 'phone', '(786) 555-0142', 'contact-pref', 'Text', 'child-first-name', 'Lia',
  'child-last-name', 'Backup', 'child-dob', '2024-08-25', 'program', 'Early Twos', 'start-time', 'In approximately 3 months',
  'days[]', jsonb_build_array('Monday'), 'time-pref', '9:30 am', 'notes', 'None', 'referral', 'Friend or family',
  'referred-by', 'A Friend', 'ip', '203.0.113.7', 'user_agent', 'Mozilla', 'referrer', 'https://example.com/tour/') as d;
grant select on tour to service_role;

set role service_role;
select pg_temp.ok(public.submit_inquiry_netlify('schedule-tour', (select d from tour), 'nf-1', now()) = 'saved', 'a request only Netlify got is saved');
reset role;
select pg_temp.ok((select count(*) = 1 and bool_and(source = 'schedule-tour' and parent_name = 'Nora Backup' and child_name = 'Lia Backup'
                          and program = 'Early 2s' and child_dob = '2024-08-25' and client_ip = '203.0.113.7'
                          and raw ->> 'netlify_id' = 'nf-1' and not raw ? 'user_agent')
                     from public.inquiries where email = 'nora.backup@example.com'), 'like a website request, with the family''s device');
set role service_role;
select pg_temp.ok(public.submit_inquiry_netlify('schedule-tour', (select d from tour), 'nf-1', now()) = 'already in the CRM', 'Netlify sending it again: nothing added');
reset role;
select pg_temp.ok((select count(*) = 1 from public.inquiries where email = 'nora.backup@example.com'), 'still one');

-- The browser copy arrived first: Netlify's copy only marks it.
select public._submit_inquiry_core('waitlist', jsonb_build_object('email', 'wanda@example.com', 'parent-name', 'Wanda Browser'));
set role service_role;
select pg_temp.ok(public.submit_inquiry_netlify('waitlist', jsonb_build_object('email', 'Wanda@Example.com', 'parent-name', 'Wanda Browser'),
                                                'nf-2', now()) = 'already in the CRM', 'the browser copy is already there: not added twice');
reset role;
select pg_temp.ok((select count(*) = 1 and bool_and(raw ->> 'netlify_id' = 'nf-2') from public.inquiries where email = 'wanda@example.com'),
                  '... it just gets Netlify''s id');

-- Spam protection still applies; the robot check doesn't.
insert into public.intake_blocklist (kind, value) values ('email', 'spam@example.com');
set role service_role;
select pg_temp.ok(public.submit_inquiry_netlify('contact', jsonb_build_object('email', 'spam@example.com'), 'nf-3', now()) = 'not saved: blocked-sender',
                  'a blocked sender isn''t saved');
select pg_temp.ok(public.submit_inquiry_netlify('contact', jsonb_build_object('email', 'bot@example.com', 'bot-field', 'x'), 'nf-4', now()) = 'not saved: a bot',
                  'the honeypot');
select pg_temp.ok(public.submit_inquiry_netlify('newsletter', jsonb_build_object('email', 'n@example.com'), 'nf-5', now()) = 'not a CRM form',
                  'other Netlify forms are left alone');
select pg_temp.ok(public.submit_inquiry_netlify('contact', jsonb_build_object('notes', 'no way to reach me'), 'nf-6', now()) like 'not saved: %',
                  'no email or phone: not saved, no error');
reset role;
select pg_temp.ok(exists (select 1 from public.intake_blocked where reason = 'blocked-sender'), 'counted on Settings → Spam protection');
select pg_temp.ok(not exists (select 1 from public.inquiries where email in ('spam@example.com', 'bot@example.com', 'n@example.com')), 'none of those saved');

-- Only the server can call it.
set role anon;
do 'begin perform public.submit_inquiry_netlify(''contact'', ''{"email": "x@example.com"}'', ''nf-7'', now()); raise exception ''FAIL: anon called it'';
exception when insufficient_privilege then null; end';
set role authenticated;
do 'begin perform public.submit_inquiry_netlify(''contact'', ''{"email": "x@example.com"}'', ''nf-7'', now()); raise exception ''FAIL: staff called it'';
exception when insufficient_privilege then null; end';
reset role;
select pg_temp.ok(true, 'the website and staff can''t call it');
\echo ALL WEBSITE FORM BACKUP TESTS PASSED
