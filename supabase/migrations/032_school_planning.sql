-- Creativa CRM — School planning on the Calendar: plan the month as drafts, say which classes or floors each thing is for,
-- assign the prep work to teachers, settle what still needs a decision, print a staff and a family calendar, and keep
-- tours off closed days. Run once in the Supabase SQL editor, after 031_reregistration.sql. Safe to run again.
--
--   classrooms.floor          the floor a class is on (1st, 2nd), for "1st floor" events and each floor's family calendar.
--   school_events             (029) gains:
--     status                  draft (staff only: being planned) or approved (on the family calendar). Everything already
--                             on the calendar stays approved; an import comes in as drafts.
--     classroom_ids           the classes it's for (none = the whole school). A floor or a program is its classes.
--     kind 'closure'          no school for some classes (VPK and Kindergarten Thanksgiving week). Whole-school closed
--                             days stay on Settings → School calendar.
--     internal_note           for staff only, never on the family calendar.
--     date_options            not decided yet: its possible dates (a fundraiser on Nov 10 or 17). Shown to staff as
--                             tentative; never to families.
--     question                something to settle before it goes to families (is Kindergarten off too?).
--     replaces                entries already on the calendar it takes the place of (removed when it's approved).
--     source, source_key      where an imported item came from, so importing the same file again adds nothing.
--   school_event_prep         the prep work for an event: who (a teacher), what, the supplies, and when it's due; staff
--                             see it (each teacher their week), the office assigns it, and anyone on staff ticks it done.
--   school_event_decide       settles a draft's date (one of its options) or answers its question; it stays a draft.
--   school_event_approve      approves a settled draft (removing the entries it replaces), so families can see it.
--   school_events_import      adds a planning file's items as drafts: never twice, never changing or removing what's on
--                             the calendar (staff edits stay), and a week that already has a theme or a menu keeps it.
--   tours                     a tour can't be set on a day the whole school is closed (Settings → School calendar).
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.classrooms add column if not exists floor smallint check (floor between 1 and 9);

alter table public.school_events drop constraint if exists school_events_kind_check;
alter table public.school_events add constraint school_events_kind_check
  check (kind in ('event', 'reminder', 'theme', 'menu', 'closure'));
alter table public.school_events
  add column if not exists status text not null default 'approved' check (status in ('draft', 'approved')),
  add column if not exists classroom_ids uuid[] not null default '{}',
  add column if not exists internal_note text check (length(internal_note) <= 500),
  add column if not exists date_options date[] not null default '{}',
  add column if not exists question text check (length(question) <= 300),
  add column if not exists replaces uuid[] not null default '{}',
  add column if not exists source text check (length(source) <= 60),
  add column if not exists source_key text check (length(source_key) <= 120),
  add column if not exists updated_at timestamptz;
alter table public.school_events drop constraint if exists school_events_decided;
alter table public.school_events add constraint school_events_decided
  check (status = 'draft' or (cardinality(date_options) = 0 and question is null));
create unique index if not exists school_events_source_key on public.school_events (source, source_key) where source is not null;

create table if not exists public.school_event_prep (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  event_id      uuid not null references public.school_events(id) on delete cascade,
  assignee      text not null check (length(trim(assignee)) between 1 and 60),
  classroom_id  uuid references public.classrooms(id) on delete set null,
  task          text not null check (length(trim(task)) between 1 and 200),
  supplies      text check (length(supplies) <= 300),
  due_on        date,
  done_at       timestamptz,
  done_by       uuid references public.profiles(id) on delete set null
);
create index if not exists school_event_prep_event_idx on public.school_event_prep (event_id);

alter table public.school_event_prep enable row level security;
revoke all on public.school_event_prep from anon;
drop policy if exists school_event_prep_select on public.school_event_prep;
drop policy if exists school_event_prep_write on public.school_event_prep;
create policy school_event_prep_select on public.school_event_prep for select to authenticated using (public.is_staff());
create policy school_event_prep_write on public.school_event_prep for all to authenticated
  using (public.can_office()) with check (public.can_office());

do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.school_event_prep;
    create trigger log_change after insert or update or delete on public.school_event_prep
      for each row execute function public.log_change(''settings'');
  end if;
end';

-- Any staff member ticks their prep done (or not).
create or replace function public.prep_done(p_id uuid, p_done boolean)
returns public.school_event_prep language plpgsql security definer set search_path = public as '
declare
  r public.school_event_prep;
begin
  if not public.is_staff() then raise exception ''Only staff can do that''; end if;
  update public.school_event_prep
     set done_at = case when p_done then coalesce(done_at, now()) end, done_by = case when p_done then coalesce(done_by, auth.uid()) end
   where id = p_id returning * into r;
  if r.id is null then raise exception ''That prep is gone''; end if;
  return r;
end';

create or replace function public.school_event_decide(p_id uuid, p_on date, p_answer text)
returns public.school_events language plpgsql security definer set search_path = public as '
declare
  e public.school_events;
begin
  if not public.can_office() then raise exception ''Only the office can plan the calendar''; end if;
  select * into e from public.school_events where id = p_id for update;
  if e.id is null then raise exception ''That entry is gone''; end if;
  if p_on is not null then
    if cardinality(e.date_options) > 0 and not (p_on = any (e.date_options)) then raise exception ''Pick one of its possible dates''; end if;
    update public.school_events
       set ends_on = case when ends_on is null then null else ends_on + (p_on - starts_on) end, starts_on = p_on,
           date_options = ''{}'', updated_at = now()
     where id = p_id returning * into e;
  end if;
  if nullif(btrim(p_answer), '''') is not null then
    update public.school_events
       set internal_note = left(concat_ws('' · '', internal_note, ''Decided: '' || btrim(p_answer)), 500), question = null, updated_at = now()
     where id = p_id returning * into e;
  end if;
  return e;
end';

create or replace function public.school_event_approve(p_id uuid)
returns public.school_events language plpgsql security definer set search_path = public as '
declare
  e public.school_events;
begin
  if not public.can_office() then raise exception ''Only the office can approve the calendar''; end if;
  select * into e from public.school_events where id = p_id for update;
  if e.id is null then raise exception ''That entry is gone''; end if;
  if cardinality(e.date_options) > 0 then raise exception ''Pick its date first''; end if;
  if e.question is not null then raise exception ''Answer its question first''; end if;
  delete from public.school_events where id = any (e.replaces) and id <> p_id;
  update public.school_events set status = ''approved'', replaces = ''{}'', updated_at = now() where id = p_id returning * into e;
  return e;
end';

-- p_plan: {"floors": {"Class name": 1, ...}, "items": [{"key", "kind", "title", "details", "starts_on", "ends_on",
--   "classes": [names], "floors": [1], "internal_note", "date_options": [dates], "question",
--   "replaces": [{"title", "on"}], "prep": [{"assignee", "class", "task", "supplies", "due_on"}]}, ...]}
create or replace function public.school_events_import(p_source text, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = public as '
declare
  it jsonb;
  pr jsonb;
  ev uuid;
  added int := 0;
  skipped int := 0;
  cls uuid[];
begin
  if not public.can_office() then raise exception ''Only the office can import a plan''; end if;
  if coalesce(btrim(p_source), '''') = '''' then raise exception ''Name the planning file''; end if;
  -- Floors: only for classes that don''t have one yet.
  update public.classrooms c set floor = (p_plan -> ''floors'' ->> c.name)::smallint
   where c.floor is null and p_plan -> ''floors'' ? c.name;
  for it in select * from jsonb_array_elements(coalesce(p_plan -> ''items'', ''[]''::jsonb)) loop
    if exists (select 1 from public.school_events where source = p_source and source_key = it ->> ''key'')
       or ((it ->> ''kind'') in (''theme'', ''menu'') and exists (select 1 from public.school_events v
             where v.kind = it ->> ''kind'' and v.starts_on <= coalesce((it ->> ''ends_on'')::date, (it ->> ''starts_on'')::date)
               and coalesce(v.ends_on, v.starts_on) >= (it ->> ''starts_on'')::date)) then
      skipped := skipped + 1;
      continue;
    end if;
    select coalesce(array_agg(c.id), ''{}'') into cls from public.classrooms c
     where lower(c.name) in (select lower(x) from jsonb_array_elements_text(coalesce(it -> ''classes'', ''[]'')) x)
        or c.floor in (select x::smallint from jsonb_array_elements_text(coalesce(it -> ''floors'', ''[]'')) x);
    insert into public.school_events (kind, title, details, starts_on, ends_on, status, classroom_ids, internal_note, date_options,
                                      question, replaces, source, source_key)
    values (coalesce(it ->> ''kind'', ''event''), it ->> ''title'', nullif(it ->> ''details'', ''''), (it ->> ''starts_on'')::date,
            nullif(it ->> ''ends_on'', '''')::date, ''draft'', cls, nullif(it ->> ''internal_note'', ''''),
            coalesce((select array_agg(x::date order by x::date) from jsonb_array_elements_text(it -> ''date_options'') x), ''{}''),
            nullif(it ->> ''question'', ''''),
            coalesce((select array_agg(v.id) from public.school_events v
                       join jsonb_array_elements(coalesce(it -> ''replaces'', ''[]'')) r
                         on lower(v.title) = lower(r ->> ''title'') and v.starts_on = (r ->> ''on'')::date
                      where v.source is distinct from p_source), ''{}''),
            p_source, it ->> ''key'')
    on conflict (source, source_key) where source is not null do nothing
    returning id into ev;
    if ev is null then skipped := skipped + 1; continue; end if;
    added := added + 1;
    for pr in select * from jsonb_array_elements(coalesce(it -> ''prep'', ''[]''::jsonb)) loop
      insert into public.school_event_prep (event_id, assignee, classroom_id, task, supplies, due_on)
      values (ev, pr ->> ''assignee'', (select c.id from public.classrooms c where lower(c.name) = lower(pr ->> ''class'') limit 1),
              pr ->> ''task'', nullif(pr ->> ''supplies'', ''''), nullif(pr ->> ''due_on'', '''')::date);
    end loop;
  end loop;
  return jsonb_build_object(''added'', added, ''skipped'', skipped);
end';

revoke execute on function public.prep_done(uuid, boolean) from public, anon;
revoke execute on function public.school_event_decide(uuid, date, text) from public, anon;
revoke execute on function public.school_event_approve(uuid) from public, anon;
revoke execute on function public.school_events_import(text, jsonb) from public, anon;
grant  execute on function public.prep_done(uuid, boolean) to authenticated;
grant  execute on function public.school_event_decide(uuid, date, text) to authenticated;
grant  execute on function public.school_event_approve(uuid) to authenticated;
grant  execute on function public.school_events_import(text, jsonb) to authenticated;

-- Tours: not on a day the whole school is closed. Tours already set on such a day stay (the Calendar lists them to call).
create or replace function public.tour_not_on_closure()
returns trigger language plpgsql security definer set search_path = public as '
declare
  c text;
begin
  if new.tour_at is not null and (tg_op = ''INSERT'' or new.tour_at is distinct from old.tour_at) then
    select name into c from public.school_closures
     where (new.tour_at at time zone ''America/New_York'')::date between starts_on and ends_on order by starts_on limit 1;
    if c is not null then
      raise exception ''The school is closed that day (%). Pick another day for the tour.'', c using errcode = ''check_violation'';
    end if;
  end if;
  return new;
end';
drop trigger if exists tour_not_on_closure on public.inquiries;
create trigger tour_not_on_closure before insert or update of tour_at on public.inquiries
  for each row execute function public.tour_not_on_closure();
