-- Creativa CRM — who changed what: a log of every change staff make, so the owner and the administrator can see
-- each other's work (Changes page, the count on its tab, and each child's page).
-- Run once in the Supabase SQL editor, after 001–011 (in that order). Safe to run again.
--
--   change_log            one row per insert, update or delete made by a signed-in person on the enrollment,
--                         tuition, payroll and settings tables: who, when, the row, and for an update which fields
--                         changed (old → new). Written only by the log_change() trigger; nobody can edit or delete it.
--                         Changes made by imports, the time clock and the system (no signed-in person) aren't logged.
--                         Who sees what: enrollment changes all staff; tuition changes finance access; payroll
--                         changes payroll access; settings and access changes admins.
--   profiles.changes_seen_at   when this person last opened the Changes page (mark_changes_seen()).
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create table if not exists public.change_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor        uuid references public.profiles(id) on delete set null,
  area         text not null check (area in ('enrollment','finance','payroll','settings')),
  table_name   text not null,
  row_id       text,
  action       text not null check (action in ('insert','update','delete')),
  student_id   uuid,          -- the child it's about, if any (no foreign key: the history outlives a deleted child)
  employee_id  uuid,          -- the staff member it's about, if any
  data         jsonb not null default '{}'::jsonb,   -- the row after the change (before it, for a delete)
  diff         jsonb          -- for an update: { field: [old, new] } for each field that changed
);
create index if not exists change_log_at_idx on public.change_log (at desc);
create index if not exists change_log_student_idx on public.change_log (student_id, at desc);

alter table public.profiles add column if not exists changes_seen_at timestamptz;

create or replace function public.log_change()
returns trigger language plpgsql security definer set search_path = public as '
declare
  who uuid := auth.uid();
  o jsonb;
  n jsonb;
  r jsonb;
  d jsonb := ''{}''::jsonb;
  k text;
begin
  if who is null then return null; end if;
  if tg_op <> ''INSERT'' then o := to_jsonb(old); end if;
  if tg_op <> ''DELETE'' then n := to_jsonb(new); end if;
  if tg_op = ''UPDATE'' then
    for k in select jsonb_object_keys(n) loop
      if k not in (''updated_at'', ''edited_at'', ''edited_by'', ''created_at'', ''last_seen_at'', ''changes_seen_at'', ''pin_set_at'',
                   ''telegram_last_at'', ''telegram_last_result'', ''telegram_last_request'')
         and (o -> k) is distinct from (n -> k) then
        d := d || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k));
      end if;
    end loop;
    if d = ''{}''::jsonb then return null; end if;
  end if;
  r := coalesce(n, o);
  if tg_table_name = ''settings'' then r := ''{}''::jsonb; end if;   -- long email wording; the diff says what changed
  insert into public.change_log (actor, area, table_name, row_id, action, student_id, employee_id, data, diff)
  values (who, tg_argv[0], tg_table_name, coalesce(r ->> ''id'', r ->> ''student_id'', coalesce(n, o) ->> ''id''), lower(tg_op),
          case when tg_table_name = ''students'' then (coalesce(n, o) ->> ''id'')::uuid else (coalesce(n, o) ->> ''student_id'')::uuid end,
          case when tg_table_name = ''employees'' then (coalesce(n, o) ->> ''id'')::uuid else (coalesce(n, o) ->> ''employee_id'')::uuid end,
          r, case when tg_op = ''UPDATE'' then d end);
  return null;
end';

do '
declare
  t record;
begin
  for t in select * from (values (''students'', ''enrollment''), (''student_contacts'', ''enrollment''), (''classrooms'', ''enrollment''),
                                 (''student_finance'', ''finance''), (''payments'', ''finance''), (''invoices'', ''finance''),
                                 (''billing_history'', ''finance''),
                                 (''employees'', ''payroll''), (''time_entries'', ''payroll''), (''payroll_periods'', ''payroll''),
                                 (''settings'', ''settings''), (''profiles'', ''settings'')) as x(tbl, area) loop
    if to_regclass(''public.'' || t.tbl) is not null then
      execute format(''drop trigger if exists log_change on public.%I'', t.tbl);
      execute format(''create trigger log_change after insert or update or delete on public.%I for each row execute function public.log_change(%L)'', t.tbl, t.area);
    end if;
  end loop;
end';

-- Opening the Changes page: everything until now counts as seen.
create or replace function public.mark_changes_seen()
returns timestamptz language sql security definer set search_path = public as '
  update public.profiles set changes_seen_at = now() where id = auth.uid() and active returning changes_seen_at;
';

alter table public.change_log enable row level security;
revoke all on public.change_log from anon;
revoke insert, update, delete on public.change_log from authenticated;
drop policy if exists change_log_select on public.change_log;
create policy change_log_select on public.change_log for select to authenticated using (
  public.is_admin()
  or (area = 'enrollment' and public.is_staff())
  or (area = 'finance' and public.can_view_finance())
  or (area = 'payroll' and public.can_payroll()));

revoke execute on function public.log_change() from public, anon, authenticated;
revoke execute on function public.mark_changes_seen() from public, anon;
grant  execute on function public.mark_changes_seen() to authenticated;
