-- Creativa CRM — tours to reschedule, Telegram alerts for website requests, and blocking spammers.
-- Run once in the Supabase SQL editor, after 001–004 (in that order). Safe to run again.
--
--   1. A "Reschedule" stage for tours that have to be moved. Those families leave the tour
--      calendar and get no reminder email until they are back at "Tour scheduled".
--   2. Telegram: each new website request is sent to a Telegram chat as soon as it is saved,
--      only after the "are you human" check has passed. The bot token lives in Supabase Vault;
--      admins connect it from the CRM's Settings page.
--   3. Spam: admins can mark an inquiry as spam, which deletes it and blocks that email, phone
--      and device. One device can send at most 5 website requests an hour.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

-- ───────────────────────── 1. Reschedule stage ─────────────────────────
alter table public.inquiries drop constraint if exists inquiries_stage_check;
alter table public.inquiries add constraint inquiries_stage_check
  check (stage in ('new','contacted','tour_scheduled','reschedule','toured','waitlisted','enrolled','lost'));

create or replace function public.inquiries_log()
returns trigger language plpgsql security definer set search_path = public as '
declare
  labels constant jsonb := ''{"new":"New","contacted":"Contacted","tour_scheduled":"Tour scheduled",
    "reschedule":"Reschedule","toured":"Toured","waitlisted":"Waitlisted","enrolled":"Enrolled","lost":"Lost"}'';
begin
  if tg_op = ''INSERT'' then
    insert into public.activities (inquiry_id, author, kind, body)
    values (new.id, auth.uid(), ''system'',
            case when new.source = ''manual'' then ''Added by staff''
                 else ''Received from website form: '' || new.source end);
  elsif new.stage is distinct from old.stage then
    insert into public.activities (inquiry_id, author, kind, body)
    values (new.id, auth.uid(), ''stage'',
            coalesce(labels ->> old.stage, old.stage) || '' → '' || coalesce(labels ->> new.stage, new.stage)
            || case when new.stage = ''lost'' and new.lost_reason is not null then '' ('' || new.lost_reason || '')'' else '''' end);
  end if;
  return new;
end';

-- Tours waiting to be rescheduled leave the calendar feed (same feed as 002, one condition added).
create or replace function public.tours_calendar(token text)
returns text language plpgsql stable security definer set search_path = public as '
declare
  crlf constant text := chr(13) || chr(10);
  v_events text;
begin
  if token is null or not exists (select 1 from public.calendar_feed f where f.token = tours_calendar.token) then
    raise exception ''invalid calendar link'' using errcode = ''42501'';
  end if;

  select string_agg(ev, crlf order by tour_at, id) into v_events
  from (
    select i.tour_at, i.id, array_to_string(array[
      ''BEGIN:VEVENT'',
      ''UID:tour-'' || i.id || ''@crm.creativaacademy.com'',
      ''DTSTAMP:'' || public._ics_stamp(i.updated_at),
      ''LAST-MODIFIED:'' || public._ics_stamp(i.updated_at),
      ''DTSTART:'' || public._ics_stamp(i.tour_at),
      ''DTEND:'' || public._ics_stamp(i.tour_at + interval ''45 minutes''),
      public._ics_fold(''SUMMARY:'' || public._ics_text(''Tour: '' || coalesce(i.parent_name, ''Family'')
        || coalesce('' - '' || nullif(concat_ws('', '', i.child_name, i.program), ''''), ''''))),
      public._ics_fold(''DESCRIPTION:'' || public._ics_text(concat_ws(chr(10),
        ''Phone: '' || i.phone,
        ''Email: '' || i.email,
        ''Child: '' || nullif(concat_ws('' '', i.child_name, ''(born '' || to_char(i.child_dob, ''Mon DD, YYYY'') || '')''), ''''),
        ''Program: '' || i.program,
        ''Assigned to: '' || (select p.full_name from public.profiles p where p.id = i.assigned_to),
        ''Open in CRM: https://crm.creativaacademy.com/''))),
      ''LOCATION:Creativa Academy'',
      ''STATUS:CONFIRMED'',
      ''END:VEVENT''], crlf) as ev
    from public.inquiries i
    where i.tour_at is not null and i.stage not in (''lost'', ''reschedule'')
      and i.tour_at > now() - interval ''60 days''
  ) e;

  return array_to_string(array[
    ''BEGIN:VCALENDAR'', ''VERSION:2.0'', ''PRODID:-//Creativa Academy//CRM tours//EN'',
    ''CALSCALE:GREGORIAN'', ''METHOD:PUBLISH'', ''X-WR-CALNAME:Creativa tours'',
    ''X-WR-TIMEZONE:America/New_York'', ''REFRESH-INTERVAL;VALUE=DURATION:PT1H'', ''X-PUBLISHED-TTL:PT1H'']
    || case when v_events is null then array[]::text[] else array[v_events] end
    || array[''END:VCALENDAR''], crlf) || crlf;
end';

-- ───────────────────────── 2. Telegram alerts ─────────────────────────
alter table public.settings
  add column if not exists telegram_chat_id text
    check (telegram_chat_id ~ '^-?[0-9]{1,20}$' or telegram_chat_id ~ '^@[A-Za-z0-9_]{4,64}$'),
  add column if not exists telegram_forms text[] not null
    default array['schedule-tour','waitlist','contact','bloom-interest','family-support'],
  add column if not exists telegram_token_set boolean not null default false,
  add column if not exists telegram_last_at timestamptz,
  add column if not exists telegram_last_result text;

-- Receipts: the school's address line, as on the Programs & Hours sheet.
update public.settings
   set receipt_header = '13910 SW 8th St, Miami, FL 33184 · (786) 900-0099 · info@creativaacademy.com · creativaacademy.com'
 where id = 1 and receipt_header is null;

create or replace function public._telegram_token()
returns text language sql stable security definer set search_path = public as '
  select nullif(s.decrypted_secret, '''') from vault.decrypted_secrets s where s.name = ''telegram_bot_token'' limit 1
';

-- One call to the Telegram Bot API. Never raises; the token never appears in what it returns.
create or replace function public._telegram_call(p_method text, p_body jsonb, out ok boolean, out result jsonb)
language plpgsql security definer set search_path = public as '
declare
  v_token text := public._telegram_token();
  v_resp  extensions.http_response;
begin
  if v_token is null then
    ok := false; result := jsonb_build_object(''description'', ''No bot token saved''); return;
  end if;
  begin
    perform set_config(''http.timeout_msec'', ''4000'', true);
    v_resp := extensions.http_post(''https://api.telegram.org/bot'' || v_token || ''/'' || p_method,
                                   p_body::text, ''application/json'');
    result := v_resp.content::jsonb;
    ok := coalesce((result ->> ''ok'')::boolean, false);
  exception when others then
    ok := false; result := jsonb_build_object(''description'', replace(sqlerrm, v_token, ''…''));
  end;
end';

-- The alert text for one inquiry (plain text, no formatting codes to escape).
create or replace function public._telegram_text(i public.inquiries)
returns text language sql stable security definer set search_path = public as '
  select left(concat_ws(chr(10),
    case i.source when ''schedule-tour''  then ''🗓 New tour request''
                  when ''waitlist''       then ''📝 New waitlist sign-up''
                  when ''contact''        then ''✉️ New contact message''
                  when ''bloom-interest'' then ''🌱 New Bloom interest''
                  when ''family-support'' then ''🤝 New family support request''
                  else ''New website inquiry'' end,
    nullif(concat_ws('' · '', i.parent_name, i.phone, i.email), ''''),
    ''Prefers: '' || i.contact_pref,
    ''Child: '' || nullif(concat_ws('', '', i.child_name, ''born '' || to_char(i.child_dob, ''Mon FMDD, YYYY'')), ''''),
    ''Program: '' || i.program,
    ''Start: '' || i.desired_start,
    ''Tour days: '' || public._form_txt(coalesce(i.raw, ''{}''), ''days[]'', ''days''),
    ''Tour time: '' || public._form_txt(coalesce(i.raw, ''{}''), ''time-pref''),
    ''Heard about us: '' || i.heard_from,
    ''Referred by: '' || public._form_txt(coalesce(i.raw, ''{}''), ''referred-by''),
    ''Message: '' || left(i.message, 1500),
    ''Open the CRM: https://crm.creativaacademy.com/''), 4000)
';

-- After a website inquiry is saved (never for staff-added ones, resubmits or old imports).
-- Any failure is recorded on the settings row and never stops the family's request.
create or replace function public.inquiries_telegram()
returns trigger language plpgsql security definer set search_path = public as '
declare
  s     public.settings;
  v_ok  boolean;
  v_res jsonb;
begin
  select * into s from public.settings where id = 1;
  if s.telegram_chat_id is null or not s.telegram_token_set
     or not (new.source = any (s.telegram_forms)) or new.created_at < now() - interval ''10 minutes'' then
    return null;
  end if;
  select c.ok, c.result into v_ok, v_res
    from public._telegram_call(''sendMessage'', jsonb_build_object(
      ''chat_id'', s.telegram_chat_id, ''text'', public._telegram_text(new), ''disable_web_page_preview'', true)) c;
  update public.settings
     set telegram_last_at = now(),
         telegram_last_result = case when v_ok then ''ok'' else left(coalesce(v_res ->> ''description'', ''failed''), 200) end
   where id = 1;
  return null;
exception when others then
  return null;
end';

drop trigger if exists inquiries_telegram on public.inquiries;
create trigger inquiries_telegram after insert on public.inquiries
  for each row when (new.source <> 'manual') execute function public.inquiries_telegram();

-- Admin: save (or, with an empty value, remove) the bot token. It goes to Vault, never to a table.
create or replace function public.set_telegram_token(p_token text)
returns void language plpgsql security definer set search_path = public as '
declare
  v_token text := btrim(coalesce(p_token, ''''));
  v_id    uuid;
begin
  if not public.is_admin() then raise exception ''Only an admin can change Telegram settings''; end if;
  if v_token <> '''' and v_token !~ ''^[0-9]{5,15}:[A-Za-z0-9_-]{30,60}$'' then
    raise exception ''That is not a Telegram bot token. It looks like 123456789:AAH4… (from @BotFather)'';
  end if;
  select id into v_id from vault.secrets where name = ''telegram_bot_token'' limit 1;
  if v_id is null then
    if v_token <> '''' then perform vault.create_secret(v_token, ''telegram_bot_token''); end if;
  else
    perform vault.update_secret(v_id, v_token);
  end if;
  update public.settings set telegram_token_set = (v_token <> ''''), telegram_last_result = null where id = 1;
end';

-- Admin: chats that recently messaged the bot (or added it to a group), to pick the chat ID.
create or replace function public.telegram_recent_chats()
returns table (chat_id text, title text) language plpgsql security definer set search_path = public as '
declare
  v_ok  boolean;
  v_res jsonb;
begin
  if not public.is_admin() then raise exception ''Only an admin can change Telegram settings''; end if;
  select c.ok, c.result into v_ok, v_res from public._telegram_call(''getUpdates'', ''{"limit": 100}''::jsonb) c;
  if not v_ok then raise exception ''Telegram said: %'', coalesce(v_res ->> ''description'', ''no answer''); end if;
  return query
    select distinct on (x.c ->> ''id'') (x.c ->> ''id''),
           coalesce(x.c ->> ''title'', nullif(concat_ws('' '', x.c ->> ''first_name'', x.c ->> ''last_name''), ''''),
                    x.c ->> ''username'', x.c ->> ''id'')
      from jsonb_array_elements(coalesce(v_res -> ''result'', ''[]''::jsonb)) u,
           lateral (select coalesce(u -> ''message'' -> ''chat'', u -> ''my_chat_member'' -> ''chat'',
                                    u -> ''channel_post'' -> ''chat'', u -> ''edited_message'' -> ''chat'') as c) x
     where x.c is not null;
end';

-- Admin: send a test message to the saved chat. Returns ''ok'' or what Telegram answered.
create or replace function public.telegram_send_test()
returns text language plpgsql security definer set search_path = public as '
declare
  v_chat text;
  v_ok   boolean;
  v_res  jsonb;
  v_out  text;
begin
  if not public.is_admin() then raise exception ''Only an admin can change Telegram settings''; end if;
  select telegram_chat_id into v_chat from public.settings where id = 1;
  if v_chat is null then return ''Save a chat ID first''; end if;
  select c.ok, c.result into v_ok, v_res from public._telegram_call(''sendMessage'', jsonb_build_object(
    ''chat_id'', v_chat, ''text'', ''✅ Creativa CRM is connected. New website requests will show up here.'')) c;
  v_out := case when v_ok then ''ok'' else left(coalesce(v_res ->> ''description'', ''failed''), 200) end;
  update public.settings set telegram_last_at = now(), telegram_last_result = v_out where id = 1;
  return v_out;
end';

-- ───────────────────────── 3. Spam: blocked senders, per-device limit ─────────────────────────
create table if not exists public.intake_blocklist (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('email','phone','ip')),
  value       text not null check (length(value) between 3 and 200),
  note        text check (length(note) <= 200),
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  unique (kind, value)
);

-- Store emails in lower case and phones as their last 10 digits, so any spelling matches.
create or replace function public.intake_blocklist_norm()
returns trigger language plpgsql as '
begin
  new.value := btrim(new.value);
  if new.kind = ''email'' then
    new.value := lower(new.value);
  elsif new.kind = ''phone'' then
    new.value := right(regexp_replace(new.value, ''[^0-9]'', '''', ''g''), 10);
  end if;
  return new;
end';
drop trigger if exists intake_blocklist_norm on public.intake_blocklist;
create trigger intake_blocklist_norm before insert or update on public.intake_blocklist
  for each row execute function public.intake_blocklist_norm();

alter table public.intake_blocklist enable row level security;
revoke all on public.intake_blocklist from anon, authenticated;
grant select, insert, delete on public.intake_blocklist to authenticated;
drop policy if exists intake_blocklist_admin_select on public.intake_blocklist;
drop policy if exists intake_blocklist_admin_insert on public.intake_blocklist;
drop policy if exists intake_blocklist_admin_delete on public.intake_blocklist;
create policy intake_blocklist_admin_select on public.intake_blocklist for select to authenticated using (public.is_admin());
create policy intake_blocklist_admin_insert on public.intake_blocklist for insert to authenticated with check (public.is_admin());
create policy intake_blocklist_admin_delete on public.intake_blocklist for delete to authenticated using (public.is_admin());

-- The device (IP address) a website request came from, so a spammer's device can be blocked.
alter table public.inquiries add column if not exists client_ip text;

create or replace function public._client_ip()
returns text language sql stable as '
  select nullif(btrim(split_part(coalesce(nullif(h ->> ''cf-connecting-ip'', ''''), nullif(h ->> ''x-real-ip'', ''''),
                                          h ->> ''x-forwarded-for'', ''''), '','', 1)), '''')
    from (select coalesce(nullif(current_setting(''request.headers'', true), ''''), ''{}'')::jsonb as h) x
';

create or replace function public.inquiries_client_ip()
returns trigger language plpgsql as '
begin
  if new.source <> ''manual'' then
    new.client_ip := nullif(current_setting(''crm.client_ip'', true), '''');
  end if;
  return new;
end';
drop trigger if exists inquiries_client_ip on public.inquiries;
create trigger inquiries_client_ip before insert on public.inquiries
  for each row execute function public.inquiries_client_ip();

-- Website intake: the Turnstile check from 004, then blocked senders and the per-device limit.
create or replace function public.submit_inquiry(p_form text, p_data jsonb)
returns void language plpgsql security definer set search_path = public as '
declare
  v_ok     boolean;
  v_reason text;
  v_ip     text := public._client_ip();
  v_email  text;
  v_phone  text;
begin
  select c.ok, c.reason into v_ok, v_reason
    from public._turnstile_check(p_data ->> ''cf-turnstile-response'') c;
  if v_ok and jsonb_typeof(p_data) = ''object'' then
    v_email := lower(public._form_txt(p_data, ''parent-email'', ''email''));
    v_phone := nullif(right(regexp_replace(coalesce(public._form_txt(p_data, ''parent-phone'', ''phone''), ''''),
                                           ''[^0-9]'', '''', ''g''), 10), '''');
    if exists (select 1 from public.intake_blocklist b
                where (b.kind = ''email'' and b.value = v_email)
                   or (b.kind = ''phone'' and b.value = v_phone)
                   or (b.kind = ''ip'' and b.value = v_ip)) then
      v_ok := false; v_reason := ''blocked-sender'';
    elsif v_ip is not null and (select count(*) from public.inquiries
                                 where client_ip = v_ip and created_at > now() - interval ''1 hour'') >= 5 then
      v_ok := false; v_reason := ''too-many-from-device'';
    end if;
  end if;
  if not v_ok then
    -- Bounded, so a bot flood cannot grow this table without limit.
    if (select count(*) from public.intake_blocked where created_at > now() - interval ''1 hour'') < 200 then
      insert into public.intake_blocked (form, reason) values (left(coalesce(p_form, ''?''), 40), left(v_reason, 80));
    end if;
    return;
  end if;
  perform set_config(''crm.client_ip'', coalesce(v_ip, ''''), true);
  perform public._submit_inquiry_core(p_form, p_data - ''cf-turnstile-response'');
end';

-- Admin: delete an inquiry as spam and block its email, phone and device from sending again.
create or replace function public.mark_inquiry_spam(p_id uuid)
returns int language plpgsql security definer set search_path = public as '
declare
  i public.inquiries;
  n int;
begin
  if not public.is_admin() then raise exception ''Only an admin can mark spam''; end if;
  select * into i from public.inquiries where id = p_id;
  if not found then raise exception ''That inquiry no longer exists''; end if;
  insert into public.intake_blocklist (kind, value, note, created_by)
  select x.k, x.v, left(''Marked as spam: '' || coalesce(i.parent_name, i.email, i.phone, ''unknown''), 200), auth.uid()
    from (values (''email'', lower(i.email)), (''phone'', right(i.phone_digits, 10)), (''ip'', i.client_ip)) as x(k, v)
   where x.v is not null and length(x.v) >= 3
  on conflict (kind, value) do nothing;
  get diagnostics n = row_count;
  delete from public.inquiries where id = p_id;
  return n;
end';

-- Admin: is the Turnstile secret stored? (Shown on Settings; the secret itself is never returned.)
create or replace function public.turnstile_configured()
returns boolean language sql stable security definer set search_path = public as '
  select public.is_admin() and exists (select 1 from vault.decrypted_secrets s
                                        where s.name = ''turnstile_secret_key'' and coalesce(s.decrypted_secret, '''') <> '''')
';

-- ───────────────────────── privileges ─────────────────────────
revoke execute on function public._telegram_token() from public, anon, authenticated;
revoke execute on function public._telegram_call(text, jsonb) from public, anon, authenticated;
revoke execute on function public._telegram_text(public.inquiries) from public, anon, authenticated;
revoke execute on function public.inquiries_telegram() from public, anon, authenticated;
revoke execute on function public.intake_blocklist_norm() from public, anon, authenticated;
revoke execute on function public._client_ip() from public, anon, authenticated;
revoke execute on function public.inquiries_client_ip() from public, anon, authenticated;
revoke execute on function public.submit_inquiry(text, jsonb) from public;
grant  execute on function public.submit_inquiry(text, jsonb) to anon, authenticated;
revoke execute on function public.set_telegram_token(text) from public, anon;
revoke execute on function public.telegram_recent_chats() from public, anon;
revoke execute on function public.telegram_send_test() from public, anon;
revoke execute on function public.mark_inquiry_spam(uuid) from public, anon;
revoke execute on function public.turnstile_configured() from public, anon;
grant  execute on function public.set_telegram_token(text), public.telegram_recent_chats(), public.telegram_send_test(),
                           public.mark_inquiry_spam(uuid), public.turnstile_configured() to authenticated;
