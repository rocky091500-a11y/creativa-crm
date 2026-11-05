-- Creativa CRM — one name per program, so the Pipeline, its filter and the reports don't split one class in two
-- ("late 2s" and "Late 2s", "Late 3's Ms. Rivera" and "Late 3s", "18-23 months (Ms.Kim)" and "18–23 months").
-- Run once in the Supabase SQL editor, after 037_staff_birthdays.sql. Safe to run again.
--
--   _program_canon(p)          the age group in any spelling (Early Twos, late 2's, 18-23 months (Ms. Kim), Pre-K…) gives
--                              the class's name as it is on Settings → Classes; only a teacher's name ("Ms. Rivera") gives
--                              her class. Anything else is kept as written. The CRM shows the teachers next to it
--                              ("Late 3s · Ms. Rivera & Ms. Stone").
--   inquiries_program_canon    every program saved on a family's card (website forms and the office) goes through it.
--   the cards already saved     cleaned up once, without changing when each card was last updated (that date counts
--                              "enrolled this month" on Today).
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create or replace function public._program_canon(p text)
returns text language plpgsql stable security definer set search_path = public as '
declare
  t text := lower(coalesce(p, ''''));
  label text;
  c record;
  n text;
begin
  if p is null or btrim(p) = '''' then return null; end if;
  label := case
    when t ~ ''15[^0-9]*17''          then ''15–17 months''
    when t ~ ''18[^0-9]*23''          then ''18–23 months''
    when t ~ ''early *(2|two)''       then ''Early 2s''
    when t ~ ''late *(2|two)''        then ''Late 2s''
    when t ~ ''early *(3|three)''     then ''Early 3s''
    when t ~ ''late *(3|three)''      then ''Late 3s''
    when t ~ ''vpk|pre-?k''           then ''VPK''
    when t ~ ''kinder''               then ''Kindergarten''
    when t ~ ''bloom''                then ''Bloom''
    when t ~ ''not sure''             then ''Not sure''
  end;
  if label is null then
    -- Only a teacher''s name: her class.
    for c in select name, teachers from public.classrooms where coalesce(teachers, '''') <> '''' order by sort, name loop
      foreach n in array regexp_split_to_array(lower(c.teachers), ''&|,|/| and '') loop
        n := btrim(regexp_replace(btrim(n), ''^(ms|mrs|miss|mr|teacher)[. ]*'', ''''));
        n := regexp_replace(n, ''[^a-záéíóúñü ]'', '''', ''g'');
        if length(n) >= 3 and t ~ (''(^|[^a-z])'' || n || ''([^a-z]|$)'') then return c.name; end if;
      end loop;
    end loop;
    return left(btrim(p), 100);
  end if;
  -- The class as it is spelled on Settings → Classes (18-23 or 18–23).
  return coalesce((select x.name from public.classrooms x
                    where regexp_replace(lower(x.name), ''[^a-z0-9]'', '''', ''g'') = regexp_replace(lower(label), ''[^a-z0-9]'', '''', ''g'')
                    order by x.sort limit 1), label);
end';
revoke execute on function public._program_canon(text) from public, anon, authenticated;

create or replace function public.inquiries_program_canon()
returns trigger language plpgsql security definer set search_path = public as '
begin
  new.program := public._program_canon(new.program);
  return new;
end';
drop trigger if exists inquiries_program_canon on public.inquiries;
create trigger inquiries_program_canon before insert or update of program on public.inquiries
  for each row execute function public.inquiries_program_canon();
revoke execute on function public.inquiries_program_canon() from public, anon, authenticated;

-- The cards already saved, once.
begin;
alter table public.inquiries disable trigger inquiries_touch;
update public.inquiries set program = public._program_canon(program) where program is distinct from public._program_canon(program);
alter table public.inquiries enable trigger inquiries_touch;
commit;
