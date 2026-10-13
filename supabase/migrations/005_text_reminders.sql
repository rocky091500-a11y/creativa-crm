-- Creativa CRM — automatic tour reminders by text message (Twilio), alongside the tour emails.
-- Run once in the Supabase SQL Editor after 004_turnstile.sql.
--
--   settings.texts_enabled        off until Twilio is set up (Settings → Automatic text messages)
--   settings.tour_reminder_text   wording of the day-before text
--   settings.followup_text        wording of the "how was your visit?" text
--   inquiries.reminder_texted_at / followup_texted_at   when each text went out
--   text_opt_outs                 numbers that replied STOP; never texted automatically again
--
-- Texts go out from netlify/functions/tour-texts.mjs (hourly). Replies come in through
-- netlify/functions/text-inbound.mjs and are logged on the family's timeline.
-- Note: this file avoids dollar quoting so it pastes cleanly into the SQL Editor.

-- ───────────────────────── settings ─────────────────────────
alter table public.settings
  add column texts_enabled      boolean not null default false,
  add column tour_reminder_text text not null default 'Creativa Academy: Hi {parent}! Reminder: your tour is tomorrow, {tour_date} at {tour_time}. Need a different time? Just reply. / Su visita es mañana a las {tour_time}. Reply STOP to opt out.',
  add column followup_text      text not null default 'Creativa Academy: Hi {parent}! Thank you for visiting us. Any questions about enrolling {child}? Just reply here. / ¡Gracias por visitarnos! ¿Alguna pregunta? Responda aquí. Reply STOP to opt out.';

-- ───────────────────────── per-tour stamps ─────────────────────────
alter table public.inquiries
  add column reminder_texted_at timestamptz,
  add column followup_texted_at timestamptz;

-- A new tour time is a new tour: emails and texts all go out again for it.
create or replace function public.inquiries_tour_reset()
returns trigger language plpgsql as '
begin
  if new.tour_at is distinct from old.tour_at then
    new.tour_reminder_sent_at := null;
    new.followup_sent_at := null;
    new.reminder_texted_at := null;
    new.followup_texted_at := null;
  end if;
  return new;
end';

-- US numbers only: 10 digits, or 11 starting with 1. Anything else is not texted automatically.
create or replace function public._e164(p_digits text)
returns text language sql immutable as '
  select case
    when length(p_digits) = 10 and left(p_digits, 1) between ''2'' and ''9'' then ''+1'' || p_digits
    when length(p_digits) = 11 and left(p_digits, 1) = ''1'' and substr(p_digits, 2, 1) between ''2'' and ''9'' then ''+'' || p_digits
  end';

-- ───────────────────────── opt-outs ─────────────────────────
create table public.text_opt_outs (
  phone      text primary key,              -- +13055551234
  created_at timestamptz not null default now(),
  source     text not null default 'reply'  -- reply (they texted STOP) | carrier (Twilio said opted out)
);
alter table public.text_opt_outs enable row level security;
revoke all on public.text_opt_outs from anon, authenticated;
grant select on public.text_opt_outs to authenticated;
create policy text_opt_outs_select on public.text_opt_outs for select to authenticated using (public.is_staff());

-- ───────────────────────── what is due ─────────────────────────
-- Same schedule as the emails (Miami time), but never after 8pm:
--   reminder  the day before the tour, 9am–8pm, while the stage is still Tour scheduled
--   followup  7 to 10 days after the tour, 10am–8pm, only for families with no email (or with emails
--             switched off) — everyone else already gets the follow-up email — and only if nobody has
--             logged a call, email or text with them since the tour (a reply by text counts).
-- Skipped: automatic messages switched off for the family, texts off in settings, no US mobile
-- number, or the number has opted out.
create or replace function public.tour_texts_due(p_now timestamptz default now())
returns table (kind text, inquiry_id uuid, phone text, parent_name text, child_name text, tour_at timestamptz)
language sql stable security definer set search_path = public as '
  with t as (select (p_now at time zone ''America/New_York'') as local_now),
       s as (select texts_enabled, emails_enabled from public.settings where id = 1)
  select ''reminder'', i.id, public._e164(i.phone_digits), i.parent_name, i.child_name, i.tour_at
    from public.inquiries i, t, s
   where s.texts_enabled
     and i.stage = ''tour_scheduled'' and i.reminder_texted_at is null
     and (i.tour_at at time zone ''America/New_York'')::date = t.local_now::date + 1
     and extract(hour from t.local_now) between 9 and 19
     and i.auto_emails and public._e164(i.phone_digits) is not null
     and not exists (select 1 from public.text_opt_outs o where o.phone = public._e164(i.phone_digits))
  union all
  select ''followup'', i.id, public._e164(i.phone_digits), i.parent_name, i.child_name, i.tour_at
    from public.inquiries i, t, s
   where s.texts_enabled
     and i.stage in (''tour_scheduled'',''toured'') and i.followup_texted_at is null
     and (i.tour_at at time zone ''America/New_York'')::date between t.local_now::date - 10 and t.local_now::date - 7
     and extract(hour from t.local_now) between 10 and 19
     and i.auto_emails and public._e164(i.phone_digits) is not null
     and (i.email is null or not s.emails_enabled)
     and not exists (select 1 from public.text_opt_outs o where o.phone = public._e164(i.phone_digits))
     and not exists (select 1 from public.activities a
                      where a.inquiry_id = i.id and a.kind in (''call'',''email'',''text'') and a.created_at > i.tour_at)
';

-- The text job claims a text before sending it, so two overlapping runs can never text a family twice.
-- Returns false if it was already claimed.
create or replace function public.tour_text_claim(p_inquiry uuid, p_kind text)
returns boolean language plpgsql security definer set search_path = public as '
begin
  if p_kind = ''reminder'' then
    update public.inquiries set reminder_texted_at = now() where id = p_inquiry and reminder_texted_at is null;
  elsif p_kind = ''followup'' then
    update public.inquiries set followup_texted_at = now() where id = p_inquiry and followup_texted_at is null;
  else
    raise exception ''unknown text kind'';
  end if;
  return found;
end';

-- After sending: sent → logged on the timeline; failed → claim released so the next run retries;
-- opted_out (Twilio refused: the number replied STOP) → number recorded, never retried.
create or replace function public.tour_text_result(p_inquiry uuid, p_kind text, p_to text, p_status text)
returns void language plpgsql security definer set search_path = public as '
begin
  if p_kind not in (''reminder'', ''followup'') then raise exception ''unknown text kind''; end if;
  if p_status = ''sent'' then
    insert into public.activities (inquiry_id, author, kind, body)
    values (p_inquiry, null, ''text'',
            case p_kind when ''reminder'' then ''Automatic tour reminder texted to ''
                        else ''Automatic “how was your visit?” text sent to '' end || p_to);
  elsif p_status = ''failed'' then
    if p_kind = ''reminder'' then
      update public.inquiries set reminder_texted_at = null where id = p_inquiry;
    else
      update public.inquiries set followup_texted_at = null where id = p_inquiry;
    end if;
  elsif p_status = ''opted_out'' then
    insert into public.text_opt_outs (phone, source) values (p_to, ''carrier'') on conflict (phone) do nothing;
    insert into public.activities (inquiry_id, author, kind, body)
    values (p_inquiry, null, ''system'', ''Not texted: '' || p_to || '' has opted out of text messages'');
  else
    raise exception ''unknown status'';
  end if;
end';

-- ───────────────────────── replies ─────────────────────────
-- A text to the school's Twilio number. STOP-type words opt the number out, START-type words opt it
-- back in (Twilio sends the confirmation reply itself). Every message is logged as a Text on the
-- most recent inquiry with that number. Returns who it was from, or null if the number is unknown.
create or replace function public.text_inbound(p_from text, p_body text)
returns table (inquiry_id uuid, parent_name text, action text)
language plpgsql security definer set search_path = public as '
declare
  v_word text := upper(trim(both '' .!'' from coalesce(p_body, '''')));
  v_action text := ''message'';
  v_inq record;
begin
  if v_word in (''STOP'', ''STOPALL'', ''UNSUBSCRIBE'', ''CANCEL'', ''END'', ''QUIT'', ''REVOKE'', ''OPTOUT'', ''PARAR'') then
    v_action := ''opt_out'';
    insert into public.text_opt_outs (phone, source) values (p_from, ''reply'') on conflict (phone) do nothing;
  elsif v_word in (''START'', ''UNSTOP'', ''YES'') then
    v_action := ''opt_in'';
    delete from public.text_opt_outs where phone = p_from;
  end if;
  select i.id, i.parent_name into v_inq
    from public.inquiries i
   where public._e164(i.phone_digits) = p_from
   order by (i.stage in (''enrolled'', ''lost'')), i.updated_at desc nulls last, i.created_at desc
   limit 1;
  if v_inq.id is null then
    return query select null::uuid, null::text, v_action;
    return;
  end if;
  insert into public.activities (inquiry_id, author, kind, body)
  values (v_inq.id, null, ''text'',
          case v_action
            when ''opt_out'' then ''Replied '' || v_word || '' by text: no more automatic texts''
            when ''opt_in''  then ''Replied '' || v_word || '' by text: automatic texts back on''
            else ''Text from family: '' || left(coalesce(p_body, ''''), 1500) end);
  return query select v_inq.id, v_inq.parent_name, v_action;
end';

-- ───────────────────────── access ─────────────────────────
revoke execute on function public._e164(text) from public, anon;
revoke execute on function public.tour_texts_due(timestamptz) from public, anon, authenticated;
revoke execute on function public.tour_text_claim(uuid, text) from public, anon, authenticated;
revoke execute on function public.tour_text_result(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.text_inbound(text, text) from public, anon, authenticated;
grant  execute on function public._e164(text) to authenticated, service_role;
grant  execute on function public.tour_texts_due(timestamptz) to service_role;
grant  execute on function public.tour_text_claim(uuid, text) to service_role;
grant  execute on function public.tour_text_result(uuid, text, text, text) to service_role;
grant  execute on function public.text_inbound(text, text) to service_role;
grant  select on public.text_opt_outs to service_role;
