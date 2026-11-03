-- Creativa CRM — activity rosters, permission slips, activity fees (one fee can cover several activities), class rotation
-- schedules, and reminders that know who still owes. Calendar → an activity → Roster / Fee / Schedule.
-- Run once in the Supabase SQL editor, after 033_planning_import_memory.sql. Safe to run again.
--
--   activity_roster        who's on an activity: built from its classes (enrollment and class as of the activity's day),
--                          then the office adds or takes off children; their changes stay when the roster is built again.
--                          Each child: going? (undecided / going / not going), permission slip (not required / pending /
--                          received / declined) and the day the slip came in. All staff see it (teachers print it);
--                          the office (admins, staff who record payments or do payroll) changes it.
--   school_events          gains needs_permission (new roster rows start Pending instead of Not required) and
--                          collection_id (the fee that covers it).
--   activity_collections   a fee for one or more activities ("$40: Little Farm, Polar Express, Santa Claus"): name,
--                          amount, due date. Staff who record payments set it up.
--   invoices.collection_id one charge per child per fee, ever (a unique index): billing it again, a double-click, a retry
--                          or two people at once can't charge twice. Paid through Record payment like any bill (part
--                          payments, credits, receipts). Changing the fee's name or amount updates charges nothing was
--                          paid on (and renames the others).
--   payments.request_id    each Record payment window has its own id: saving it twice, or a retry, records it once.
--   activity_slots         a class rotation (the Little Farm schedule): class, teacher(s), start and end, in order, with
--                          transition gaps.
--   messages.purpose/ref_id  a reminder text says what it was for ('activity-unpaid' with the fee, 'activity-slip' with
--                          the activity), so the roster shows when reminders went out and how they did.
--   activity_reminder_targets  who a reminder is for right now (checked again just before sending).
--   collection_charge      charges children for a fee (only those not charged yet).
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

-- ───────── fees ─────────
create table if not exists public.activity_collections (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  amount      numeric(10,2) not null check (amount > 0 and amount < 10000),
  due_on      date,
  note        text check (length(note) <= 300)
);
alter table public.activity_collections enable row level security;
revoke all on public.activity_collections from anon;
drop policy if exists activity_collections_select on public.activity_collections;
drop policy if exists activity_collections_write on public.activity_collections;
create policy activity_collections_select on public.activity_collections for select to authenticated using (public.is_staff());
create policy activity_collections_write on public.activity_collections for all to authenticated
  using (public.can_edit_finance()) with check (public.can_edit_finance());

alter table public.school_events
  add column if not exists needs_permission boolean not null default false,
  add column if not exists collection_id uuid references public.activity_collections(id) on delete set null;

alter table public.invoices add column if not exists collection_id uuid references public.activity_collections(id) on delete restrict;
create unique index if not exists invoices_one_per_collection on public.invoices (collection_id, student_id)
  where collection_id is not null and not void;
alter table public.payments add column if not exists request_id uuid;
create unique index if not exists payments_request_id on public.payments (request_id) where request_id is not null;

-- A fee's name and amount follow onto its charges: the name always, the amount where nothing was paid yet.
create or replace function public.collection_follow()
returns trigger language plpgsql security definer set search_path = public as '
begin
  update public.invoices i set description = left(new.name, 120),
         amount = case when exists (select 1 from public.payments p where p.invoice_id = i.id) then i.amount else new.amount end,
         due_date = case when exists (select 1 from public.payments p where p.invoice_id = i.id) then i.due_date
                         else coalesce(new.due_on, i.due_date) end
   where i.collection_id = new.id and not i.void;
  return new;
end';
drop trigger if exists collection_follow on public.activity_collections;
create trigger collection_follow after update of name, amount, due_on on public.activity_collections
  for each row execute function public.collection_follow();

-- ───────── rosters ─────────
create table if not exists public.activity_roster (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  event_id       uuid not null references public.school_events(id) on delete cascade,
  student_id     uuid not null references public.students(id) on delete cascade,
  participation  text not null default 'undecided' check (participation in ('undecided', 'going', 'not_going')),
  permission     text not null default 'not_required' check (permission in ('not_required', 'pending', 'received', 'declined')),
  permission_on  date,
  removed        boolean not null default false,
  by_hand        boolean not null default false,
  note           text check (length(note) <= 200),
  updated_at     timestamptz,
  edited_by      uuid references public.profiles(id) on delete set null,
  unique (event_id, student_id),
  check (permission_on is null or permission = 'received')
);
create index if not exists activity_roster_student_idx on public.activity_roster (student_id);
alter table public.activity_roster enable row level security;
revoke all on public.activity_roster from anon;
drop policy if exists activity_roster_select on public.activity_roster;
drop policy if exists activity_roster_write on public.activity_roster;
create policy activity_roster_select on public.activity_roster for select to authenticated using (public.is_staff());
create policy activity_roster_write on public.activity_roster for all to authenticated
  using (public.can_office()) with check (public.can_office());

create or replace function public.activity_roster_stamp()
returns trigger language plpgsql set search_path = public as '
begin
  new.updated_at := now();
  new.edited_by := coalesce(auth.uid(), new.edited_by);
  if new.permission <> ''received'' then new.permission_on := null;
  elsif new.permission_on is null then new.permission_on := current_date; end if;
  return new;
end';
drop trigger if exists activity_roster_stamp on public.activity_roster;
create trigger activity_roster_stamp before insert or update on public.activity_roster
  for each row execute function public.activity_roster_stamp();

-- Build (or bring up to date) an activity's roster from its classes, as of its day: children enrolled then (started by
-- then, not gone before then) in those classes (all classes if none are picked). Rows the office changed stay as they are;
-- a child the office took off stays off; untouched rows for children no longer in its classes go.
create or replace function public.roster_build(p_event uuid)
returns int language plpgsql security definer set search_path = public as '
declare
  e public.school_events;
  d date;
  n int;
begin
  if not public.can_office() then raise exception ''Only the office can build rosters''; end if;
  select * into e from public.school_events where id = p_event;
  if e.id is null then raise exception ''That activity is gone''; end if;
  d := coalesce(e.date_options[1], e.starts_on);
  create temp table if not exists _roster_kids (student_id uuid primary key) on commit drop;
  delete from _roster_kids;
  insert into _roster_kids
  select s.id from public.students s
   where (s.status = ''enrolled'' or (s.status in (''withdrawn'', ''graduated'') and s.withdrawn_on >= d))
     and (s.start_date is null or s.start_date <= d)
     and (cardinality(e.classroom_ids) = 0 or s.classroom_id = any (e.classroom_ids));
  delete from public.activity_roster r
   where r.event_id = p_event and not r.by_hand and not r.removed and r.participation = ''undecided'' and r.note is null
     and r.permission = case when e.needs_permission then ''pending'' else ''not_required'' end
     and not exists (select 1 from _roster_kids k where k.student_id = r.student_id);
  insert into public.activity_roster (event_id, student_id, permission)
  select p_event, k.student_id, case when e.needs_permission then ''pending'' else ''not_required'' end from _roster_kids k
  on conflict (event_id, student_id) do nothing;
  get diagnostics n = row_count;
  return n;
end';

-- Charge children for a fee: only those without a charge for it yet (also safe from two people at once).
create or replace function public.collection_charge(p_collection uuid, p_students uuid[])
returns setof public.invoices language plpgsql security definer set search_path = public as '
declare
  c public.activity_collections;
begin
  if not public.can_edit_finance() then raise exception ''Only staff who record payments can charge fees''; end if;
  select * into c from public.activity_collections where id = p_collection for update;
  if c.id is null then raise exception ''That fee is gone''; end if;
  insert into public.invoices (student_id, kind, description, invoice_date, due_date, amount, collection_id, created_by)
  select s, ''fee'', left(c.name, 120), current_date, coalesce(c.due_on, current_date), c.amount, c.id, auth.uid()
    from unnest(p_students) s
   where exists (select 1 from public.students x where x.id = s)
  on conflict (collection_id, student_id) where collection_id is not null and not void do nothing;
  return query select * from public.invoices i where i.collection_id = p_collection and i.student_id = any (p_students) and not i.void;
end';

-- Who a reminder is for right now. 'unpaid': children on any of the fee''s activities, not "not going" on all of them, who
-- still owe on its charge (or are going and not charged yet). 'slip': children on the activity whose slip is pending.
create or replace function public.activity_reminder_targets(p_kind text, p_ref uuid)
returns table (student_id uuid, owed numeric) language plpgsql stable security definer set search_path = public as '
begin
  if not public.can_message() then raise exception ''Only staff who send texts can do that''; end if;
  if p_kind = ''activity-slip'' then
    return query select r.student_id, null::numeric from public.activity_roster r
      where r.event_id = p_ref and not r.removed and r.permission = ''pending'' and r.participation <> ''not_going'';
  elsif p_kind = ''activity-unpaid'' then
    return query
      with kids as (
        select r.student_id, bool_or(r.participation = ''going'') as going, bool_and(r.participation = ''not_going'') as none
          from public.activity_roster r join public.school_events e on e.id = r.event_id
         where e.collection_id = p_ref and not r.removed group by r.student_id),
      owe as (
        select k.student_id,
               case when i.id is null then (case when k.going then c.amount else 0 end)
                    else greatest(i.amount - coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0), 0) end as owed,
               k.none
          from kids k cross join public.activity_collections c
          left join public.invoices i on i.collection_id = c.id and i.student_id = k.student_id and not i.void
         where c.id = p_ref)
      select o.student_id, o.owed from owe o where o.owed > 0 and not o.none;
  else
    raise exception ''Unknown reminder'';
  end if;
end';

-- ───────── class rotation schedule ─────────
create table if not exists public.activity_slots (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.school_events(id) on delete cascade,
  sort        int not null default 0,
  kind        text not null default 'class' check (kind in ('class', 'transition')),
  label       text check (length(label) <= 80),
  teachers    text check (length(teachers) <= 120),
  starts_at   time not null,
  ends_at     time not null,
  check (ends_at > starts_at)
);
create index if not exists activity_slots_event_idx on public.activity_slots (event_id, sort);
alter table public.activity_slots enable row level security;
revoke all on public.activity_slots from anon;
drop policy if exists activity_slots_select on public.activity_slots;
drop policy if exists activity_slots_write on public.activity_slots;
create policy activity_slots_select on public.activity_slots for select to authenticated using (public.is_staff());
create policy activity_slots_write on public.activity_slots for all to authenticated
  using (public.can_office()) with check (public.can_office());

-- Save a whole schedule at once (its rows in order), so a half-saved schedule can't happen.
create or replace function public.activity_slots_save(p_event uuid, p_rows jsonb)
returns setof public.activity_slots language plpgsql security definer set search_path = public as '
begin
  if not public.can_office() then raise exception ''Only the office can change schedules''; end if;
  perform 1 from public.school_events where id = p_event for update;
  delete from public.activity_slots where event_id = p_event;
  insert into public.activity_slots (event_id, sort, kind, label, teachers, starts_at, ends_at)
  select p_event, (r.ord - 1)::int, coalesce(r.v ->> ''kind'', ''class''), nullif(btrim(r.v ->> ''label''), ''''),
         nullif(btrim(r.v ->> ''teachers''), ''''), (r.v ->> ''starts_at'')::time, (r.v ->> ''ends_at'')::time
    from jsonb_array_elements(coalesce(p_rows, ''[]'')) with ordinality as r(v, ord);
  return query select * from public.activity_slots where event_id = p_event order by sort;
end';

-- ───────── reminders: what a text was for ─────────
alter table public.messages
  add column if not exists purpose text check (purpose in ('activity-unpaid', 'activity-slip')),
  add column if not exists ref_id uuid;

revoke execute on function public.roster_build(uuid) from public, anon;
revoke execute on function public.collection_charge(uuid, uuid[]) from public, anon;
revoke execute on function public.activity_reminder_targets(text, uuid) from public, anon;
revoke execute on function public.activity_slots_save(uuid, jsonb) from public, anon;
grant  execute on function public.roster_build(uuid) to authenticated;
grant  execute on function public.collection_charge(uuid, uuid[]) to authenticated;
grant  execute on function public.activity_reminder_targets(text, uuid) to authenticated;
grant  execute on function public.activity_slots_save(uuid, jsonb) to authenticated;

-- Changes page (012): roster changes on the child's history (Enrollment), fees under Tuition & payments, schedules under
-- Settings & access.
do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.activity_roster;
    create trigger log_change after insert or update or delete on public.activity_roster
      for each row execute function public.log_change(''enrollment'');
    drop trigger if exists log_change on public.activity_collections;
    create trigger log_change after insert or update or delete on public.activity_collections
      for each row execute function public.log_change(''finance'');
    drop trigger if exists log_change on public.activity_slots;
    create trigger log_change after insert or update or delete on public.activity_slots
      for each row execute function public.log_change(''settings'');
  end if;
end';
