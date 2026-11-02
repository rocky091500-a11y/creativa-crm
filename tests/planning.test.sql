-- Migration 032: school planning (drafts, who it's for, prep, decisions, the planning-file import, tours off closed days).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/032_school_planning.sql
\ir ../supabase/migrations/032_school_planning.sql
\ir ../supabase/migrations/033_planning_import_memory.sql
\ir ../supabase/migrations/033_planning_import_memory.sql
select pg_temp.as_user(null);
delete from public.school_events;
insert into public.school_events (kind, title, starts_on, ends_on) values ('theme', 'Fall', '2026-11-09', '2026-11-13');
insert into public.school_events (kind, title, starts_on) values ('event', 'Pizza Fundraiser', '2026-11-17');
select pg_temp.ok((select bool_and(status = 'approved') from public.school_events), 'what''s on the calendar already stays approved');

create temp table plan as select '{"floors": {"VPK": 2, "Late 3s": 2, "Early 2s": 1},
  "items": [
    {"key": "t1", "kind": "theme", "title": "Harvest", "starts_on": "2026-11-09", "ends_on": "2026-11-13"},
    {"key": "pics2", "title": "Pictures", "starts_on": "2026-11-06", "floors": [2], "internal_note": "Photographer arrives 8:30",
     "prep": [{"assignee": "Ms. A", "class": "VPK", "task": "Backdrop", "supplies": "Paper", "due_on": "2026-11-05"},
              {"assignee": "Ms. B", "task": "Combs"}]},
    {"key": "fund", "title": "Pizza fundraiser", "starts_on": "2026-11-10", "date_options": ["2026-11-17", "2026-11-10"],
     "replaces": [{"title": "pizza fundraiser", "on": "2026-11-17"}]},
    {"key": "off", "kind": "closure", "title": "No school for VPK", "starts_on": "2026-11-23", "ends_on": "2026-11-27",
     "classes": ["VPK"], "question": "Is Kindergarten off too?"}]}'::jsonb as j;
grant select on plan to authenticated;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');   -- an admin (the office)
select pg_temp.ok((select public.school_events_import('binder', j) = '{"added": 3, "skipped": 1}' from plan), 'imported as drafts; a week with a theme keeps it');
select pg_temp.ok((select count(*) = 3 from public.school_events where status = 'draft' and source = 'binder'), 'three drafts');
select pg_temp.ok((select floor = 2 from public.classrooms where name = 'VPK'), 'floors set');
select pg_temp.ok((select classroom_ids @> array[(select id from public.classrooms where name = 'VPK')] and not classroom_ids @> array[(select id from public.classrooms where name = 'Early 2s')]
  from public.school_events where source_key = 'pics2'), '2nd floor = its classes');
select pg_temp.ok((select count(*) = 2 from public.school_event_prep), 'prep added with the event');
select pg_temp.ok((select date_options = '{2026-11-10,2026-11-17}' and cardinality(replaces) = 1 from public.school_events where source_key = 'fund'), 'two possible dates; replaces the one on the calendar');
update public.school_events set title = 'Pictures (both floors)' where source_key = 'pics2';
select pg_temp.ok((select public.school_events_import('binder', j) = '{"added": 0, "skipped": 4}' from plan), 'importing again adds nothing');
select pg_temp.ok((select count(*) = 2 from public.school_event_prep) and (select title = 'Pictures (both floors)' from public.school_events where source_key = 'pics2'),
  '... no prep twice, and the staff edit stays');
select pg_temp.ok((select count(*) = 1 from public.school_events where title = 'Pizza Fundraiser' and status = 'approved'), 'nothing already on the calendar changes');
delete from public.school_events where source_key = 'pics2';   -- "Keep the old one": the draft is deleted
select pg_temp.ok((select public.school_events_import('binder', j) = '{"added": 0, "skipped": 4}' from plan), 'a deleted draft doesn''t come back');
reset role;
insert into public.school_events (kind, title, starts_on, status, source, source_key)
  select 'event', 'Pictures', '2026-11-06', 'draft', 'binder', 'pics2';   -- put back for the rest of the test
set role authenticated;
insert into public.school_event_prep (event_id, assignee, classroom_id, task, supplies, due_on)
  select id, 'Ms. A', (select id from public.classrooms where name = 'VPK'), 'Backdrop', 'Paper', '2026-11-05' from public.school_events where source_key = 'pics2';
insert into public.school_event_prep (event_id, assignee, task) select id, 'Ms. B', 'Combs' from public.school_events where source_key = 'pics2';

-- Decisions before approval.
do 'begin perform public.school_event_approve((select id from public.school_events where source_key = ''fund'')); raise exception ''FAIL: approved undecided'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
do 'begin perform public.school_event_decide((select id from public.school_events where source_key = ''fund''), ''2026-11-12'', null); raise exception ''FAIL: odd date'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
select pg_temp.ok((select (public.school_event_decide(id, '2026-11-17', null)).starts_on = '2026-11-17' from public.school_events where source_key = 'fund'), 'date picked from the options');
select pg_temp.ok((select (public.school_event_approve(id)).status = 'approved' from public.school_events where source_key = 'fund'), 'approved');
select pg_temp.ok((select count(*) = 0 from public.school_events where title = 'Pizza Fundraiser'), '... and the entry it replaces is gone');
do 'begin update public.school_events set status = ''approved'' where source_key = ''off''; raise exception ''FAIL: approved with a question'';
  exception when check_violation then null; end';
select pg_temp.ok((select (public.school_event_decide(id, null, 'VPK only')).question is null from public.school_events where source_key = 'off'), 'question answered');
select pg_temp.ok((select internal_note like '%Decided: VPK only%' and status = 'draft' from public.school_events where source_key = 'off'), '... noted, still a draft');

-- Teachers see the prep and tick theirs done; they can't plan.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- a teacher
select pg_temp.ok((select count(*) = 2 from public.school_event_prep), 'teachers see the prep');
select pg_temp.ok((select (public.prep_done(id, true)).done_at is not null from public.school_event_prep where task = 'Backdrop'), 'and tick it done');
do 'begin insert into public.school_event_prep (event_id, assignee, task) select id, ''x'', ''y'' from public.school_events limit 1; raise exception ''FAIL: teacher assigned prep'';
  exception when insufficient_privilege then null; end';
do 'begin perform public.school_event_approve((select id from public.school_events where source_key = ''pics2'')); raise exception ''FAIL: teacher approved'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
do 'begin perform public.school_events_import(''x'', ''{}''); raise exception ''FAIL: teacher imported'';
  exception when raise_exception then if sqlerrm like ''FAIL%'' then raise; end if; end';
select pg_temp.ok(true, 'teachers can''t assign prep, approve or import');
reset role;

-- Tours: not on a day the whole school is closed; one booked before the closure stays.
select pg_temp.as_user(null);
insert into public.inquiries (parent_name, phone, tour_at) values ('Tour Mom', '305 555 0111', '2026-11-13 15:00+00');
insert into public.school_closures (name, starts_on, ends_on) values ('Test Closure Day', '2026-11-13', '2026-11-13');
update public.inquiries set next_follow_up = '2026-11-12' where parent_name = 'Tour Mom';
select pg_temp.ok(true, 'a tour already on the closed day stays (to call the family)');
do 'begin update public.inquiries set tour_at = ''2026-11-13 16:00+00'' where parent_name = ''Tour Mom''; raise exception ''FAIL: tour on a closed day'';
  exception when check_violation then null; end';
do 'begin insert into public.inquiries (parent_name, phone, tour_at) values (''New Mom'', ''305 555 0112'', ''2026-11-11 15:00+00''); raise exception ''FAIL: new tour on Veterans Day'';
  exception when check_violation then null; end';
select pg_temp.ok(true, 'no new tour on a closed day (Veterans Day too)');
update public.inquiries set tour_at = '2026-11-16 15:00+00' where parent_name = 'Tour Mom';
select pg_temp.ok((select tour_at = '2026-11-16 15:00+00' from public.inquiries where parent_name = 'Tour Mom'), 'moved to an open day');
delete from public.inquiries where parent_name = 'Tour Mom';
delete from public.school_closures where name = 'Test Closure Day';
\echo ALL SCHOOL PLANNING TESTS PASSED
