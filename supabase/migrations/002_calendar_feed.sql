-- Creativa CRM — tour calendar feed (iCalendar) for Google Calendar and phones.
-- Run once in the Supabase SQL editor, after 001_init.sql.
--
-- The feed is a URL with a secret token. Anyone holding the URL can read tour names
-- and phone numbers, so only admins can see the token, and they can rotate it from
-- the CRM's Staff page; the old URL stops working at once.
--
-- No dollar-quoting or backslashes in this file: function bodies use single quotes,
-- so the script survives copy-paste through tools that escape special characters.

-- PostgREST serves a function's result raw, whatever the request's Accept header, when it returns
-- the "*/*" domain; the function then sets its own Content-Type. Calendar apps often send no Accept.
create domain "*/*" as bytea;

create table public.calendar_feed (
  id          int primary key default 1 check (id = 1),
  token       text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  rotated_at  timestamptz not null default now()
);
insert into public.calendar_feed default values;

alter table public.calendar_feed enable row level security;
revoke all on public.calendar_feed from anon, authenticated;
grant select on public.calendar_feed to authenticated;
create policy calendar_feed_admin_select on public.calendar_feed for select to authenticated
  using (public.is_admin());

create or replace function public.rotate_calendar_token()
returns text language plpgsql security definer set search_path = public as '
declare v text;
begin
  if not public.is_admin() then
    raise exception ''Only an admin can reset the calendar link'';
  end if;
  update public.calendar_feed
     set token = encode(extensions.gen_random_bytes(24), ''hex''), rotated_at = now()
   where id = 1
  returning token into v;
  return v;
end';

-- RFC 5545 text escaping (backslash, semicolon, comma, newline), then fold long lines.
-- chr(92) is a backslash, chr(13)/chr(10) are CR/LF: written that way so the file has no backslashes.
create or replace function public._ics_text(p text)
returns text language sql immutable as '
  select replace(replace(replace(replace(replace(coalesce(p, ''''),
         chr(92), chr(92) || chr(92)), '';'', chr(92) || '';''), '','', chr(92) || '',''),
         chr(13), ''''), chr(10), chr(92) || ''n'')
';

create or replace function public._ics_fold(line text)
returns text language sql immutable as '
  select string_agg(substr(line, i, 74), chr(13) || chr(10) || '' '' order by i)
  from generate_series(1, greatest(length(line), 1), 74) as i
';

create or replace function public._ics_stamp(t timestamptz)
returns text language sql immutable as '
  select to_char(t at time zone ''UTC'', ''YYYYMMDD"T"HH24MISS"Z"'')
';

-- Tours from 60 days back onward, for any family not marked Lost. 45-minute events.
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
    where i.tour_at is not null and i.stage <> ''lost''
      and i.tour_at > now() - interval ''60 days''
  ) e;

  return array_to_string(array[
    ''BEGIN:VCALENDAR'', ''VERSION:2.0'', ''PRODID:-//Creativa Academy//CRM tours//EN'',
    ''CALSCALE:GREGORIAN'', ''METHOD:PUBLISH'', ''X-WR-CALNAME:Creativa tours'',
    ''X-WR-TIMEZONE:America/New_York'', ''REFRESH-INTERVAL;VALUE=DURATION:PT1H'', ''X-PUBLISHED-TTL:PT1H'']
    || case when v_events is null then array[]::text[] else array[v_events] end
    || array[''END:VCALENDAR''], crlf) || crlf;
end';

-- The URL calendar apps subscribe to: /rest/v1/rpc/tours_ics?token=...&apikey=...
-- Supabase's gateway reads apikey from the URL; the unused parameter keeps the call working
-- if it is ever passed through to the database.
create or replace function public.tours_ics(token text, apikey text default null)
returns "*/*" language plpgsql stable security definer set search_path = public as '
declare v text;
begin
  v := public.tours_calendar(token);
  perform set_config(''response.headers'',
    ''[{"Content-Type": "text/calendar; charset=utf-8"}, {"Cache-Control": "private, max-age=300"}]'', true);
  return convert_to(v, ''UTF8'');
end';

revoke execute on function public.tours_calendar(text) from public, anon, authenticated;
revoke execute on function public.tours_ics(text, text) from public;
grant  execute on function public.tours_ics(text, text) to anon, authenticated;
revoke execute on function public.rotate_calendar_token() from public, anon;
grant  execute on function public.rotate_calendar_token() to authenticated;
revoke execute on function public._ics_text(text) from public, anon, authenticated;
revoke execute on function public._ics_fold(text) from public, anon, authenticated;
revoke execute on function public._ics_stamp(timestamptz) from public, anon, authenticated;
