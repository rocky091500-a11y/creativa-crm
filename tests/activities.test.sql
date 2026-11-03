-- Migration 034: activity rosters, permission slips, shared activity fees, rotation schedules, reminder targets.
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/034_activity_rosters.sql
\ir ../supabase/migrations/034_activity_rosters.sql
select pg_temp.as_user(null);
update public.profiles set active = true, role = 'staff', finance = 'none', payroll = false where id = '00000000-0000-0000-0000-00000000000b';   -- a teacher
update public.profiles set active = true, finance = 'edit' where id = '00000000-0000-0000-0000-00000000000d';                                 -- the office
-- Sample children in two sample classes: one starting after the activity, one who left before it.
insert into public.classrooms (name, sort) values ('Sample A', 901), ('Sample B', 902);
insert into public.students (name, status, classroom_id, start_date) values
  ('Ava Sample', 'enrolled', (select id from public.classrooms where name = 'Sample A'), '2026-08-10'),
  ('Ben Sample', 'enrolled', (select id from public.classrooms where name = 'Sample A'), '2026-08-10'),
  ('Cleo Sample', 'enrolled', (select id from public.classrooms where name = 'Sample B'), '2026-08-10'),
  ('Dan Later', 'enrolled', (select id from public.classrooms where name = 'Sample A'), '2026-12-01');
insert into public.students (name, status, classroom_id, start_date, withdrawn_on) values
  ('Eve Gone', 'withdrawn', (select id from public.classrooms where name = 'Sample A'), '2026-08-10', '2026-10-30');
insert into public.school_events (kind, title, starts_on, classroom_ids, needs_permission) values
  ('event', 'Little Farm', '2026-11-18', array[(select id from public.classrooms where name = 'Sample A')], true),
  ('event', 'Polar Express', '2026-12-16', array[(select id from public.classrooms where name = 'Sample A'), (select id from public.classrooms where name = 'Sample B')], false);
create temp table k as select (select id from public.school_events where title = 'Little Farm') as farm, (select id from public.school_events where title = 'Polar Express') as polar,
  (select id from public.students where name = 'Ava Sample') as ava, (select id from public.students where name = 'Ben Sample') as ben,
  (select id from public.students where name = 'Cleo Sample') as cleo, (select id from public.students where name = 'Dan Later') as dan;
grant select on k to authenticated;

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok((select public.roster_build(farm) = 2 from k), 'roster from the class, as of the day: started, not gone');
select pg_temp.ok((select bool_and(permission = 'pending') from public.activity_roster where event_id = (select farm from k)), 'slips pending when the activity needs them');
select pg_temp.ok((select public.roster_build(polar) = 4 from k), 'two classes; a child who starts by then counts');
update public.activity_roster set participation = 'going' where student_id = (select ava from k) and event_id = (select farm from k);
update public.activity_roster set removed = true where student_id = (select ben from k) and event_id = (select farm from k);
insert into public.activity_roster (event_id, student_id, by_hand) select farm, cleo, true from k;
select pg_temp.ok((select public.roster_build(farm) = 0 from k), 'building again adds nobody');
select pg_temp.ok((select participation = 'going' from public.activity_roster where student_id = (select ava from k) and event_id = (select farm from k))
  and (select removed from public.activity_roster where student_id = (select ben from k) and event_id = (select farm from k))
  and exists (select 1 from public.activity_roster where student_id = (select cleo from k) and event_id = (select farm from k)), '... and keeps the office''s changes');
update public.activity_roster set permission = 'received' where student_id = (select ava from k) and event_id = (select farm from k);
select pg_temp.ok((select permission_on = current_date from public.activity_roster where student_id = (select ava from k) and event_id = (select farm from k)), 'slip received: dated');
select pg_temp.ok((select count(*) >= 3 from public.change_log where table_name = 'activity_roster' and student_id is not null), 'roster changes on the Changes page');
select pg_temp.ok((select diff ? 'participation' from public.change_log where table_name = 'activity_roster' and action = 'update' order by at limit 1), '... with the old and new value');

-- One fee for both activities, charged once, paid once.
insert into public.activity_collections (name, amount, due_on) values ('Farm & Polar Express', 40, '2026-11-10');
update public.school_events set collection_id = (select id from public.activity_collections) where title in ('Little Farm', 'Polar Express');
create temp table col as select id from public.activity_collections;
select pg_temp.ok((select count(*) = 2 from k, public.collection_charge((select id from public.activity_collections), array[ava, ben])), 'charged two children');
select pg_temp.ok((select count(*) = 2 from k, public.collection_charge((select id from public.activity_collections), array[ava, ben])), 'charging again: still the same two charges');
select pg_temp.ok((select count(*) = 2 from public.invoices where collection_id is not null), 'no second charge');
do 'begin insert into public.invoices (student_id, kind, description, invoice_date, due_date, amount, collection_id)
  select (select id from public.students where name = ''Ava Sample''), ''fee'', ''x'', current_date, current_date, 40, id from public.activity_collections;
  raise exception ''FAIL: second charge''; exception when unique_violation then null; end';
insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, method, payer, request_id)
  select student_id, id, '2026-11-03', '2026-11-01', 40, 'cash', 'parent', '11111111-2222-3333-4444-555555555555' from public.invoices
   where collection_id is not null and student_id = (select ava from k);
do 'begin insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, method, payer, request_id)
  select student_id, id, ''2026-11-03'', ''2026-11-01'', 40, ''cash'', ''parent'', ''11111111-2222-3333-4444-555555555555'' from public.invoices
   where collection_id is not null and student_id = (select id from public.students where name = ''Ava Sample'');
  raise exception ''FAIL: payment twice''; exception when unique_violation then null; end';
select pg_temp.ok(true, 'the same payment saved twice is recorded once');
insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, method, payer)
  select student_id, id, '2026-11-03', '2026-11-01', 15, 'zelle', 'parent' from public.invoices where collection_id is not null and student_id = (select ben from k);
update public.activity_collections set amount = 45, name = 'Farm & Polar Express (bus)';
select pg_temp.ok((select amount = 45 and description like '%(bus)' from public.invoices where collection_id is not null and student_id = (select ava from k)) is false
  and (select amount = 40 and description like '%(bus)' from public.invoices where collection_id is not null and student_id = (select ava from k)), 'paid charges keep their amount, take the new name');
update public.activity_collections set amount = 40, name = 'Farm & Polar Express';

-- Reminders: who still owes / still needs a slip, right now.
update public.activity_roster set participation = 'going' where student_id = (select cleo from k);
select pg_temp.ok((select array_agg(student_id order by student_id) = (select array_agg(x order by x) from (select ben x from k union select cleo from k) y)
  from public.activity_reminder_targets('activity-unpaid', (select id from col))), 'unpaid: the part payment and the going child not charged yet; the paid one isn''t');
update public.activity_roster set participation = 'not_going' where student_id = (select cleo from k);
select pg_temp.ok((select count(*) = 1 from public.activity_reminder_targets('activity-unpaid', (select id from col))), 'not going on all of them: no reminder');
select pg_temp.ok((select count(*) = 0 from public.activity_reminder_targets('activity-slip', (select farm from k)) t where t.student_id = (select ava from k)), 'slip received: no slip reminder');

-- Rotation schedule: saved whole, in order.
select pg_temp.ok((select count(*) = 3 from k, public.activity_slots_save(farm, '[{"label":"VPK","teachers":"Ms. A","starts_at":"09:00","ends_at":"09:30"},
  {"kind":"transition","starts_at":"09:30","ends_at":"09:35"},{"label":"Late 3s","teachers":"Ms. B, Ms. C","starts_at":"09:35","ends_at":"10:05"}]')), 'schedule saved');
select pg_temp.ok((select string_agg(coalesce(label, kind), ',' order by sort) = 'VPK,transition,Late 3s' from public.activity_slots), 'in order');

-- Teachers: see the roster and the schedule; can't change them, see money, charge, or text.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok((select count(*) >= 3 from public.activity_roster) and (select count(*) = 3 from public.activity_slots), 'teachers see rosters and schedules');
update public.activity_roster set participation = 'going';
select pg_temp.ok((select count(*) = 0 from public.activity_roster where participation = 'going' and student_id = (select cleo from k)), 'teachers can''t change a roster');
select pg_temp.ok((select count(*) = 0 from public.invoices) and (select count(*) = 0 from public.payments), 'teachers see no charges or payments');
do 'begin perform public.collection_charge((select id from public.activity_collections), array[gen_random_uuid()]); raise exception ''FAIL: teacher charged'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
do 'begin perform * from public.activity_reminder_targets(''activity-unpaid'', (select id from public.activity_collections)); raise exception ''FAIL: teacher saw who owes'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
do 'begin perform public.roster_build((select id from public.school_events where title = ''Little Farm'')); raise exception ''FAIL: teacher built a roster'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
do 'begin perform public.activity_slots_save((select id from public.school_events where title = ''Little Farm''), ''[]''); raise exception ''FAIL: teacher changed a schedule'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
do 'begin insert into public.activity_collections (name, amount) values (''x'', 1); raise exception ''FAIL: teacher made a fee'';
  exception when insufficient_privilege then null; end';
select pg_temp.ok(true, 'teachers can''t charge, see who owes, build rosters, change schedules or set fees');
reset role;
set role anon;
do 'begin perform 1 from public.activity_roster; raise exception ''FAIL: anon read''; exception when insufficient_privilege then null; end';
reset role;
select pg_temp.as_user(null);
delete from public.payments where invoice_id in (select id from public.invoices where collection_id is not null);
delete from public.invoices where collection_id is not null;
delete from public.school_events where title in ('Little Farm', 'Polar Express');
delete from public.activity_collections;
delete from public.students where name in ('Ava Sample', 'Ben Sample', 'Cleo Sample', 'Dan Later', 'Eve Gone');
delete from public.classrooms where name in ('Sample A', 'Sample B');
\echo ALL ACTIVITY ROSTER TESTS PASSED
