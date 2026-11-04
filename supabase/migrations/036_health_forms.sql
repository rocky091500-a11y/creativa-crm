-- Creativa CRM — the yellow form (physical) and blue form (immunization) expiration dates on each child, and a reminder to
-- the office a month before one expires (Enrollment → the child → Documents, and Enrollment → Forms).
-- Run once in the Supabase SQL editor, after 035_no_tour.sql. Safe to run again.
--
--   students.physical_expires       when the child's physical (yellow form) expires.
--   students.immunization_status    the blue form (DH 680): part_b (temporary, with an expiration), part_a (completed:
--                                   no expiration), religious or medical (exemption), pending (not in yet).
--   students.immunization_expires   when a Part B blue form expires.
--   settings.forms_reminder_to      who gets the reminders; empty = everyone in the office.
--   todos.ref                       what a to-do is about, so each form has one open reminder.
--   reminders                       for each enrolled (or waiting) child's form with an expiration, a to-do "renew it",
--                                   due the day it expires and shown on Today 30 days before. A new date replaces an open
--                                   reminder (or starts a new one once the old one was checked off). It goes away when the
--                                   form has no date any more (Part A, an exemption) or the child leaves.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.students
  add column if not exists physical_expires date,
  add column if not exists immunization_status text check (immunization_status in ('part_b', 'part_a', 'religious', 'medical', 'pending')),
  add column if not exists immunization_expires date;
alter table public.settings add column if not exists forms_reminder_to uuid references public.profiles(id) on delete set null;
alter table public.todos add column if not exists ref text check (length(ref) <= 80);
create unique index if not exists todos_open_ref on public.todos (ref) where ref is not null and done_at is null;

-- One form's reminder for one child: made, moved to the new date, or taken away.
create or replace function public._form_reminder(p_student uuid, p_name text, p_kind text, p_expires date, p_keep boolean)
returns void language plpgsql security definer set search_path = public as '
declare
  r text := ''form-'' || p_kind || '':'' || p_student;
  what text := case p_kind when ''yellow'' then ''Physical (yellow form)'' else ''Immunization (blue form)'' end;
begin
  if p_expires is null or not p_keep then
    delete from public.todos where ref = r and done_at is null;
    return;
  end if;
  update public.todos set due_on = p_expires, title = left(what || '' expires: '' || p_name, 160)
   where ref = r and done_at is null;
  if found then return; end if;
  -- Checked off already for this same date: don''t remind again.
  if exists (select 1 from public.todos where ref = r and due_on = p_expires) then return; end if;
  insert into public.todos (title, notes, assigned_to, due_on, repeat, remind_days, ref, created_by)
  values (left(what || '' expires: '' || p_name, 160),
          ''Ask the family for a new one, then put the new date on the child''''s page (Enrollment → the child → Documents).'',
          (select forms_reminder_to from public.settings limit 1), p_expires, ''none'', 30, r, auth.uid());
end';

create or replace function public.students_form_reminders()
returns trigger language plpgsql security definer set search_path = public as '
declare
  keep boolean := new.status in (''enrolled'', ''waitlist'');
begin
  if tg_op = ''INSERT'' or new.physical_expires is distinct from old.physical_expires or new.status is distinct from old.status
     or new.name is distinct from old.name then
    perform public._form_reminder(new.id, new.name, ''yellow'', new.physical_expires, keep);
  end if;
  if tg_op = ''INSERT'' or new.immunization_expires is distinct from old.immunization_expires or new.status is distinct from old.status
     or new.immunization_status is distinct from old.immunization_status or new.name is distinct from old.name then
    perform public._form_reminder(new.id, new.name, ''blue'', new.immunization_expires,
                                  keep and coalesce(new.immunization_status, ''part_b'') = ''part_b'');
  end if;
  return null;
end';
drop trigger if exists students_form_reminders on public.students;
create trigger students_form_reminders after insert or update of physical_expires, immunization_expires, immunization_status, status, name
  on public.students for each row execute function public.students_form_reminders();

revoke execute on function public._form_reminder(uuid, text, text, date, boolean) from public, anon, authenticated;
