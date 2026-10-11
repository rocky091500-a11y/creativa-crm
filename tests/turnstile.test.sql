-- Turnstile check on website intake (migration 004). Runs after db.test.sql (see run-db-tests.sh).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.n(p_email text) returns bigint language sql as
  'select count(*) from public.inquiries where email = p_email';

-- 1. No secret stored yet: intake works exactly as before, with or without a token.
set role anon;
select public.submit_inquiry('contact', '{"first-name":"Before","email":"ts-before@example.com","message":"hi"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('ts-before@example.com') = 1, 'not configured: submissions still saved');

-- 2. Turn checking on with Cloudflare's always-pass test secret.
select vault.create_secret('1x0000000000000000000000000000000AA', 'turnstile_secret_key');
set role anon;
select public.submit_inquiry('contact', '{"first-name":"Bot","email":"ts-bot@example.com","message":"spam"}'::jsonb);
select public.submit_inquiry('schedule-tour', '{"parent-first-name":"Real","email":"ts-real@example.com","phone":"305-555-0111",
  "cf-turnstile-response":"XXXX.DUMMY.TOKEN.XXXX"}'::jsonb);
select public.submit_inquiry('waitlist', '{"parent_name":"Outage","email":"ts-outage@example.com",
  "cf-turnstile-response":"SIMULATE-OUTAGE"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('ts-bot@example.com') = 0, 'no token: refused');
select pg_temp.ok((select reason = 'missing-input-response' and form = 'contact'
                   from public.intake_blocked order by id desc limit 1 offset 0) is not null
                  and exists (select 1 from public.intake_blocked where reason = 'missing-input-response'), 'refusal logged with reason');
select pg_temp.ok(pg_temp.n('ts-real@example.com') = 1, 'valid token: saved');
select pg_temp.ok((select ok and reason = 'ok' from public._turnstile_check('XXXX.DUMMY.TOKEN.XXXX')),
                  'valid token is actually confirmed by the verifier (not let through by the outage rule)');
select pg_temp.ok((select not raw ? 'cf-turnstile-response' from public.inquiries where email = 'ts-real@example.com'),
                  'token not stored on the inquiry');
select pg_temp.ok((select parent_name = 'Real' and phone = '305-555-0111' from public.inquiries where email = 'ts-real@example.com'),
                  'fields mapped as before');
select pg_temp.ok(pg_temp.n('ts-outage@example.com') = 1, 'Cloudflare unreachable: saved anyway (no family lost)');

-- 3. A secret that always fails (as a forged or replayed token would).
update vault.secrets set secret = '2x0000000000000000000000000000000AA' where name = 'turnstile_secret_key';
set role anon;
select public.submit_inquiry('bloom-interest', '{"parent-name":"Forged","parent-email":"ts-forged@example.com",
  "cf-turnstile-response":"forged-token"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('ts-forged@example.com') = 0, 'invalid token: refused');
select pg_temp.ok(exists (select 1 from public.intake_blocked where reason = 'invalid-input-response' and form = 'bloom-interest'),
                  'invalid token logged');
select pg_temp.ok(not exists (select 1 from information_schema.columns
                              where table_schema = 'public' and table_name = 'intake_blocked'
                                and column_name not in ('id','created_at','form','reason')),
                  'blocked log holds no personal data');

-- 4. Unknown forms and missing contact details still behave as before (errors from the core).
update vault.secrets set secret = '1x0000000000000000000000000000000AA' where name = 'turnstile_secret_key';
do 'begin
  perform public.submit_inquiry(''pno-booking'', ''{"email":"a@b.co","cf-turnstile-response":"t"}''::jsonb);
  raise exception ''FAIL: unknown form accepted'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';

-- 5. Who can do what.
set role anon;
do 'begin perform count(*) from public.intake_blocked; raise exception ''FAIL: anon read blocked log'';
exception when insufficient_privilege then null; end';
do 'begin perform public._submit_inquiry_core(''contact'', ''{"email":"x@y.co"}''::jsonb); raise exception ''FAIL: anon bypassed the check'';
exception when insufficient_privilege then null; end';
do 'begin perform public._turnstile_check(''t''); raise exception ''FAIL: anon called the checker'';
exception when insufficient_privilege then null; end';
reset role;
select set_config('request.jwt.claim.sub', (select id::text from public.profiles where active limit 1), false) \g /dev/null
set role authenticated;
select pg_temp.ok((select count(*) > 0 from public.intake_blocked), 'active staff can see blocked count');
reset role;

-- 6. Running the migration again changes nothing.
\ir ../supabase/migrations/004_turnstile.sql
select pg_temp.ok((select count(*) = 1 from pg_proc where proname = '_submit_inquiry_core'), 'rerun: core kept once');
set role anon;
select public.submit_inquiry('contact', '{"first-name":"After rerun","email":"ts-rerun@example.com","cf-turnstile-response":"tok"}'::jsonb);
reset role;
select pg_temp.ok(pg_temp.n('ts-rerun@example.com') = 1, 'rerun: intake still works');

\echo ALL TURNSTILE TESTS PASSED
