-- Creativa CRM — a planning file's items are imported once, ever: one the office deleted (kept the calendar's own entry
-- instead) doesn't come back when the same file is imported again. Run once in the Supabase SQL editor, after
-- 032_school_planning.sql. Safe to run again.
--
--   school_event_imports   every planning-file item already imported (source + key), even if its draft was deleted since.
--   school_events_import   as in 032, but skips any item in school_event_imports and records the ones it adds.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create table if not exists public.school_event_imports (
  source       text not null,
  source_key   text not null,
  imported_at  timestamptz not null default now(),
  primary key (source, source_key)
);
alter table public.school_event_imports enable row level security;
revoke all on public.school_event_imports from anon, authenticated;

insert into public.school_event_imports (source, source_key)
select source, source_key from public.school_events where source is not null and source_key is not null
on conflict do nothing;

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
    if exists (select 1 from public.school_event_imports where source = p_source and source_key = it ->> ''key'')
       or exists (select 1 from public.school_events where source = p_source and source_key = it ->> ''key'')
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
    insert into public.school_event_imports (source, source_key) values (p_source, it ->> ''key'') on conflict do nothing;
    added := added + 1;
    for pr in select * from jsonb_array_elements(coalesce(it -> ''prep'', ''[]''::jsonb)) loop
      insert into public.school_event_prep (event_id, assignee, classroom_id, task, supplies, due_on)
      values (ev, pr ->> ''assignee'', (select c.id from public.classrooms c where lower(c.name) = lower(pr ->> ''class'') limit 1),
              pr ->> ''task'', nullif(pr ->> ''supplies'', ''''), nullif(pr ->> ''due_on'', '''')::date);
    end loop;
  end loop;
  return jsonb_build_object(''added'', added, ''skipped'', skipped);
end';
