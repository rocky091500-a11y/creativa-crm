-- Migration 005: Reschedule stage, Telegram alerts, blocked senders and the per-device limit.
-- Runs last (see run-db-tests.sh): users come from db.test.sql, and turnstile.test.sql leaves the
-- always-pass Turnstile test secret stored, so every website submission here carries a token.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
create or replace function pg_temp.from_ip(ip text) returns void language plpgsql as 'begin
  perform set_config(''request.headers'', case when ip is null then '''' else json_build_object(''x-forwarded-for'', ip || '', 10.0.0.1'')::text end, false); end';
create or replace function pg_temp.n(p_email text) returns bigint language sql as
  'select count(*) from public.inquiries where email = p_email';
create or replace function pg_temp.tg_calls() returns bigint language sql as
  'select count(*) from extensions.http_calls where uri like ''%/sendMessage''';

-- turnstile.test.sql re-ran 004, which puts its own submit_inquiry back: apply 005 again (also proves a rerun is safe).
\ir ../supabase/migrations/005_reschedule_telegram_spam.sql
\ir ../supabase/migrations/005_reschedule_telegram_spam.sql
select pg_temp.as_user(null);
select pg_temp.from_ip(null);

-- ── 1. Reschedule ──
insert into public.inquiries (parent_name, email, stage, tour_at) values
  ('Resched Mom', 'resched@example.com', 'tour_scheduled', now() + interval '1 day');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
update public.inquiries set stage = 'reschedule' where email = 'resched@example.com';
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select body = 'Tour scheduled → Reschedule' from public.activities a join public.inquiries i on i.id = a.inquiry_id
                   where i.email = 'resched@example.com' and a.kind = 'stage'), 'staff moves a tour to Reschedule; logged');
select pg_temp.ok(position('Resched Mom' in public.tours_calendar((select token from public.calendar_feed))) = 0,
                  'a tour waiting to be rescheduled leaves the calendar feed');
select pg_temp.ok(not exists (select 1 from public.tour_emails_due(now() + interval '1 hour') d
                              join public.inquiries i on i.id = d.inquiry_id where i.email = 'resched@example.com'),
                  'no reminder email while it waits to be rescheduled');
update public.inquiries set stage = 'tour_scheduled', tour_at = now() + interval '2 days' where email = 'resched@example.com';
select pg_temp.ok(position('Resched Mom' in public.tours_calendar((select token from public.calendar_feed))) > 0,
                  'back on the calendar once rescheduled');
do 'begin update public.inquiries set stage = ''someday'' where email = ''resched@example.com''; raise exception ''FAIL: bad stage'';
exception when check_violation then null; end';

-- ── 2. Telegram ──
select pg_temp.from_ip('198.51.100.1');
set role anon;
select public.submit_inquiry('contact', '{"first-name":"Quiet","email":"tg-quiet@example.com","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('tg-quiet@example.com') = 1 and pg_temp.tg_calls() = 0, 'Telegram not connected: request saved, nothing sent');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do 'begin perform public.set_telegram_token(''123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA''); raise exception ''FAIL: staff saved a token'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
do 'begin perform * from public.telegram_recent_chats(); raise exception ''FAIL: staff listed chats'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
do 'begin perform public._telegram_call(''getMe'', ''{}''); raise exception ''FAIL: staff called Telegram directly'';
exception when insufficient_privilege then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do 'begin perform public.set_telegram_token(''my bot''); raise exception ''FAIL: junk token accepted'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
select public.set_telegram_token('  123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ');
select pg_temp.ok((select string_agg(chat_id || '=' || title, ' | ' order by chat_id) from public.telegram_recent_chats())
                  = '-1009876543210=Creativa front desk | 555111222=Emily Owner', 'admin finds chats that messaged the bot');
update public.settings set telegram_chat_id = '555111222' where id = 1;
select pg_temp.ok(public.telegram_send_test() = 'ok', 'test message sends');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select telegram_token_set and telegram_last_result = 'ok' from public.settings), 'token saved, result recorded');
select pg_temp.ok((select secret = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' from vault.secrets where name = 'telegram_bot_token'),
                  'token stored (trimmed) in Vault');
select pg_temp.ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'settings'
                              and column_name like '%token' and data_type = 'text'), 'no token column in any CRM table');

truncate extensions.http_calls;
set role anon;
select public.submit_inquiry('schedule-tour', '{"parent-first-name":"Tele","parent-last-name":"Gram","email":"tg-tour@example.com",
  "phone":"(305) 555-0123","contact-pref":"Text","child-first-name":"Kiko","child-last-name":"Gram","child-dob":"2024-03-15",
  "program":"Early Twos","start-time":"As soon as possible","days[]":["Monday","Friday"],"time-pref":"9:30 am",
  "referral":"Friend or family","referred-by":"Ana Ruiz","notes":"Loves music","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.tg_calls() = 1, 'a new tour request sends one Telegram alert');
select pg_temp.ok((select content::jsonb ->> 'chat_id' = '555111222'
                      and content::jsonb ->> 'text' = concat_ws(chr(10), '🗓 New tour request',
                        'Tele Gram · (305) 555-0123 · tg-tour@example.com', 'Prefers: Text', 'Child: Kiko Gram, born Mar 15, 2024',
                        'Program: Early 2s', 'Start: As soon as possible', 'Tour days: Monday, Friday', 'Tour time: 9:30 am',
                        'Heard about us: Friend or family', 'Referred by: Ana Ruiz', 'Message: Loves music',
                        'Open the CRM: https://crm.creativaacademy.com/')
                   from extensions.http_calls), 'alert has every detail from the form');
select pg_temp.ok((select uri = 'https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage' from extensions.http_calls),
                  'sent to the Bot API with the saved token');

-- resubmit within 2 minutes updates the same inquiry: no second alert
set role anon;
select public.submit_inquiry('schedule-tour', '{"parent-first-name":"Tele","parent-last-name":"Gram","email":"tg-tour@example.com",
  "phone":"(305) 555-0123","child-first-name":"Kiko","child-dob":"2024-03-15","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('tg-tour@example.com') = 1 and pg_temp.tg_calls() = 1, 'resubmit: no duplicate alert');

-- only the chosen forms; never staff-added inquiries
update public.settings set telegram_forms = '{schedule-tour}' where id = 1;
set role anon;
select public.submit_inquiry('contact', '{"first-name":"Hi","email":"tg-contact@example.com","cf-turnstile-response":"tok"}'::jsonb);
reset role;
insert into public.inquiries (parent_name, phone, source) values ('Walk-in', '305 555 0001', 'manual');
select pg_temp.ok(pg_temp.n('tg-contact@example.com') = 1 and pg_temp.tg_calls() = 1, 'forms not picked and staff-added inquiries: no alert');
update public.settings set telegram_forms = array['schedule-tour','waitlist','contact','bloom-interest','family-support'] where id = 1;

-- Telegram trouble never loses a family
update public.settings set telegram_chat_id = '999' where id = 1;
set role anon;
select public.submit_inquiry('waitlist', '{"parent_name":"Wrong Chat","email":"tg-badchat@example.com","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('tg-badchat@example.com') = 1 and (select telegram_last_result = 'Bad Request: chat not found' from public.settings),
                  'wrong chat: request saved, error shown on Settings');
update public.settings set telegram_chat_id = '555111222' where id = 1;
update vault.secrets set secret = '123456789:TIMEOUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' where name = 'telegram_bot_token';
set role anon;
select public.submit_inquiry('waitlist', '{"parent_name":"Slow","email":"tg-timeout@example.com","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('tg-timeout@example.com') = 1, 'Telegram unreachable: request saved');
select pg_temp.ok((select telegram_last_result like '%timed out%' and telegram_last_result not like '%TIMEOUTAAAA%' from public.settings),
                  'error recorded without the token in it');
update vault.secrets set secret = '000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' where name = 'telegram_bot_token';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.ok(public.telegram_send_test() = 'Unauthorized', 'revoked token: test shows Telegram''s answer');
do 'begin perform * from public.telegram_recent_chats(); raise exception ''FAIL: no error'';
exception when others then if sqlerrm not like ''Telegram said: Unauthorized'' then raise; end if; end';
select public.set_telegram_token('');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select not telegram_token_set from public.settings) and public._telegram_token() is null, 'admin can disconnect the bot');
truncate extensions.http_calls;
select pg_temp.from_ip('198.51.100.2');   -- the first device has used up its 5 requests this hour
set role anon;
select public.submit_inquiry('contact', '{"first-name":"After","email":"tg-after@example.com","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('tg-after@example.com') = 1 and pg_temp.tg_calls() = 0, 'disconnected: nothing sent');

-- ── 3. Spam: device, blocked senders ──
select pg_temp.from_ip('203.0.113.9');
set role anon;
select public.submit_inquiry('contact', '{"first-name":"Pest","email":"pest@example.com","phone":"305-555-0177","message":"junk","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.ok((select client_ip = '203.0.113.9' from public.inquiries where email = 'pest@example.com'), 'device (first forwarded IP) kept on the inquiry');
select set_config('request.headers', '{"cf-connecting-ip":"192.0.2.44","x-forwarded-for":"203.0.113.9"}', false);
select pg_temp.ok(public._client_ip() = '192.0.2.44', 'Cloudflare''s client IP wins over the forwarded chain');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do 'begin perform public.mark_inquiry_spam((select id from public.inquiries where email = ''pest@example.com'')); raise exception ''FAIL: staff marked spam'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
select pg_temp.ok((select count(*) = 0 from public.intake_blocklist), 'staff cannot see blocked senders');
select pg_temp.ok(not public.turnstile_configured(), 'staff are not told about the Turnstile secret');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.ok(public.turnstile_configured(), 'admin sees the robot check is on');
select pg_temp.ok(public.mark_inquiry_spam((select id from public.inquiries where email = 'pest@example.com')) = 3, 'admin marks spam: 3 senders blocked');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok(pg_temp.n('pest@example.com') = 0, 'spam inquiry deleted');
select pg_temp.ok((select string_agg(kind || '=' || value, ',' order by kind) from public.intake_blocklist)
                  = 'email=pest@example.com,ip=203.0.113.9,phone=3055550177', 'email, phone and device blocked');

select pg_temp.from_ip('198.51.100.77');
set role anon;
select public.submit_inquiry('schedule-tour', '{"parent-first-name":"Pest","email":"PEST@example.com","cf-turnstile-response":"tok"}'::jsonb);
select public.submit_inquiry('contact', '{"first-name":"Pest","email":"pest2@example.com","phone":"+1 (305) 555-0177","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.from_ip('203.0.113.9');
set role anon;
select public.submit_inquiry('contact', '{"first-name":"Pest","email":"pest3@example.com","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('pest@example.com') + pg_temp.n('pest2@example.com') + pg_temp.n('pest3@example.com') = 0,
                  'blocked email (any case), phone (any format) and device are refused');
select pg_temp.ok((select count(*) = 3 from public.intake_blocked where reason = 'blocked-sender'), 'refusals logged as blocked sender');

-- admin unblocks; adds a phone by hand (stored as 10 digits)
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
delete from public.intake_blocklist where kind = 'ip';
insert into public.intake_blocklist (kind, value, note) values ('phone', '(786) 555-0000', 'Prank caller');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok(exists (select 1 from public.intake_blocklist where kind = 'phone' and value = '7865550000'), 'hand-added phone normalised');
set role anon;
select public.submit_inquiry('contact', '{"first-name":"Shared wifi","email":"neighbor@example.com","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('neighbor@example.com') = 1, 'unblocked device can send again');

-- one device: at most 5 website requests an hour
select pg_temp.from_ip('198.51.100.200');
set role anon;
select public.submit_inquiry('contact', jsonb_build_object('first-name', 'Flood', 'email', 'flood' || g || '@example.com', 'cf-turnstile-response', 'tok'))
  from generate_series(1, 7) g;
reset role;
select pg_temp.ok((select count(*) = 5 from public.inquiries where email like 'flood%@example.com'), 'sixth request from one device in an hour refused');
select pg_temp.ok((select count(*) = 2 from public.intake_blocked where reason = 'too-many-from-device'), 'logged as too many from device');
select pg_temp.from_ip(null);

-- anon never sees the list or the admin tools
set role anon;
do 'begin perform count(*) from public.intake_blocklist; raise exception ''FAIL: anon read blocklist'';
exception when insufficient_privilege then null; end';
do 'begin perform public.mark_inquiry_spam(gen_random_uuid()); raise exception ''FAIL: anon marked spam'';
exception when insufficient_privilege then null; end';
do 'begin perform public.set_telegram_token(''x''); raise exception ''FAIL: anon set token'';
exception when insufficient_privilege then null; end';
reset role;

\echo ALL RESCHEDULE/TELEGRAM/SPAM TESTS PASSED
