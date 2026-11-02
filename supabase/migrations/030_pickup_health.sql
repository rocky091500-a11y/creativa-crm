-- Creativa CRM — who can pick up each child, children's allergies, and the medicine kept at school with its expiration
-- (Enrollment → Pick-up, and Allergies & medicine). Run once in the Supabase SQL editor, after 029. Safe to run again.
--
--   student_contacts.role   gains 'pickup' (Authorized pick-up): someone besides the parents who may pick the child up,
--                           with first and last name and a phone. The Pick-up list shows the parents (Primary and
--                           Secondary) and these people. 'emergency' is now just Emergency contact (not on that list).
--   students.allergies      what the child is allergic to (food, medicine, bees...), empty when nothing is known.
--   student_medications     medicine a family leaves at school (an EpiPen, an inhaler...): what it's for and how
--                           it's given, and when it expires. Today warns when one has expired or expires within 30 days.
--                           All staff see and change these, like contacts.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.student_contacts drop constraint if exists student_contacts_role_check;
alter table public.student_contacts add constraint student_contacts_role_check
  check (role in ('primary', 'secondary', 'pickup', 'emergency'));

alter table public.students add column if not exists allergies text check (length(allergies) <= 300);

create table if not exists public.student_medications (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  student_id  uuid not null references public.students(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 120),
  details     text check (length(details) <= 300),
  expires_on  date
);
create index if not exists student_medications_student_idx on public.student_medications (student_id);

alter table public.student_medications enable row level security;
revoke all on public.student_medications from anon;
drop policy if exists student_medications_select on public.student_medications;
drop policy if exists student_medications_write on public.student_medications;
create policy student_medications_select on public.student_medications for select to authenticated using (public.is_staff());
create policy student_medications_write on public.student_medications for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Changes show on the Changes page (012), under Enrollment, and on the child's page.
do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.student_medications;
    create trigger log_change after insert or update or delete on public.student_medications
      for each row execute function public.log_change(''enrollment'');
  end if;
end';
