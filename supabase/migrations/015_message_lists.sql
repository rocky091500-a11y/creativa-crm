-- Creativa CRM — lists of families to text (like TextMagic's lists, but kept up to date by the CRM), and who in a
-- family gets group texts. Run once in the Supabase SQL editor, after 014_message_templates.sql. Safe to run again.
--
--   message_lists        a name and who is on it: children in some classes (none = every class) with some funding
--                        (none = any), plus families added by hand and other people (a name and a cell number).
--                        A child who changes class or funding moves lists by themselves. Starts with the school's
--                        lists (FES, Kinder, 1st floor, 2nd floor, VPK) and a few more; edit or delete any of them.
--   student_contacts.group_texts   whether this contact gets texts sent to lists, classes or all families.
--                        Empty = the usual: the Primary contact yes, everyone else no.
--   Also adds a "Missing paperwork" saved message (014) that uses the {missing} block.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.student_contacts add column if not exists group_texts boolean;

create table if not exists public.message_lists (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) between 1 and 60),
  classes       uuid[] not null default '{}',
  funding       text[] not null default '{}'
                check (funding <@ array['private','sr','sr_bpiece','fes_ua','fes_eo','vpk','stepup_pending']::text[]),
  both_parents  boolean not null default false,
  families      uuid[] not null default '{}',
  extra         jsonb not null default '[]' check (jsonb_typeof(extra) = 'array' and jsonb_array_length(extra) <= 200),
  sort          int not null default 0,
  created_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.message_lists enable row level security;
revoke all on public.message_lists from anon;
drop policy if exists message_lists_select on public.message_lists;
drop policy if exists message_lists_insert on public.message_lists;
drop policy if exists message_lists_update on public.message_lists;
drop policy if exists message_lists_delete on public.message_lists;
create policy message_lists_select on public.message_lists for select to authenticated using (public.can_message());
create policy message_lists_insert on public.message_lists for insert to authenticated with check (public.can_message());
create policy message_lists_update on public.message_lists for update to authenticated
  using (public.can_message()) with check (public.can_message());
create policy message_lists_delete on public.message_lists for delete to authenticated using (public.can_message());

-- The school's lists (only when there are none yet). Classes are found by name, ignoring dashes, apostrophes and
-- spaces ("Early 2's" = "Early 2s"); a list whose classes aren't found is left out rather than made for everyone.
with c as (
  select id, regexp_replace(lower(translate(name, '–', '-')), '[^a-z0-9-]', '', 'g') as k from public.classrooms
), x (name, ks, funding, sort) as (values
  ('FES Moms',                    '{}'::text[],                    '{fes_ua,fes_eo}'::text[], 1),
  ('Kinder Moms',                 '{kindergarten}',                '{}',                      2),
  ('Moms 1st Floor',              '{18-23months,early2s,late2s}',  '{}',                      3),
  ('Moms 2nd Floor',              '{early3s,late3s}',              '{}',                      4),
  ('VPK Moms',                    '{vpk}',                         '{}',                      5),
  ('School Readiness families',   '{}',                            '{sr,sr_bpiece}',          6),
  ('Step Up (pending) families',  '{}',                            '{stepup_pending}',        7),
  ('Private pay families',        '{}',                            '{private}',               8)
)
insert into public.message_lists (name, classes, funding, sort, created_by)
select x.name, coalesce((select array_agg(c.id) from c where c.k = any (x.ks)), '{}'), x.funding, x.sort, null
  from x
 where not exists (select 1 from public.message_lists)
   and (cardinality(x.ks) = 0 or exists (select 1 from c where c.k = any (x.ks)));

-- A saved message for the "Families missing paperwork" texts (if 014 was run and it isn't there yet).
do '
begin
  if to_regclass(''public.message_templates'') is not null
     and not exists (select 1 from public.message_templates where name = ''Missing paperwork'') then
    insert into public.message_templates (name, body, sort, created_by) values (''Missing paperwork'',
      ''Hi {parent}, this is {me} from Creativa Academy. We are still missing {missing}. Please bring it to the front desk when you can. Thank you!'',
      (select coalesce(max(sort), 0) + 1 from public.message_templates), null);
  end if;
end';

-- Saved, changed and deleted lists show on the Changes page (012), under Tuition & payments.
do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.message_lists;
    create trigger log_change after insert or update or delete on public.message_lists
      for each row execute function public.log_change(''finance'');
  end if;
end';
