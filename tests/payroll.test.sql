-- Migration 008: late fees, receipt license and signature, payroll time clock.
-- Runs after the other tests (users from db.test.sql: owner = admin, teacher = staff, books = finance edit).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/008_payroll_timeclock.sql
select pg_temp.as_user(null);
update public.profiles set finance = 'edit', payroll = false where email = 'books@creativaacademy.com';
update public.profiles set finance = 'none', payroll = false where email = 'teacher@creativaacademy.com';

-- ═════════════ late fees ═════════════
insert into public.students (name, status) values ('Late Paid', 'enrolled'), ('Late Partial', 'enrolled'), ('Late Unpaid', 'enrolled'), ('Late Current', 'enrolled');
insert into public.invoices (student_id, kind, description, period_start, invoice_date, due_date, amount)
  select id, 'tuition', 'Tuition', '2026-09-21', '2026-09-21', '2026-09-21', 560
    from public.students where name in ('Late Paid', 'Late Partial', 'Late Unpaid');
-- an invoice whose Friday grace hasn't passed yet
insert into public.invoices (student_id, kind, description, period_start, invoice_date, due_date, amount)
  select id, 'tuition', 'Tuition', '2026-09-21', current_date - 2, current_date - 2, 560 from public.students where name = 'Late Current';
insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, payer, method)
  select i.student_id, i.id, '2026-09-23', '2026-09-01', x.amt, 'parent', 'zelle'
    from public.invoices i join public.students s on s.id = i.student_id
    join (values ('Late Paid', 560), ('Late Partial', 300)) as x(n, amt) on x.n = s.name;
select pg_temp.ok((select late_fee_amount = 30 from public.settings), 'late fee is $30');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- staff, no finance
do 'begin perform public.create_late_fees(''2026-09-21''); raise exception ''FAIL: staff added late fees'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- finance editor
select pg_temp.ok(public.create_late_fees('2026-09-21') = 2, 'late fee for the partly paid and the unpaid invoice, not the paid one or one still in its grace days');
select pg_temp.ok(public.create_late_fees('2026-09-21') = 0, 'running it again adds no second fee');
select pg_temp.ok((select string_agg(s.name || '=' || f.amount || '/' || f.kind || '/' || f.description, ', ' order by s.name)
                     from public.invoices f join public.students s on s.id = f.student_id where f.late_fee_for is not null)
                  = 'Late Partial=30.00/fee/Late fee, Late Unpaid=30.00/fee/Late fee', 'fees are $30 fee invoices for the right children');
select pg_temp.ok((select note from public.invoices f join public.students s on s.id = f.student_id where s.name = 'Late Unpaid' and f.late_fee_for is not null)
                  = 'Tuition for the period starting Sep 21 not paid by Friday Sep 25', 'the fee says what it is for');
select pg_temp.ok((select bool_and(f.student_id = t.student_id and t.kind = 'tuition') from public.invoices f join public.invoices t on t.id = f.late_fee_for),
                  'each fee points at that child''s tuition invoice');
-- waiving = voiding the fee; it stays waived
update public.invoices f set void = true from public.students s where s.id = f.student_id and s.name = 'Late Unpaid' and f.late_fee_for is not null;
select pg_temp.ok(public.create_late_fees('2026-09-21') = 0, 'a waived fee is not added again');
reset role;
select pg_temp.as_user(null);
do 'begin insert into public.invoices (student_id, kind, description, invoice_date, due_date, amount, late_fee_for)
  select f.student_id, ''tuition'', ''x'', current_date, current_date, 1, f.late_fee_for from public.invoices f where f.late_fee_for is not null limit 1;
  raise exception ''FAIL: tuition invoice as a late fee''; exception when check_violation then null; end';
update public.settings set late_fee_amount = 0;
select pg_temp.ok((select count(*) from public.invoices where late_fee_for is not null and not void) = 1, 'one live fee, one waived');
delete from public.invoices where late_fee_for is not null;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok(public.create_late_fees('2026-09-21') = 0, 'a $0 late fee setting turns late fees off');
reset role;
select pg_temp.as_user(null);
update public.settings set late_fee_amount = 30;

-- ═════════════ receipts: license number, signature ═════════════
select pg_temp.ok((select receipt_license = 'C11MD1517' from public.settings), 'license number on receipts');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');   -- admin
update public.receipt_signature set image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
select pg_temp.ok((select updated_by = '00000000-0000-0000-0000-00000000000a' from public.receipt_signature), 'admin uploads the signature');
do 'begin update public.receipt_signature set image = ''data:text/html;base64,PHNjcmlwdD4=''; raise exception ''FAIL: non-image accepted'';
exception when check_violation then null; end';
do 'begin update public.receipt_signature set image = ''data:image/png;base64,abc" onerror="x''; raise exception ''FAIL: quote accepted'';
exception when check_violation then null; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- finance editor: sees it, can't change it
select pg_temp.ok((select image like 'data:image/png;base64,%' from public.receipt_signature), 'finance sees the signature for receipts');
update public.receipt_signature set image = null;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- staff without finance
select pg_temp.ok((select count(*) = 0 from public.receipt_signature), 'staff without finance can''t see the signature');
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select image is not null from public.receipt_signature), 'only admins change the signature');
set role anon;
do 'begin perform count(*) from public.receipt_signature; raise exception ''FAIL: anon reads signature'';
exception when insufficient_privilege then null; end';
reset role;

-- ═════════════ pay schedule ═════════════
select pg_temp.ok((select payroll_anchor = '2026-10-12' and (payroll_anchor - billing_anchor) % 14 = 7 from public.settings),
                  'pay periods start the weeks between tuition Mondays (Oct 12 vs Oct 5)');
select pg_temp.ok((select (period_start, period_end) = ('2026-10-12'::date, '2026-10-25'::date) from public.payroll_period('2026-10-15')), 'every two weeks from Mon Oct 12');
select pg_temp.ok((select (period_start, period_end) = ('2026-09-28'::date, '2026-10-11'::date) from public.payroll_period('2026-10-05')), 'periods before the start date too');
select pg_temp.ok(not exists (select 1 from generate_series(0, 25) n
                               where (public.payroll_period('2026-10-05'::date + 14 * n)).period_start = '2026-10-05'::date + 14 * n),
                  'no pay period starts on a tuition billing Monday, all school year');
update public.settings set payroll_anchor = '2026-10-05';   -- what the first copy of 008 set
\ir ../supabase/migrations/008_payroll_timeclock.sql
select pg_temp.ok((select payroll_anchor = '2026-10-12' from public.settings), 'running 008 again moves an Oct 5 start to Oct 12');
select pg_temp.ok(public.payroll_week_start('2026-10-15') = '2026-10-12' and public.payroll_week_start('2026-10-12') = '2026-10-12', 'workweeks start Monday');
update public.settings set payroll_frequency = 'weekly';
select pg_temp.ok((select (period_start, period_end) = ('2026-10-12'::date, '2026-10-18'::date) from public.payroll_period('2026-10-15')), 'weekly');
update public.settings set payroll_frequency = 'semimonthly';
select pg_temp.ok((select (period_start, period_end) = ('2026-10-01'::date, '2026-10-15'::date) from public.payroll_period('2026-10-15'))
              and (select (period_start, period_end) = ('2026-10-16'::date, '2026-10-31'::date) from public.payroll_period('2026-10-16'))
              and (select (period_start, period_end) = ('2027-02-16'::date, '2027-02-28'::date) from public.payroll_period('2027-02-20')), 'twice a month');
update public.settings set payroll_frequency = 'monthly';
select pg_temp.ok((select (period_start, period_end) = ('2026-10-01'::date, '2026-10-31'::date) from public.payroll_period('2026-10-15')), 'monthly');
update public.settings set payroll_frequency = 'biweekly', payroll_anchor = '2026-10-04';   -- Sunday
select pg_temp.ok(public.payroll_week_start('2026-10-15') = '2026-10-11', 'workweek follows the start day (Sunday)');
update public.settings set payroll_anchor = '2026-10-12';

-- ═════════════ payroll access ═════════════
insert into public.employees (first_name, last_name, position, pay_rate, lunch_minutes, schedule) values
  ('Ana', 'Clock', 'Teacher', 16.50, 30, '8:00 – 4:30'),
  ('Bea', 'Office', 'Assistant teacher', 15.00, 60, '9:00 – 6:00'),
  ('Cleo', 'Gone', 'Chef', 16.00, 0, null);
update public.employees set active = false where first_name = 'Cleo';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- finance is not payroll
select pg_temp.ok((select count(*) = 0 from public.employees), 'finance access alone doesn''t show pay rates');
do 'begin insert into public.employees (first_name) values (''Sneaky''); raise exception ''FAIL: non-payroll added an employee'';
exception when insufficient_privilege then null; end';
do 'begin perform public.payroll_set_pin((select id from public.employees limit 1)); raise exception ''FAIL: non-payroll set a PIN'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
do 'begin perform public.timeclock_add_device(''x''); raise exception ''FAIL: non-payroll added a device'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');   -- admin turns payroll on for the bookkeeper
update public.profiles set payroll = true where email = 'books@creativaacademy.com';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok((select count(*) = 3 from public.employees), 'payroll access shows staff and rates');
update public.profiles set payroll = false where id = auth.uid();
select pg_temp.ok((select payroll from public.profiles where id = auth.uid()), 'non-admins can''t change their own payroll access');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do 'begin update public.profiles set payroll = true where id = auth.uid(); raise exception ''FAIL: admin changed own payroll access'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
do 'begin perform count(*) from public.employee_pins; raise exception ''FAIL: PIN hashes readable'';
exception when insufficient_privilege then null; end';

-- ═════════════ PINs and the device ═════════════
create temp table t (k text primary key, v text);
grant all on t to authenticated, anon;
insert into t select 'pin_ana', public.payroll_set_pin(id, '4826') from public.employees where first_name = 'Ana';
insert into t select 'pin_bea', public.payroll_set_pin(id) from public.employees where first_name = 'Bea';
select pg_temp.ok((select v ~ '^[0-9]{4}$' and v not in ('0000', '1234', '1111') from t where k = 'pin_bea'), 'made-up PIN is 4 digits and not an easy one');
select pg_temp.ok((select pin_set_at is not null from public.employees where first_name = 'Bea'), 'employee shows a PIN is set');
do 'begin perform public.payroll_set_pin((select id from public.employees where first_name = ''Ana''), ''1234''); raise exception ''FAIL: 1234 accepted'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
do 'begin perform public.payroll_set_pin((select id from public.employees where first_name = ''Ana''), ''12a4''); raise exception ''FAIL: letters accepted'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
insert into t values ('token', public.timeclock_add_device('Front desk tablet'));
select pg_temp.ok((select v ~ '^[0-9a-f]{48}$' from t where k = 'token'), 'device key is 48 random hex characters');
select pg_temp.ok((select count(*) = 1 and bool_and(token_hash <> (select v from t where k = 'token')) from public.timeclock_devices), 'only a hash of the key is stored');
insert into t select 'ana', id::text from public.employees where first_name = 'Ana';
insert into t select 'bea', id::text from public.employees where first_name = 'Bea';
reset role;
select pg_temp.as_user(null);

-- ═════════════ the time clock, without a login ═════════════
create or replace function pg_temp.punch(who text, action text) returns jsonb language sql as
  'select public.timeclock_punch((select v from t where k = ''token''), (select v::uuid from t where k = who), (select v from t where k = ''pin_'' || who), action)';
grant execute on function pg_temp.punch(text, text) to anon;
set role anon;
do 'begin perform public.timeclock_add_device(''x''); raise exception ''FAIL: anon added a device'';
exception when insufficient_privilege then null; end';
do 'begin perform count(*) from public.time_entries; raise exception ''FAIL: anon reads time''; exception when insufficient_privilege then null; end';
do 'begin perform count(*) from public.employees; raise exception ''FAIL: anon reads employees''; exception when insufficient_privilege then null; end';
select pg_temp.ok(public.timeclock_roster('not-a-device-key-not-a-device-key-0000') = '{"error": "device"}', 'unknown device gets nothing');
select pg_temp.ok(public.timeclock_roster(null) = '{"error": "device"}', 'no key gets nothing');
select pg_temp.ok((select jsonb_array_length(public.timeclock_roster(v)->'people') = 2 from t where k = 'token'), 'roster: active people with a PIN');
select pg_temp.ok((select public.timeclock_roster(v)->'people'->0->>'name' = 'Ana Clock' from t where k = 'token'), 'roster lists names in order');
select pg_temp.ok((select public.timeclock_state((select v from t where k = 'token'), (select v::uuid from t where k = 'ana'), '0000')->>'error' = 'pin'), 'wrong PIN');
select pg_temp.ok((select public.timeclock_state('bad-key-bad-key-bad-key-bad-key-bad-key', (select v::uuid from t where k = 'ana'), '4826')->>'error' = 'device'), 'right PIN on an unknown device');
select pg_temp.ok((select (public.timeclock_state((select v from t where k = 'token'), (select v::uuid from t where k = 'ana'), '4826')->>'status') = 'out'), 'right PIN: Ana is out');
-- Five wrong PINs in a row lock the clock for that person, even with the right PIN.
select pg_temp.ok((select count(*) = 4 from (select public.timeclock_state((select v from t where k = 'token'), (select v::uuid from t where k = 'bea'), '0000') s
                    from generate_series(1, 4)) x where s->>'error' = 'pin'), 'four wrong PINs');
select pg_temp.ok((select public.timeclock_state((select v from t where k = 'token'), (select v::uuid from t where k = 'bea'), '0000')->>'error' = 'locked'), 'fifth wrong PIN locks');
select pg_temp.ok((select public.timeclock_state((select v from t where k = 'token'), (select v::uuid from t where k = 'bea'), (select v from t where k = 'pin_bea'))->>'error' = 'locked'), 'locked even with the right PIN');
reset role;
update public.employee_pins set locked_until = now() - interval '1 second';
set role anon;
select pg_temp.ok((select public.timeclock_state((select v from t where k = 'token'), (select v::uuid from t where k = 'bea'), (select v from t where k = 'pin_bea'))->>'status' = 'out'), 'unlocked after 15 minutes');

-- Ana's day: in, lunch, back, out.
select pg_temp.ok(pg_temp.punch('ana', 'in')->>'status' = 'in', 'clock in');
select pg_temp.ok(pg_temp.punch('ana', 'in')->>'error' = 'state', 'clocking in twice does nothing');
select pg_temp.ok((select (public.timeclock_roster(v)->'people'->0->>'in')::boolean from t where k = 'token'), 'roster shows Ana is in');
select pg_temp.ok(pg_temp.punch('ana', 'lunch')->>'status' = 'lunch', 'out for lunch');
select pg_temp.ok(pg_temp.punch('ana', 'lunch')->>'error' = 'state', 'lunch twice does nothing');
select pg_temp.ok((pg_temp.punch('ana', 'in') - 'at' - 'since') ?& array['done', 'today_minutes', 'week_minutes', 'period_minutes'], 'back from lunch, with today, week and period minutes');
select pg_temp.ok(pg_temp.punch('ana', 'out')->>'status' = 'out', 'clock out');
select pg_temp.ok(pg_temp.punch('ana', 'out')->>'error' = 'state', 'clocking out twice does nothing');
-- Bea goes to lunch and doesn't come back: "done for the day" from lunch.
select pg_temp.ok(pg_temp.punch('bea', 'in')->>'status' = 'in', 'Bea clocks in');
select pg_temp.ok(pg_temp.punch('bea', 'lunch')->>'status' = 'lunch', 'and goes to lunch');
select pg_temp.ok(pg_temp.punch('bea', 'out')->>'status' = 'out', 'done for the day while out for lunch');
reset role;
select pg_temp.ok((select string_agg(out_reason || '/' || source, ', ' order by clock_in) from public.time_entries e
                    where e.employee_id = (select v::uuid from t where k = 'ana')) = 'lunch/clock, out/clock', 'Ana: two stretches from the clock');
select pg_temp.ok((select string_agg(out_reason, ', ') from public.time_entries e where e.employee_id = (select v::uuid from t where k = 'bea')) = 'out',
                  'Bea: lunch clock-out became the end of her day');
select pg_temp.ok((select bool_and(device_id is not null and work_date = (now() at time zone 'America/New_York')::date) from public.time_entries), 'punches note the device and the day');
-- lunch over 3 hours ago counts as gone for the day; a stretch open 2 days is a missed clock-out
alter table public.time_entries disable trigger time_entries_guard;
update public.time_entries set clock_in = clock_in - interval '6 hours', clock_out = clock_out - interval '6 hours'
 where employee_id = (select v::uuid from t where k = 'ana');
insert into public.time_entries (employee_id, clock_in, source) select v::uuid, now() - interval '2 days', 'clock' from t where k = 'bea';
alter table public.time_entries enable trigger time_entries_guard;
set role anon;
select pg_temp.ok((select (public.timeclock_state((select v from t where k = 'token'), (select v::uuid from t where k = 'bea'), (select v from t where k = 'pin_bea'))->>'missed_clock_out')::date
                   = ((now() - interval '2 days') at time zone 'America/New_York')::date), 'missed clock-out two days ago is flagged');
select pg_temp.ok(pg_temp.punch('bea', 'in')->>'status' = 'in', 'a missed clock-out doesn''t stop clocking in today');
select pg_temp.ok(pg_temp.punch('bea', 'out')->>'status' = 'out', 'and out');
reset role;

-- ═════════════ the office: corrections ═════════════
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
update public.time_entries set clock_out = clock_in + interval '8 hours', out_reason = 'out'
 where employee_id = (select v::uuid from t where k = 'bea') and clock_out is null;
select pg_temp.ok((select edited_by = '00000000-0000-0000-0000-00000000000d' and original_in is not null and original_out is null and source = 'clock'
                     from public.time_entries where employee_id = (select v::uuid from t where k = 'bea') and clock_in < now() - interval '1 day'),
                  'fixing a missed clock-out keeps what the clock had (still open) and who fixed it');
update public.time_entries set source = 'office', original_in = null, clock_out = clock_out + interval '1 minute'
 where employee_id = (select v::uuid from t where k = 'bea') and clock_in < now() - interval '1 day';
select pg_temp.ok((select source = 'clock' and original_in is not null and original_out is null from public.time_entries
                    where employee_id = (select v::uuid from t where k = 'bea') and clock_in < now() - interval '1 day'), 'source and originals can''t be rewritten');
insert into public.time_entries (employee_id, clock_in, clock_out, out_reason, source, note)
  select v::uuid, '2026-09-28 08:00-04', '2026-09-28 17:00-04', 'out', 'clock', 'forgot to clock' from t where k = 'ana';
select pg_temp.ok((select source = 'office' and created_by = '00000000-0000-0000-0000-00000000000d' from public.time_entries where note = 'forgot to clock'),
                  'time added by the office is marked as such');
do 'begin insert into public.time_entries (employee_id, clock_in, clock_out)
  select v::uuid, ''2026-09-28 16:00-04'', ''2026-09-28 18:00-04'' from t where k = ''ana''; raise exception ''FAIL: overlap'';
exception when check_violation then null; end';
do 'begin insert into public.time_entries (employee_id, clock_in) select v::uuid, now() + interval ''1 hour'' from t where k = ''ana''; raise exception ''FAIL: future'';
exception when check_violation then null; end';
do 'begin insert into public.time_entries (employee_id, clock_in, clock_out) select v::uuid, ''2026-09-28 08:00-04'', ''2026-09-29 08:00-04'' from t where k = ''bea'';
  raise exception ''FAIL: 24-hour stretch''; exception when check_violation then null; end';
delete from public.time_entries where note = 'forgot to clock';

-- ═════════════ hours, overtime ═════════════
-- Ana, week of Mon Sep 28: five 9-hour days = 45 hours → 40 regular, 5 overtime (all on Friday).
insert into public.time_entries (employee_id, clock_in, clock_out, out_reason)
  select (select v::uuid from t where k = 'ana'), (d::date + time '08:00') at time zone 'America/New_York', (d::date + time '17:00') at time zone 'America/New_York', 'out'
    from generate_series('2026-09-28'::date, '2026-10-02', '1 day') d;
-- the next week: 8:00–12:00 and 12:30–4:30 on Monday (8 hours, lunch not paid)
insert into public.time_entries (employee_id, clock_in, clock_out, out_reason)
  select (select v::uuid from t where k = 'ana'), x.i::timestamptz, x.o::timestamptz, x.r
    from (values ('2026-10-05 08:00-04', '2026-10-05 12:00-04', 'lunch'), ('2026-10-05 12:30-04', '2026-10-05 16:30-04', 'out')) as x(i, o, r);
select pg_temp.ok((select to_char(clock_in at time zone 'America/New_York', 'HH24:MI') = '08:00' and work_date = '2026-09-28' from public.time_entries
                    where employee_id = (select v::uuid from t where k = 'ana') order by clock_in limit 1), 'times are the school''s time');
select pg_temp.ok((select sum(regular) = 2400 and sum(overtime) = 300 from public.payroll_hours('2026-09-21', '2026-10-04') where employee_id = (select v::uuid from t where k = 'ana')),
                  '45 hours in a week: 40 regular + 5 overtime');
select pg_temp.ok((select regular = 240 and overtime = 300 from public.payroll_hours('2026-09-21', '2026-10-04')
                    where employee_id = (select v::uuid from t where k = 'ana') and work_date = '2026-10-02'), 'overtime falls on the day hour 40 is passed');
select pg_temp.ok((select minutes = 480 and overtime = 0 from public.payroll_hours('2026-10-05', '2026-10-18')
                    where employee_id = (select v::uuid from t where k = 'ana') and work_date = '2026-10-05'), 'a new workweek starts over; lunch is unpaid');
-- Twice-a-month pay: the period Oct 1–15 starts mid-week, so Mon–Wed before it count toward that week's 40.
update public.settings set payroll_frequency = 'semimonthly';
select pg_temp.ok((select sum(regular) = 13 * 60 and sum(overtime) = 5 * 60 from public.payroll_hours('2026-10-01', '2026-10-15')
                    where employee_id = (select v::uuid from t where k = 'ana') and work_date < '2026-10-03'),
                  'twice a month: Sep 28–30 (27 h) count toward the week, so Oct 1–2 are 13 regular + 5 overtime');
update public.settings set payroll_frequency = 'biweekly';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- staff without payroll see no hours
select pg_temp.ok((select count(*) = 0 from public.payroll_hours('2026-09-21', '2026-10-18')), 'no payroll access, no hours');

-- ═════════════ entered in Patriot: lock the period ═════════════
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do 'begin perform public.payroll_close_period(''2026-09-21'', ''2026-10-04''); raise exception ''FAIL: non-payroll closed a period'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
do 'begin perform public.payroll_close_period(''2026-10-05'', (now() at time zone ''America/New_York'')::date + 3); raise exception ''FAIL: closed a period not over'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
insert into public.time_entries (employee_id, clock_in) values ((select v::uuid from t where k = 'bea'), '2026-10-01 09:00-04');
do 'begin perform public.payroll_close_period(''2026-09-21'', ''2026-10-04''); raise exception ''FAIL: closed with a missing clock-out'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
delete from public.time_entries where employee_id = (select v::uuid from t where k = 'bea') and clock_in = '2026-10-01 09:00-04';
select pg_temp.ok((select public.payroll_close_period('2026-09-21', '2026-10-04')
                   = jsonb_build_array(jsonb_build_object('employee_id', v::uuid, 'name', 'Ana Clock', 'rate', 16.50, 'regular', 40.00, 'overtime', 5.00))
                     from t where k = 'ana'), 'closing keeps the hours sent to Patriot');
do 'begin perform public.payroll_close_period(''2026-09-28'', ''2026-10-04''); raise exception ''FAIL: closed twice'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
do 'begin update public.time_entries set clock_out = clock_out + interval ''1 hour'' where work_date = ''2026-10-02''; raise exception ''FAIL: edited a closed period'';
exception when check_violation then null; end';
do 'begin delete from public.time_entries where work_date = ''2026-10-02''; raise exception ''FAIL: deleted from a closed period'';
exception when check_violation then null; end';
do 'begin insert into public.time_entries (employee_id, clock_in, clock_out) select v::uuid, ''2026-10-03 08:00-04'', ''2026-10-03 09:00-04'' from t where k = ''bea'';
  raise exception ''FAIL: added to a closed period''; exception when check_violation then null; end';
do 'begin update public.time_entries set clock_in = ''2026-10-02 07:00-04'' where work_date = ''2026-10-05'' and out_reason = ''lunch'';
  raise exception ''FAIL: moved time into a closed period''; exception when check_violation then null; end';
do 'begin insert into public.payroll_periods (period_start, period_end) values (''2026-08-01'', ''2026-08-14''); raise exception ''FAIL: inserted a period'';
exception when insufficient_privilege then null; end';
-- reopen
delete from public.payroll_periods where period_start = '2026-09-21';
update public.time_entries set note = 'reopened' where work_date = '2026-10-02';
select pg_temp.ok((select note = 'reopened' from public.time_entries where work_date = '2026-10-02'), 'reopened period can be changed again');
do 'begin delete from public.employees where first_name = ''Ana''; raise exception ''FAIL: deleted someone with time'';
exception when foreign_key_violation then null; end';
reset role;
select pg_temp.as_user(null);
update public.profiles set payroll = false where email = 'books@creativaacademy.com';

\echo ALL PAYROLL TESTS PASSED
