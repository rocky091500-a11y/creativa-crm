-- Migration 013: texts to families. Runs last (users from db.test.sql: owner = admin, teacher = staff, books = finance edit).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/013_family_texts.sql
create or replace function pg_temp.tomorrow_at(t text) returns timestamptz language sql as
  'select ((now() at time zone ''America/New_York'')::date + 1 + t::time) at time zone ''America/New_York''';
select pg_temp.as_user(null);
update public.profiles set finance = 'edit' where email = 'books@creativaacademy.com';
update public.profiles set finance = 'view' where email = 'teacher@creativaacademy.com';
insert into public.text_opt_outs (phone) values ('+13055559999') on conflict do nothing;

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- view-only finance: can't text
do 'begin insert into public.messages (audience, body) values (''x'', ''y''); raise exception ''FAIL: view-only sent a text'';
exception when insufficient_privilege then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- finance editor
create temp table m as with ins as (insert into public.messages (audience, body) values ('Families who owe', 'Hi {parent}, balance {balance}') returning id) select id from ins;
insert into public.message_recipients (message_id, name, phone, body)
  select id, x.n, x.p, x.b from m, (values ('Ana', '+13055550101', 'Hi Ana, balance $260.00'), ('Bo', '+13055550102', 'Hi Bo, balance $40.00'),
                                            ('Stop', '+13055559999', 'Hi Stop, balance $1.00')) as x(n, p, b);
do 'begin insert into public.message_recipients (message_id, phone, body, status) select id, ''+13055550111'', ''x'', ''sent'' from m;
  raise exception ''FAIL: inserted as sent''; exception when insufficient_privilege then null; end';
do 'begin insert into public.message_recipients (message_id, phone, body) select id, ''3055550111'', ''x'' from m;
  raise exception ''FAIL: bad phone''; exception when check_violation then null; end';
do 'begin update public.message_recipients set status = ''sent''; raise exception ''FAIL: changed a status'';
exception when insufficient_privilege then null; end';
select pg_temp.ok((select count(*) = 3 from public.message_recipients), 'queued three texts');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 0 from public.family_texts_due(pg_temp.tomorrow_at('23:30'))), 'nothing goes out at 11:30pm');
select pg_temp.ok((select status = 'opted_out' from public.message_recipients where phone = '+13055559999'), 'an opted-out number is skipped');
select pg_temp.ok((select count(*) = 2 from public.family_texts_due(pg_temp.tomorrow_at('10:00'))), 'two due at 10am');
select pg_temp.ok(public.family_text_claim((select id from public.message_recipients where phone = '+13055550101')), 'claim');
select pg_temp.ok(not public.family_text_claim((select id from public.message_recipients where phone = '+13055550101')), 'never claimed twice');
select public.family_text_result((select id from public.message_recipients where phone = '+13055550101'), 'sent');
select pg_temp.ok((select status = 'sent' and sent_at is not null from public.message_recipients where phone = '+13055550101'), 'sent recorded');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok(public.message_cancel((select id from m)) = 1, 'cancel: the one not sent yet');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select string_agg(status, ',' order by phone) from public.message_recipients) = 'sent,canceled,opted_out', 'statuses');
select pg_temp.ok((select count(*) = 0 from public.family_texts_due(pg_temp.tomorrow_at('10:00'))), 'a canceled text never goes out');
select pg_temp.ok((select count(*) >= 1 from public.change_log where table_name = 'messages'), 'sending a text shows on Changes');
set role anon;
do 'begin perform count(*) from public.messages; raise exception ''FAIL: anon reads texts''; exception when insufficient_privilege then null; end';
reset role;
\echo ALL MESSAGE TESTS PASSED
