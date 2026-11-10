-- Creativa CRM — online registration: families fill out the registration on the website, the office reviews it and adds
-- it to Enrollment in one step (the child, both parents, emergency contacts, authorized pick-ups, allergies, medicine,
-- the pediatrician, programs, RBT and therapies, photo permission), instead of typing it in from the packet.
-- Run once in the Supabase SQL editor, after 038_program_classes.sql. Safe to run again.
--
--   student_contacts.address, .employer   each parent's (or contact's) address and work.
--   students.pediatrician, .photo_ok      the child's doctor (name and phone) and whether the school may post photos.
--   registration_forms                    what families sent, waiting for the office: new, added (to which child) or
--                                         dismissed. Only the office (admins, staff who record payments or do payroll)
--                                         can see them.
--   submit_registration(data)             what the website calls (anyone may): the "are you human" check, the blocked
--                                         senders and a limit per device, then the form is saved, cleaned up, as new.
--   registration_add(form, child, …)      the office adds a form to Enrollment: a new child, or the child already in the
--                                         CRM (then only what's missing is filled in, and contacts already there stay).
--   Telegram                              a new form sends an alert (no phone or address in it), when Telegram is set up
--                                         and "Online registration" is ticked on Settings.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.student_contacts
  add column if not exists address  text check (length(address) <= 200),
  add column if not exists employer text check (length(employer) <= 100);
alter table public.students
  add column if not exists pediatrician text check (length(pediatrician) <= 200),
  add column if not exists photo_ok     boolean;

create table if not exists public.registration_forms (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  status        text not null default 'new' check (status in ('new', 'added', 'dismissed')),
  child_name    text not null check (length(child_name) between 1 and 160),
  child_dob     date,
  start_on      date,
  parent_name   text check (length(parent_name) <= 170),
  parent_phone  text check (length(parent_phone) <= 40),
  data          jsonb not null,
  client_ip     text,
  reviewed_at   timestamptz,
  reviewed_by   uuid references public.profiles(id) on delete set null,
  student_id    uuid references public.students(id) on delete set null
);
create index if not exists registration_forms_by_date on public.registration_forms (created_at desc);
alter table public.registration_forms enable row level security;
revoke all on public.registration_forms from anon, authenticated;
grant select, update, delete on public.registration_forms to authenticated;   -- new ones only come through submit_registration
drop policy if exists registration_forms_select on public.registration_forms;
drop policy if exists registration_forms_update on public.registration_forms;
drop policy if exists registration_forms_delete on public.registration_forms;
create policy registration_forms_select on public.registration_forms for select to authenticated using (public.can_office());
create policy registration_forms_update on public.registration_forms for update to authenticated
  using (public.can_office()) with check (public.can_office());
create policy registration_forms_delete on public.registration_forms for delete to authenticated using (public.is_admin());

-- ───────── cleaning up what the website sends ─────────
-- One line of text: trimmed, at most n characters, empty = null.
create or replace function public._rf_txt(p text, n int)
returns text language sql immutable as '
  select nullif(left(btrim(regexp_replace(coalesce(p, ''''), ''[[:cntrl:]]+'', '' '', ''g'')), n), '''')
';
-- A date written YYYY-MM-DD, or null (a date that doesn''t exist is null too).
create or replace function public._rf_date(p text)
returns date language plpgsql immutable as '
begin
  if p is null or btrim(p) !~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}$'' then return null; end if;
  return btrim(p)::date;
exception when others then return null;
end';
-- One person (a parent, an emergency contact, a pick-up person), or null without a name.
create or replace function public._rf_person(p jsonb)
returns jsonb language sql immutable as '
  select case when jsonb_typeof(p) = ''object'' and (public._rf_txt(p ->> ''first'', 80) is not null or public._rf_txt(p ->> ''last'', 80) is not null)
    then jsonb_strip_nulls(jsonb_build_object(
      ''relationship'', public._rf_txt(p ->> ''relationship'', 60),
      ''first'', public._rf_txt(p ->> ''first'', 80), ''last'', public._rf_txt(p ->> ''last'', 80),
      ''cell'', public._rf_txt(p ->> ''cell'', 40), ''work_phone'', public._rf_txt(p ->> ''work_phone'', 40),
      ''email'', lower(public._rf_txt(p ->> ''email'', 200)), ''address'', public._rf_txt(p ->> ''address'', 200),
      ''employer'', public._rf_txt(p ->> ''employer'', 100)))
  end
';
-- Up to n people from a list.
create or replace function public._rf_people(p jsonb, n int)
returns jsonb language sql immutable as '
  select coalesce(jsonb_agg(x.person order by x.k), ''[]''::jsonb)
    from (select public._rf_person(v) as person, k from jsonb_array_elements(case when jsonb_typeof(p) = ''array'' then p else ''[]''::jsonb end)
            with ordinality as e(v, k) where k <= n) x
   where x.person is not null
';
-- The whole form, keeping only what the CRM uses.
create or replace function public._registration_clean(p jsonb)
returns jsonb language sql stable as '
  select jsonb_strip_nulls(jsonb_build_object(
    ''child'', jsonb_strip_nulls(jsonb_build_object(
      ''first'', public._rf_txt(p #>> ''{child,first}'', 60), ''last'', public._rf_txt(p #>> ''{child,last}'', 60),
      ''dob'', public._rf_date(p #>> ''{child,dob}''), ''program'', public._program_canon(public._rf_txt(p #>> ''{child,program}'', 60)),
      ''start_on'', public._rf_date(p #>> ''{child,start_on}''),
      ''schedule'', case when p #>> ''{child,schedule}'' in (''until_3'', ''until_545'') then p #>> ''{child,schedule}'' end)),
    ''parents'', public._rf_people(p -> ''parents'', 2),
    ''emergency'', public._rf_people(p -> ''emergency'', 4),
    ''pickups'', public._rf_people(p -> ''pickups'', 6),
    ''allergies'', public._rf_txt(p ->> ''allergies'', 300),
    ''medications'', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                        ''name'', public._rf_txt(v ->> ''name'', 80), ''details'', public._rf_txt(v ->> ''details'', 300),
                        ''expires_on'', public._rf_date(v ->> ''expires_on''))) order by k), ''[]''::jsonb)
                       from jsonb_array_elements(case when jsonb_typeof(p -> ''medications'') = ''array'' then p -> ''medications'' else ''[]''::jsonb end)
                            with ordinality as e(v, k)
                      where k <= 5 and public._rf_txt(v ->> ''name'', 80) is not null),
    ''pediatrician'', jsonb_strip_nulls(jsonb_build_object(''name'', public._rf_txt(p #>> ''{pediatrician,name}'', 100),
                                                         ''phone'', public._rf_txt(p #>> ''{pediatrician,phone}'', 40))),
    ''rbt'', case when p ->> ''rbt'' in (''yes'', ''in_process'', ''no'') then p ->> ''rbt'' end,
    ''rbt_note'', public._rf_txt(p ->> ''rbt_note'', 200),
    ''therapy'', (select coalesce(jsonb_agg(distinct t), ''[]''::jsonb) from jsonb_array_elements_text(
                   case when jsonb_typeof(p -> ''therapy'') = ''array'' then p -> ''therapy'' else ''[]''::jsonb end) t
                  where t in (''speech'', ''ot'', ''pt'')),
    ''therapy_note'', public._rf_txt(p ->> ''therapy_note'', 200),
    ''funding'', (select coalesce(jsonb_agg(distinct f), ''[]''::jsonb) from jsonb_array_elements_text(
                   case when jsonb_typeof(p -> ''funding'') = ''array'' then p -> ''funding'' else ''[]''::jsonb end) f
                  where f in (''sr'', ''sr_bpiece'', ''fes_ua'', ''fes_eo'', ''vpk'', ''stepup_pending'')),
    ''award_id'', public._rf_txt(p ->> ''award_id'', 60),
    ''photo_ok'', case when p ->> ''photo_ok'' in (''yes'', ''true'') then true when p ->> ''photo_ok'' in (''no'', ''false'') then false end,
    ''notes'', left(nullif(btrim(coalesce(p ->> ''notes'', '''')), ''''), 1000),
    ''signed_name'', public._rf_txt(p ->> ''signed_name'', 120),
    ''signed_at'', now()))
';

-- ───────── the website calls this ─────────
create or replace function public.submit_registration(p_data jsonb)
returns text language plpgsql security definer set search_path = public as '
declare
  c       jsonb;
  v_ok    boolean;
  v_why   text;
  v_ip    text := public._client_ip();
  v_phone text;
  v_email text;
  p1      jsonb;
begin
  if p_data is null or jsonb_typeof(p_data) <> ''object'' or pg_column_size(p_data) > 65536 then
    raise exception ''Something went wrong with the form. Please try again.'';
  end if;
  if coalesce(p_data ->> ''bot-field'', '''') <> '''' then return ''saved''; end if;   -- a bot: nothing is saved
  select t.ok, t.reason into v_ok, v_why from public._turnstile_check(p_data ->> ''cf-turnstile-response'') t;
  if not v_ok then
    if (select count(*) from public.intake_blocked where created_at > now() - interval ''1 hour'') < 200 then
      insert into public.intake_blocked (form, reason) values (''registration'', ''turnstile: '' || coalesce(v_why, ''failed''));
    end if;
    raise exception ''We could not check that you are not a robot. Please wait a moment and press Send again.'';
  end if;

  c := public._registration_clean(p_data);
  if c #>> ''{child,first}'' is null or c #>> ''{child,last}'' is null then raise exception ''Please write your child''''s first and last name.''; end if;
  if c #>> ''{child,dob}'' is null then raise exception ''Please write your child''''s date of birth.''; end if;
  p1 := c -> ''parents'' -> 0;
  if p1 is null or p1 ->> ''cell'' is null then raise exception ''Please write at least one parent with a phone number.''; end if;
  if c ->> ''signed_name'' is null then raise exception ''Please type your name at the end to confirm the information.''; end if;

  v_phone := nullif(right(regexp_replace(p1 ->> ''cell'', ''[^0-9]'', '''', ''g''), 10), '''');
  v_email := p1 ->> ''email'';
  if exists (select 1 from public.intake_blocklist b
              where (b.kind = ''email'' and b.value = v_email) or (b.kind = ''phone'' and b.value = v_phone)
                 or (b.kind = ''ip'' and b.value = v_ip)) then
    v_why := ''blocked-sender'';
  elsif v_ip is not null and (select count(*) from public.registration_forms
                               where client_ip = v_ip and created_at > now() - interval ''1 hour'') >= 10 then
    v_why := ''too-many-from-device'';
  else
    v_why := null;
  end if;
  if v_why is not null then
    if (select count(*) from public.intake_blocked where created_at > now() - interval ''1 hour'') < 200 then
      insert into public.intake_blocked (form, reason) values (''registration'', v_why);
    end if;
    return ''saved'';
  end if;

  insert into public.registration_forms (child_name, child_dob, start_on, parent_name, parent_phone, data, client_ip)
  values (btrim((c #>> ''{child,first}'') || '' '' || (c #>> ''{child,last}'')), (c #>> ''{child,dob}'')::date, (c #>> ''{child,start_on}'')::date,
          nullif(btrim(concat_ws('' '', p1 ->> ''first'', p1 ->> ''last'')), ''''), p1 ->> ''cell'', c, v_ip);
  return ''saved'';
end';
revoke execute on function public.submit_registration(jsonb) from public;
grant execute on function public.submit_registration(jsonb) to anon, authenticated;

-- ───────── the office adds a form to Enrollment ─────────
-- p_student: the child already in the CRM, or null for a new child (p_status, p_classroom and p_start for a new one;
-- for a child already there, p_status changes their status when given and the rest only fills what's empty).
create or replace function public.registration_add(p_form uuid, p_student uuid, p_status text, p_classroom uuid, p_start date)
returns uuid language plpgsql security definer set search_path = public as '
declare
  f        public.registration_forms;
  c        jsonb;
  v_sid    uuid;
  v_name   text;
  p1       jsonb;
  v_ther   text;
  v_ped    text;
  v_notes  text;
  v_fund   text[];
  v_role   text;
  x        record;
  m        jsonb;
  v_rbt    text;
begin
  if not public.can_office() then raise exception ''Only the office can add a registration''; end if;
  if p_status is not null and p_status not in (''enrolled'', ''waitlist'') then raise exception ''Enrolled or Waiting list''; end if;
  select * into f from public.registration_forms where id = p_form for update;
  if not found then raise exception ''That registration was not found''; end if;
  if f.status <> ''new'' then raise exception ''This registration was already added or dismissed''; end if;
  c := f.data;
  p1 := c -> ''parents'' -> 0;
  v_name := btrim((c #>> ''{child,first}'') || '' '' || (c #>> ''{child,last}''));
  v_rbt := nullif(c ->> ''rbt'', ''no'');
  v_ther := nullif(concat_ws('', '',
              (select string_agg(case t when ''speech'' then ''Speech'' when ''ot'' then ''OT'' else ''PT'' end, '', ''
                                 order by case t when ''speech'' then 1 when ''ot'' then 2 else 3 end)
                 from jsonb_array_elements_text(coalesce(c -> ''therapy'', ''[]''::jsonb)) t),
              c ->> ''therapy_note''), '''');
  v_ped := nullif(concat_ws('' · '', c #>> ''{pediatrician,name}'', c #>> ''{pediatrician,phone}''), '''');
  v_notes := nullif(concat_ws('' · '',
               case c #>> ''{child,schedule}'' when ''until_3'' then ''Schedule: until 3:00'' when ''until_545'' then ''Schedule: until 5:45 (after care)'' end,
               case when c ->> ''rbt_note'' is not null then ''RBT: '' || (c ->> ''rbt_note'') end,
               case when c ->> ''notes'' is not null then ''From the family: '' || (c ->> ''notes'') end), '''');
  select array_agg(v) into v_fund from jsonb_array_elements_text(coalesce(c -> ''funding'', ''[]''::jsonb)) v;
  if coalesce(cardinality(v_fund), 0) > 0 and not public.can_edit_finance() then
    v_notes := concat_ws('' · '', v_notes, ''Programs on the form: '' || array_to_string(v_fund, '', ''));
  end if;
  v_notes := concat_ws('' · '', ''Online registration '' || to_char(f.created_at at time zone ''America/New_York'', ''Mon FMDD, YYYY''), v_notes);

  if p_student is null then
    insert into public.students (name, dob, classroom_id, status, start_date, parent_name, parent_phone, parent_email,
                                 allergies, rbt, therapy, pediatrician, photo_ok, notes, created_by)
    values (left(v_name, 120), (c #>> ''{child,dob}'')::date, p_classroom, coalesce(p_status, ''waitlist''),
            coalesce(p_start, (c #>> ''{child,start_on}'')::date),
            nullif(btrim(concat_ws('' '', p1 ->> ''first'', p1 ->> ''last'')), ''''), p1 ->> ''cell'', p1 ->> ''email'',
            c ->> ''allergies'', v_rbt, v_ther, v_ped, (c ->> ''photo_ok'')::boolean, left(v_notes, 2000), auth.uid())
    returning id into v_sid;
  else
    select id into v_sid from public.students where id = p_student;
    if v_sid is null then raise exception ''That child was not found''; end if;
    update public.students s set
      dob = coalesce(s.dob, (c #>> ''{child,dob}'')::date),
      classroom_id = coalesce(s.classroom_id, p_classroom),
      start_date = coalesce(s.start_date, p_start, (c #>> ''{child,start_on}'')::date),
      status = coalesce(p_status, s.status),
      withdrawn_on = case when p_status is not null then null else s.withdrawn_on end,
      withdraw_reason = case when p_status is not null then null else s.withdraw_reason end,
      parent_name = coalesce(s.parent_name, nullif(btrim(concat_ws('' '', p1 ->> ''first'', p1 ->> ''last'')), '''')),
      parent_phone = coalesce(s.parent_phone, p1 ->> ''cell''),
      parent_email = coalesce(s.parent_email, p1 ->> ''email''),
      allergies = case when c ->> ''allergies'' is null then s.allergies
                       when s.allergies is null then c ->> ''allergies''
                       when position(lower(c ->> ''allergies'') in lower(s.allergies)) > 0 then s.allergies
                       else left(s.allergies || ''; '' || (c ->> ''allergies''), 300) end,
      rbt = coalesce(v_rbt, s.rbt),
      therapy = coalesce(v_ther, s.therapy),
      pediatrician = coalesce(v_ped, s.pediatrician),
      photo_ok = coalesce((c ->> ''photo_ok'')::boolean, s.photo_ok),
      notes = left(concat_ws('' · '', s.notes, v_notes), 2000)
     where s.id = v_sid;
  end if;

  -- Parents (the first one Primary, unless the child already has a different Primary), emergency contacts, pick-ups.
  -- Someone already on the child''s page (same first and last name) is kept, with anything missing filled in.
  for x in
    select u.v, u.k, u.kind from (
      select v, k, ''parent'' as kind, 1 as o from jsonb_array_elements(coalesce(c -> ''parents'', ''[]''::jsonb)) with ordinality as e(v, k)
      union all select v, k, ''emergency'', 2 from jsonb_array_elements(coalesce(c -> ''emergency'', ''[]''::jsonb)) with ordinality as e(v, k)
      union all select v, k, ''pickup'', 3 from jsonb_array_elements(coalesce(c -> ''pickups'', ''[]''::jsonb)) with ordinality as e(v, k)) u
    order by u.o, u.k
  loop
    v_role := case x.kind when ''parent'' then
                case when x.k = 1 and not exists (select 1 from public.student_contacts sc where sc.student_id = v_sid and sc.role = ''primary''
                                                   and lower(coalesce(sc.first_name, '''')) <> lower(coalesce(x.v ->> ''first'', ''''))) then ''primary''
                     else ''secondary'' end
              else x.kind end;
    update public.student_contacts sc set
      relationship = coalesce(sc.relationship, x.v ->> ''relationship''),
      cell_phone = coalesce(sc.cell_phone, x.v ->> ''cell''), work_phone = coalesce(sc.work_phone, x.v ->> ''work_phone''),
      email = coalesce(sc.email, x.v ->> ''email''), address = coalesce(x.v ->> ''address'', sc.address),
      employer = coalesce(x.v ->> ''employer'', sc.employer)
     where sc.student_id = v_sid
       and lower(btrim(coalesce(sc.first_name, ''''))) = lower(coalesce(x.v ->> ''first'', ''''))
       and lower(btrim(coalesce(sc.last_name, ''''))) = lower(coalesce(x.v ->> ''last'', ''''));
    if not found then
      insert into public.student_contacts (student_id, role, relationship, first_name, last_name, cell_phone, work_phone, email, address, employer)
      values (v_sid, v_role, x.v ->> ''relationship'', x.v ->> ''first'', x.v ->> ''last'', x.v ->> ''cell'', x.v ->> ''work_phone'',
              x.v ->> ''email'', x.v ->> ''address'', x.v ->> ''employer'');
    end if;
  end loop;

  -- Medicine kept at school (one of the same name already there is kept).
  for m in select v from jsonb_array_elements(coalesce(c -> ''medications'', ''[]''::jsonb)) v loop
    if not exists (select 1 from public.student_medications sm where sm.student_id = v_sid and lower(sm.name) = lower(m ->> ''name'')) then
      insert into public.student_medications (student_id, name, details, expires_on, created_by)
      values (v_sid, m ->> ''name'', m ->> ''details'', (m ->> ''expires_on'')::date, auth.uid());
    end if;
  end loop;

  -- Programs and the award ID (for staff who record payments; otherwise they are in the notes).
  if public.can_edit_finance() and (coalesce(cardinality(v_fund), 0) > 0 or c ->> ''award_id'' is not null) then
    insert into public.student_finance (student_id, funding, award_id)
    values (v_sid, coalesce(v_fund, ''{}''), c ->> ''award_id'')
    on conflict (student_id) do update
      set funding = (select coalesce(array_agg(distinct z), ''{}'') from unnest(public.student_finance.funding || excluded.funding) z where z <> ''private''),
          award_id = coalesce(public.student_finance.award_id, excluded.award_id);
  end if;

  update public.registration_forms
     set status = ''added'', student_id = v_sid, reviewed_at = now(), reviewed_by = auth.uid()
   where id = p_form;
  return v_sid;
end';
revoke execute on function public.registration_add(uuid, uuid, text, uuid, date) from public, anon;
grant execute on function public.registration_add(uuid, uuid, text, uuid, date) to authenticated;

-- ───────── Telegram ─────────
update public.settings set telegram_forms = telegram_forms || array['registration']
 where id = 1 and not ('registration' = any (telegram_forms));
alter table public.settings alter column telegram_forms
  set default array['schedule-tour', 'waitlist', 'contact', 'bloom-interest', 'family-support', 'registration'];

create or replace function public.registration_forms_telegram()
returns trigger language plpgsql security definer set search_path = public as '
declare
  s       public.settings;
  v_token text;
  v_id    bigint;
begin
  select * into s from public.settings where id = 1;
  if s.telegram_chat_id is null or not s.telegram_token_set or not (''registration'' = any (s.telegram_forms)) then return null; end if;
  v_token := public._telegram_token();
  if v_token is null then return null; end if;
  v_id := net.http_post(
    url := ''https://api.telegram.org/bot'' || v_token || ''/sendMessage'',
    body := jsonb_build_object(''chat_id'', s.telegram_chat_id, ''disable_web_page_preview'', true,
      ''text'', ''New online registration: '' || new.child_name
                || coalesce('', starts '' || to_char(new.start_on, ''Mon FMDD, YYYY''), '''')
                || ''. Review it in the CRM: Enrollment, Online registrations.''),
    headers := ''{"Content-Type": "application/json"}''::jsonb,
    timeout_milliseconds := 10000);
  update public.settings set telegram_last_at = now(), telegram_last_request = v_id, telegram_last_result = ''queued'' where id = 1;
  return null;
exception when others then
  return null;
end';
drop trigger if exists registration_forms_telegram on public.registration_forms;
create trigger registration_forms_telegram after insert on public.registration_forms
  for each row execute function public.registration_forms_telegram();

revoke execute on function public._rf_txt(text, int), public._rf_date(text), public._rf_person(jsonb), public._rf_people(jsonb, int),
  public._registration_clean(jsonb), public.registration_forms_telegram() from public, anon, authenticated;
