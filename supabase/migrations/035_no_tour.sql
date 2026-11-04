-- Creativa CRM — "No tour needed" for a returning or former family (Pipeline → the family → Tour), and "New student" on
-- next year's registration (Enrollment → Registration), to count the new students starting.
-- Run once in the Supabase SQL editor, after 034_activity_rosters.sql. Safe to run again.
-- Also: a tour on a closed day is refused only from today on (an old tour isn't).
--
--   inquiries.no_tour   'returning' (a family with a child at the school now) or 'former' (a family that was here before);
--                       empty = needs a tour. Shown on the family's card. Tour emails and texts only go to booked tours,
--                       so these families get none.
--   registrations.new_student  new to the school that year (counted, and on the registration sheet's New Students
--                       Starting). Empty = worked out: on the waiting list, or starting in the new school year.
--   registration_mark_new  marks (or unmarks) a child as a new student for a school year.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.inquiries add column if not exists no_tour text check (no_tour in ('returning', 'former'));

-- Tours on closed days (032): only a tour booked from today on is refused; an old tour on what's now a closed day (or
-- a correction to one) stays possible.
create or replace function public.tour_not_on_closure()
returns trigger language plpgsql security definer set search_path = public as '
declare
  c text;
  d date;
begin
  if new.tour_at is not null and (tg_op = ''INSERT'' or new.tour_at is distinct from old.tour_at) then
    d := (new.tour_at at time zone ''America/New_York'')::date;
    if d >= (now() at time zone ''America/New_York'')::date then
      select name into c from public.school_closures where d between starts_on and ends_on order by starts_on limit 1;
      if c is not null then
        raise exception ''The school is closed that day (%). Pick another day for the tour.'', c using errcode = ''check_violation'';
      end if;
    end if;
  end if;
  return new;
end';

-- New students starting (Enrollment → Registration).
alter table public.registrations add column if not exists new_student boolean;

create or replace function public.registration_mark_new(p_student uuid, p_year text, p_next uuid, p_new boolean)
returns public.registrations language plpgsql security definer set search_path = public as '
declare
  r public.registrations;
begin
  if not public.can_edit_finance() then raise exception ''Only staff who record payments can change registrations''; end if;
  insert into public.registrations (school_year, student_id, next_classroom_id, status, new_student)
  values (p_year, p_student, p_next, case when p_new then ''returning'' else ''no_answer'' end, p_new)
  on conflict (school_year, student_id) do update set new_student = excluded.new_student
  returning * into r;
  return r;
end';
revoke execute on function public.registration_mark_new(uuid, text, uuid, boolean) from public, anon;
grant  execute on function public.registration_mark_new(uuid, text, uuid, boolean) to authenticated;
