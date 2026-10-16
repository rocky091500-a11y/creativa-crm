-- Creativa CRM — your own saved texts on the Messages page ("My messages"), written by the school.
-- Run once in the Supabase SQL editor, after 013_family_texts.sql. Safe to run again.
--
--   message_templates   a name and the wording, with blocks such as {parent}, {child}, {balance}, {class} and {me}
--                       that are filled in for each family when it's sent. Starts with three examples; edit or delete
--                       them. The same people who can send texts (013) can save, change and delete them.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create table if not exists public.message_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 60),
  body        text not null check (length(body) between 1 and 900),
  sort        int not null default 0,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.message_templates enable row level security;
revoke all on public.message_templates from anon;
drop policy if exists message_templates_select on public.message_templates;
drop policy if exists message_templates_insert on public.message_templates;
drop policy if exists message_templates_update on public.message_templates;
drop policy if exists message_templates_delete on public.message_templates;
create policy message_templates_select on public.message_templates for select to authenticated using (public.can_message());
create policy message_templates_insert on public.message_templates for insert to authenticated with check (public.can_message());
create policy message_templates_update on public.message_templates for update to authenticated
  using (public.can_message()) with check (public.can_message());
create policy message_templates_delete on public.message_templates for delete to authenticated using (public.can_message());

-- Three examples to start from (only when there are none).
insert into public.message_templates (name, body, sort, created_by)
select x.name, x.body, x.sort, null from (values
  ('Payment reminder', 'Hi {parent}, this is {me} from Creativa Academy. A friendly reminder that {child}''s tuition balance is {balance}. You can pay by Zelle, card or cash. Thank you!', 1),
  ('Activity reminder', 'Hi {parent}! This is {me} from Creativa Academy. Just a reminder that [activity] is on [day] at [time]. Please [what to bring]. Thank you!', 2),
  ('School closed', 'Hi {parent}, this is {me} from Creativa Academy. We will be closed on [day] for [reason] and reopen on [day]. Thank you!', 3)
) as x(name, body, sort)
where not exists (select 1 from public.message_templates);

-- Saved, changed and deleted texts show on the Changes page (012), under Tuition & payments.
do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.message_templates;
    create trigger log_change after insert or update or delete on public.message_templates
      for each row execute function public.log_change(''finance'');
  end if;
end';
