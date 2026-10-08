-- Creativa CRM — enrollment pipeline
-- Run once in the Supabase SQL editor (or `supabase db push`).
--
-- Model:
--   profiles    one row per staff login (auth.users). New logins start INACTIVE;
--               an admin activates them. Only active staff can see any data.
--   inquiries   one row per family inquiry, from a website form or added by staff.
--   activities  timeline per inquiry: notes, calls, emails, texts, stage changes.
--
-- Website forms write through submit_inquiry() (SECURITY DEFINER, callable by anon).
-- anon has no direct access to any table.

create extension if not exists pgcrypto;

-- ───────────────────────── profiles ─────────────────────────
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null default 'staff' check (role in ('admin','staff')),
  active      boolean not null default false,
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- ───────────────────────── inquiries ─────────────────────────
create table public.inquiries (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  source          text not null default 'manual',      -- website form name, or 'manual'
  stage           text not null default 'new'
                  check (stage in ('new','contacted','tour_scheduled','toured','waitlisted','enrolled','lost')),
  parent_name     text,
  email           text,
  phone           text,
  phone_digits    text generated always as (nullif(regexp_replace(coalesce(phone,''), '\D', '', 'g'), '')) stored,
  contact_pref    text,
  child_name      text,
  child_dob       date,
  program         text,
  desired_start   text,
  heard_from      text,
  message         text,
  raw             jsonb not null default '{}'::jsonb,  -- full form submission, untouched
  assigned_to     uuid references public.profiles(id) on delete set null,
  tour_at         timestamptz,
  next_follow_up  date,
  lost_reason     text,
  created_by      uuid references public.profiles(id) on delete set null
);

create index inquiries_stage_idx     on public.inquiries (stage);
create index inquiries_created_idx   on public.inquiries (created_at desc);
create index inquiries_email_idx     on public.inquiries (lower(email));
create index inquiries_phone_idx     on public.inquiries (phone_digits);
create index inquiries_followup_idx  on public.inquiries (next_follow_up) where stage not in ('enrolled','lost');

-- ───────────────────────── activities ─────────────────────────
create table public.activities (
  id          uuid primary key default gen_random_uuid(),
  inquiry_id  uuid not null references public.inquiries(id) on delete cascade,
  created_at  timestamptz not null default now(),
  author      uuid references public.profiles(id) on delete set null default auth.uid(),
  kind        text not null check (kind in ('note','call','email','text','stage','system')),
  body        text not null check (length(body) between 1 and 5000)
);

create index activities_inquiry_idx on public.activities (inquiry_id, created_at desc);

-- ───────────────────────── triggers ─────────────────────────
create or replace function public.inquiries_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger inquiries_touch before update on public.inquiries
  for each row execute function public.inquiries_touch();

create or replace function public.inquiries_log()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  labels constant jsonb := '{"new":"New","contacted":"Contacted","tour_scheduled":"Tour scheduled",
    "toured":"Toured","waitlisted":"Waitlisted","enrolled":"Enrolled","lost":"Lost"}';
begin
  if tg_op = 'INSERT' then
    insert into public.activities (inquiry_id, author, kind, body)
    values (new.id, auth.uid(), 'system',
            case when new.source = 'manual' then 'Added by staff'
                 else 'Received from website form: ' || new.source end);
  elsif new.stage is distinct from old.stage then
    insert into public.activities (inquiry_id, author, kind, body)
    values (new.id, auth.uid(), 'stage',
            (labels->>old.stage) || ' → ' || (labels->>new.stage)
            || case when new.stage = 'lost' and new.lost_reason is not null then ' (' || new.lost_reason || ')' else '' end);
  end if;
  return new;
end $$;

create trigger inquiries_log after insert or update of stage on public.inquiries
  for each row execute function public.inquiries_log();

-- ───────────────────────── RLS ─────────────────────────
alter table public.profiles   enable row level security;
alter table public.inquiries  enable row level security;
alter table public.activities enable row level security;

revoke all on public.profiles, public.inquiries, public.activities from anon;

-- profiles: active staff see the team; a pending user sees only their own row
-- (so the app can say "waiting for approval"). Only admins change roles/active.
create policy profiles_select on public.profiles for select to authenticated
  using (public.is_staff() or id = auth.uid());
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- inquiries: any active staff member works the pipeline; only admins delete.
create policy inquiries_select on public.inquiries for select to authenticated using (public.is_staff());
create policy inquiries_insert on public.inquiries for insert to authenticated with check (public.is_staff());
create policy inquiries_update on public.inquiries for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy inquiries_delete on public.inquiries for delete to authenticated using (public.is_admin());

-- activities: staff read all and add their own; delete own (or admin). No edits.
create policy activities_select on public.activities for select to authenticated using (public.is_staff());
create policy activities_insert on public.activities for insert to authenticated
  with check (public.is_staff() and author = auth.uid() and kind in ('note','call','email','text'));
create policy activities_delete on public.activities for delete to authenticated
  using (public.is_staff() and (author = auth.uid() or public.is_admin()));

-- An admin must not be able to lock everyone out by demoting/deactivating themselves.
create or replace function public.profiles_guard()
returns trigger language plpgsql as $$
begin
  if new.id = auth.uid() and (new.role <> old.role or new.active <> old.active) then
    raise exception 'You cannot change your own role or access';
  end if;
  return new;
end $$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- ───────────────────────── website intake ─────────────────────────
-- First non-empty value among the given keys. Arrays (checkbox groups) are joined with ", ".
create or replace function public._form_txt(j jsonb, variadic keys text[])
returns text language plpgsql immutable as $$
declare k text; v text;
begin
  foreach k in array keys loop
    v := case jsonb_typeof(j->k)
           when 'array' then (select string_agg(btrim(e), ', ') from jsonb_array_elements_text(j->k) e where btrim(e) <> '')
           when 'string' then btrim(j->>k)
           else null end;
    if v is not null and v <> '' then return left(v, 2000); end if;
  end loop;
  return null;
end $$;

-- Tour and waitlist forms spell classrooms differently ("Early Twos" vs "Early 2's").
-- Store one canonical label so the pipeline can filter by program.
create or replace function public._program_canon(p text)
returns text language sql immutable as $$
  select case
    when p is null then null
    when p ~* '15\D*17'                      then '15–17 months'
    when p ~* '18\D*23'                      then '18–23 months'
    when p ~* 'early\s*(2|two)'              then 'Early 2s'
    when p ~* 'late\s*(2|two)'               then 'Late 2s'
    when p ~* 'early\s*(3|three)'            then 'Early 3s'
    when p ~* 'late\s*(3|three)'             then 'Late 3s'
    when p ~* 'vpk|pre-?k'                   then 'VPK'
    when p ~* 'kinder'                       then 'Kindergarten'
    when p ~* 'bloom'                        then 'Bloom'
    when p ~* 'not sure'                     then 'Not sure'
    else left(p, 100) end;
$$;

create or replace function public.submit_inquiry(p_form text, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_email text; v_phone text; v_digits text; v_dob text; v_parent text; v_child text;
  v_recent uuid; v_row jsonb;
begin
  if p_form not in ('schedule-tour','waitlist','contact','bloom-interest','family-support') then
    raise exception 'unknown form';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data) > 16384 then
    raise exception 'invalid submission';
  end if;
  -- Honeypot filled in: a bot. Accept silently.
  if coalesce(p_data->>'bot-field', '') <> '' then return; end if;

  v_email  := lower(public._form_txt(p_data, 'parent-email', 'email'));
  v_phone  := public._form_txt(p_data, 'parent-phone', 'phone');
  v_digits := nullif(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), '');
  if v_email is null and v_phone is null then raise exception 'email or phone required'; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_email := null; end if;

  -- Throttle: same contact more than 3 times in 10 minutes, or a flood overall. Drop quietly.
  if (select count(*) from public.inquiries
       where created_at > now() - interval '10 minutes' and source <> 'manual'
         and ((v_email is not null and lower(email) = v_email) or (v_digits is not null and phone_digits = v_digits))) >= 3
     or (select count(*) from public.inquiries
          where created_at > now() - interval '10 minutes' and source <> 'manual') >= 60 then
    return;
  end if;

  v_parent := coalesce(
    public._form_txt(p_data, 'parent_name', 'parent-name', 'name'),
    nullif(concat_ws(' ', public._form_txt(p_data, 'parent-first-name'), public._form_txt(p_data, 'parent-last-name')), ''),
    nullif(concat_ws(' ', public._form_txt(p_data, 'first-name'), public._form_txt(p_data, 'last-name')), ''));
  v_child := coalesce(
    public._form_txt(p_data, 'child_name', 'child-name'),
    nullif(concat_ws(' ', public._form_txt(p_data, 'child-first-name'), public._form_txt(p_data, 'child-last-name')), ''));
  v_dob := public._form_txt(p_data, 'child_dob', 'child-dob');

  -- Same form from the same contact within 2 minutes is a resubmit (double click, or the
  -- parent fixed a validation error): update that row instead of adding a duplicate.
  select id into v_recent from public.inquiries
   where source = p_form and stage = 'new' and created_at > now() - interval '2 minutes'
     and ((v_email is not null and lower(email) = v_email) or (v_digits is not null and phone_digits = v_digits))
   order by created_at desc limit 1;

  v_row := jsonb_build_object(
    'parent_name',   left(v_parent, 200),
    'email',         v_email,
    'phone',         left(v_phone, 40),
    'contact_pref',  public._form_txt(p_data, 'contact-pref', 'contact-method'),
    'child_name',    left(v_child, 200),
    'child_dob',     case when v_dob ~ '^\d{4}-\d{2}-\d{2}$' then v_dob end,
    'program',       case p_form when 'bloom-interest' then 'Bloom'
                                 when 'family-support' then null   -- that form's "program" means a government program
                                 else public._program_canon(public._form_txt(p_data, 'program')) end,
    'desired_start', public._form_txt(p_data, 'start-time', 'desired-start', 'start-timeline'),
    'heard_from',    public._form_txt(p_data, 'heard_from', 'referral', 'referral-source[]', 'referral-source'),
    'message',       public._form_txt(p_data, 'message', 'notes', 'child-description', 'additional-info'));

  if v_recent is not null then
    update public.inquiries i set
      parent_name   = coalesce(v_row->>'parent_name', i.parent_name),
      email         = coalesce(v_row->>'email', i.email),
      phone         = coalesce(v_row->>'phone', i.phone),
      contact_pref  = coalesce(v_row->>'contact_pref', i.contact_pref),
      child_name    = coalesce(v_row->>'child_name', i.child_name),
      child_dob     = coalesce((v_row->>'child_dob')::date, i.child_dob),
      program       = coalesce(v_row->>'program', i.program),
      desired_start = coalesce(v_row->>'desired_start', i.desired_start),
      heard_from    = coalesce(v_row->>'heard_from', i.heard_from),
      message       = coalesce(v_row->>'message', i.message),
      raw           = p_data - 'bot-field'
    where i.id = v_recent;
    return;
  end if;

  insert into public.inquiries
    (source, parent_name, email, phone, contact_pref, child_name, child_dob, program,
     desired_start, heard_from, message, raw)
  values (
    p_form, v_row->>'parent_name', v_row->>'email', v_row->>'phone', v_row->>'contact_pref',
    v_row->>'child_name', (v_row->>'child_dob')::date, v_row->>'program',
    v_row->>'desired_start', v_row->>'heard_from', v_row->>'message', p_data - 'bot-field');
end $$;

-- Function privileges: Supabase grants EXECUTE to anon by default; tighten.
revoke execute on function public.submit_inquiry(text, jsonb) from public;
grant  execute on function public.submit_inquiry(text, jsonb) to anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public._form_txt(jsonb, text[]) from public, anon, authenticated;
revoke execute on function public._program_canon(text) from public, anon, authenticated;
