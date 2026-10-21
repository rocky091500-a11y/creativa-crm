-- Migration 027: a paused child isn't billed until they're back. Runs after the other tests (projection.test.sql reloads 019).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/027_pause.sql
\ir ../supabase/migrations/027_pause.sql

select pg_temp.as_user(null);
create temp table q as select billing_anchor + billing_period_days * 40 as d from public.settings where id = 1;
grant select on q to authenticated;
-- Away the whole period; back in its second week; back in its first week; paused, but that's over; never paused.
insert into public.students (name, status, start_date, paused_until, pause_note)
  select x.n, 'enrolled', q.d - 100, q.d + x.k, 'Out sick' from q,
    (values ('Pia Away', 14), ('Ben Backweek2', 7), ('Ada Backweek1', 3), ('Ola Overalready', -30)) as x(n, k);
insert into public.students (name, status, start_date) select 'Nate Neverpaused', 'enrolled', q.d - 100 from q;
-- With a start to the pause: starts next period; starts mid-period; back on a Saturday / Sunday (the Monday after counts).
insert into public.students (name, status, start_date, paused_from, paused_until)
  select x.n, 'enrolled', q.d - 100, q.d + x.f, q.d + x.k from q,
    (values ('Fay Futurepause', 14, 40), ('Mo Midperiod', 3, 40), ('Sam Saturday', -20, 12), ('Sue Sunday', -20, 6)) as x(n, f, k);
insert into public.student_finance (student_id, tuition_amount, tuition_frequency)
  select id, 560, 'biweekly' from public.students
   where name in ('Pia Away', 'Ben Backweek2', 'Ada Backweek1', 'Ola Overalready', 'Nate Neverpaused', 'Fay Futurepause', 'Mo Midperiod', 'Sam Saturday', 'Sue Sunday');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok(public.create_period_invoices((select d from q)) >= 4, 'billed the period');
create temp table b as select s.name, i.amount, i.due_date - (select d from q) as due, i.note
  from public.invoices i join public.students s on s.id = i.student_id
 where i.period_start = (select d from q);
select pg_temp.ok(not exists (select 1 from b where name = 'Pia Away'), 'away the whole period: no bill');
select pg_temp.ok((select amount = 280 and due = 7 and note like 'Back %: one week' from b where name = 'Ben Backweek2'),
                  'back in the second week: one week, due that Monday');
select pg_temp.ok((select amount = 560 and due = 0 and note is null from b where name = 'Ada Backweek1'), 'back in the first week: the whole period');
select pg_temp.ok((select count(*) = 2 from b where name in ('Ola Overalready', 'Nate Neverpaused') and amount = 560 and note is null),
                  'a pause that''s over, or none: billed as usual');
select pg_temp.ok((select amount = 560 and note is null from b where name = 'Fay Futurepause'), 'a pause that starts next period: this one billed as usual');
select pg_temp.ok(not exists (select 1 from b where name = 'Mo Midperiod'), 'a pause that starts during the period: no bill for it');
select pg_temp.ok(not exists (select 1 from b where name = 'Sam Saturday'), 'back on the second Saturday counts as the Monday after: no bill');
select pg_temp.ok((select amount = 280 and due = 7 and note like 'Back %: one week' from b where name = 'Sue Sunday'),
                  'back on the first Sunday counts as the Monday after: one week');
select pg_temp.ok(public.create_period_invoices((select d from q) + 14) >= 1, 'billed the next period');
select pg_temp.ok(exists (select 1 from public.invoices i join public.students s on s.id = i.student_id
                           where s.name = 'Pia Away' and i.period_start = (select d + 14 from q) and i.amount = 560 and i.note is null),
                  'back on the first day of the next period: billed that period');
reset role;
\echo ALL PAUSE TESTS PASSED
