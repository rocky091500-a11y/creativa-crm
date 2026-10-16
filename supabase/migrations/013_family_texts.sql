-- Creativa CRM — text messages to families: activity reminders, payment reminders, one-off notes (Messages page).
-- Run once in the Supabase SQL editor, after 001–012 (in that order). Safe to run again.
--
--   messages             one row per text staff send: who sent it, to whom (a description, e.g. "Families who owe"),
--                        the wording as written, and when it goes out (now, or later).
--   message_recipients   one row per phone number: the family's own text ({parent}, {child}, {balance} filled in)
--                        and what happened: queued → sending → sent | failed | opted_out | canceled.
--   Sent by netlify/functions/family-texts.mjs through Twilio, the same account as the tour texts, only between
--   8am and 9pm Miami time. Numbers that replied STOP (text_opt_outs) are skipped.
--   Admins and staff who can record payments (finance "View & record") send and see texts.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create or replace function public.can_message()
returns boolean language sql stable security definer set search_path = public as '
  select exists (select 1 from public.profiles where id = auth.uid() and active and (role = ''admin'' or finance = ''edit''));
';

create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  created_by   uuid references public.profiles(id) on delete set null default auth.uid(),
  audience     text not null check (length(audience) between 1 and 200),
  body         text not null check (length(body) between 1 and 1000),
  send_at      timestamptz not null default now(),
  canceled_at  timestamptz
);
create index if not exists messages_created_idx on public.messages (created_at desc);

create table if not exists public.message_recipients (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.messages(id) on delete cascade,
  student_id  uuid references public.students(id) on delete set null,
  name        text check (length(name) <= 120),
  phone       text not null check (phone ~ '^[+][1-9][0-9]{7,14}$'),
  body        text not null check (length(body) between 1 and 1600),
  status      text not null default 'queued' check (status in ('queued','sending','sent','failed','opted_out','canceled')),
  sent_at     timestamptz,
  error       text check (length(error) <= 300),
  unique (message_id, phone)
);
create index if not exists message_recipients_queue_idx on public.message_recipients (status) where status = 'queued';
create index if not exists message_recipients_student_idx on public.message_recipients (student_id);

alter table public.messages enable row level security;
alter table public.message_recipients enable row level security;
revoke all on public.messages, public.message_recipients from anon;
revoke update, delete on public.messages, public.message_recipients from authenticated;
drop policy if exists messages_select on public.messages;
drop policy if exists messages_insert on public.messages;
drop policy if exists message_recipients_select on public.message_recipients;
drop policy if exists message_recipients_insert on public.message_recipients;
create policy messages_select on public.messages for select to authenticated using (public.can_message());
create policy messages_insert on public.messages for insert to authenticated
  with check (public.can_message() and created_by = auth.uid() and canceled_at is null);
create policy message_recipients_select on public.message_recipients for select to authenticated using (public.can_message());
create policy message_recipients_insert on public.message_recipients for insert to authenticated
  with check (public.can_message() and status = 'queued' and sent_at is null and error is null);

-- Cancel a text that hasn't gone out yet. Returns how many families it won't go to.
create or replace function public.message_cancel(p_message uuid)
returns int language plpgsql security definer set search_path = public as '
declare
  n int;
begin
  if not public.can_message() then raise exception ''Only admins and staff who record payments can cancel texts''; end if;
  update public.messages set canceled_at = now() where id = p_message and canceled_at is null;
  update public.message_recipients set status = ''canceled'' where message_id = p_message and status = ''queued'';
  get diagnostics n = row_count;
  return n;
end';

-- The sending job (service role): texts due now. Numbers that opted out are marked and skipped; nothing is due
-- before 8am or from 9pm, Miami time.
create or replace function public.family_texts_due(p_now timestamptz default now(), p_limit int default 100)
returns table (id uuid, phone text, body text)
language plpgsql security definer set search_path = public as '
declare
  h int := extract(hour from (p_now at time zone ''America/New_York''))::int;
begin
  update public.message_recipients r set status = ''opted_out''
    from public.messages m
   where m.id = r.message_id and r.status = ''queued'' and m.canceled_at is null and m.send_at <= p_now
     and exists (select 1 from public.text_opt_outs o where o.phone = r.phone);
  if h < 8 or h >= 21 then return; end if;
  return query
    select r.id, r.phone, r.body from public.message_recipients r join public.messages m on m.id = r.message_id
     where r.status = ''queued'' and m.canceled_at is null and m.send_at <= p_now
     order by m.send_at, r.id limit p_limit;
end';

-- Claim before sending, so two runs never text the same family twice.
create or replace function public.family_text_claim(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as '
begin
  update public.message_recipients set status = ''sending'' where id = p_id and status = ''queued'';
  return found;
end';

create or replace function public.family_text_result(p_id uuid, p_status text, p_error text default null)
returns void language plpgsql security definer set search_path = public as '
begin
  if p_status not in (''sent'', ''failed'', ''opted_out'') then raise exception ''Unknown status %'', p_status; end if;
  update public.message_recipients
     set status = p_status, sent_at = case when p_status = ''sent'' then now() end, error = left(p_error, 300)
   where id = p_id;
  if p_status = ''opted_out'' then
    insert into public.text_opt_outs (phone, source) select phone, ''carrier'' from public.message_recipients where id = p_id
    on conflict (phone) do nothing;
  end if;
end';

-- Sent texts show on the Changes page (012), under Tuition & payments.
do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.messages;
    create trigger log_change after insert or update or delete on public.messages
      for each row execute function public.log_change(''finance'');
  end if;
end';

revoke execute on function public.can_message() from public, anon;
grant  execute on function public.can_message() to authenticated;
revoke execute on function public.message_cancel(uuid) from public, anon;
grant  execute on function public.message_cancel(uuid) to authenticated;
revoke execute on function public.family_texts_due(timestamptz, int) from public, anon, authenticated;
revoke execute on function public.family_text_claim(uuid) from public, anon, authenticated;
revoke execute on function public.family_text_result(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.family_texts_due(timestamptz, int) to service_role;
grant  execute on function public.family_text_claim(uuid) to service_role;
grant  execute on function public.family_text_result(uuid, text, text) to service_role;
grant  select on public.messages, public.message_recipients to service_role;
