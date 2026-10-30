-- Creativa CRM — the school's monthly calendar: activities, reminders for families, the theme and the menu of each week
-- (Calendar page, and "This week at school" on Today). Run once in the Supabase SQL editor, after 028. Safe to run again.
--
--   school_events   what's happening (Christmas pictures, a farm visit, music class, a fundraiser...), a reminder for
--                   families (bring $40 cash, bring your bicycle, registration due), or the week's theme or menu: a day,
--                   or several (to, for a theme or a menu that runs all week). Closed days stay on Settings → School
--                   calendar (school_closures); tuition days and children's birthdays come from the CRM itself.
--                   All staff see it; the office (admins, and staff who record payments or do payroll) adds and changes it.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create table if not exists public.school_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  kind        text not null default 'event' check (kind in ('event', 'reminder', 'theme', 'menu')),
  title       text not null check (length(trim(title)) between 1 and 120),
  details     text check (length(details) <= 500),
  starts_on   date not null,
  ends_on     date,
  check (ends_on is null or (ends_on >= starts_on and ends_on - starts_on <= 31))
);
create index if not exists school_events_starts_idx on public.school_events (starts_on);

alter table public.school_events enable row level security;
revoke all on public.school_events from anon;
drop policy if exists school_events_select on public.school_events;
drop policy if exists school_events_write on public.school_events;
create policy school_events_select on public.school_events for select to authenticated using (public.is_staff());
create policy school_events_write on public.school_events for all to authenticated
  using (public.can_office()) with check (public.can_office());

-- Changes show on the Changes page (012), under Settings & access.
do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.school_events;
    create trigger log_change after insert or update or delete on public.school_events
      for each row execute function public.log_change(''settings'');
  end if;
end';
