-- Creativa CRM — money in and out (Money page), the Child Care Food Program, and the office's to-do list.
-- Run once in the Supabase SQL editor, after 016_paychecks.sql. Safe to run again.
--
--   money_entries  money in or out that isn't already in the CRM: program deposits, food and supply receipts, rent,
--                  utilities... (tuition payments and paychecks are counted from their own pages, never typed twice).
--                  ccfp_col puts a receipt on the food program's Monthly Record of Operating Expenditures (its column
--                  d–j); in_totals = false is for lines that are only for that record, like food service labor that is
--                  already counted in payroll.
--   ccfp_claims    the Child Care Food Program claim for each month: meals claimed, earnings, costs, and when it was
--                  submitted and paid. A paid claim counts as money in; a submitted one as money coming in.
--   todos          what the office has to do: a due date, who it's for, whether it repeats (every month...), and how
--                  many days before it shows up as a reminder on that person's Today page and To do tab in the CRM.
--                  Starts with the monthly food program claim and the SR and VPK attendance, due the 1st.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create or replace function public.can_office()   -- admins, and staff who record payments or do payroll
returns boolean language sql stable security definer set search_path = public as '
  select exists (select 1 from public.profiles where id = auth.uid() and active and (role = ''admin'' or finance = ''edit'' or payroll));
';

-- ───────────────────────── money in and out ─────────────────────────
create table if not exists public.money_entries (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  on_date     date not null,
  kind        text not null check (kind in ('in', 'out')),
  category    text not null check (length(trim(category)) between 1 and 60),
  amount      numeric(12,2) not null check (amount > 0 and amount < 10000000),
  party       text check (length(party) <= 120),
  reference   text check (length(reference) <= 80),
  note        text check (length(note) <= 500),
  ccfp_col    text check (ccfp_col in ('food', 'labor', 'services', 'supplies', 'equipment', 'transport', 'other')),
  in_totals   boolean not null default true
);
create index if not exists money_entries_date_idx on public.money_entries (on_date);

-- ───────────────────────── Child Care Food Program ─────────────────────────
create table if not exists public.ccfp_claims (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id) on delete set null default auth.uid(),
  claim_month       date not null unique check (extract(day from claim_month) = 1),
  operating_days    int check (operating_days between 0 and 31),
  daily_avg         int check (daily_avg >= 0),
  enrolled_free     int check (enrolled_free >= 0),
  enrolled_reduced  int check (enrolled_reduced >= 0),
  enrolled_paid     int check (enrolled_paid >= 0),
  breakfasts        int not null default 0 check (breakfasts >= 0),
  am_snacks         int not null default 0 check (am_snacks >= 0),
  lunches           int not null default 0 check (lunches >= 0),
  pm_snacks         int not null default 0 check (pm_snacks >= 0),
  suppers           int not null default 0 check (suppers >= 0),
  eve_snacks        int not null default 0 check (eve_snacks >= 0),
  meal_earnings     numeric(10,2) check (meal_earnings >= 0),
  cash_in_lieu      numeric(10,2) check (cash_in_lieu >= 0),
  adjustments       numeric(10,2) not null default 0,
  food_cost         numeric(10,2) check (food_cost >= 0),
  non_food_cost     numeric(10,2) check (non_food_cost >= 0),
  admin_cost        numeric(10,2) check (admin_cost >= 0),
  status            text not null default 'draft' check (status in ('draft', 'submitted', 'paid')),
  submitted_on      date,
  paid_on           date,
  paid_amount       numeric(10,2) check (paid_amount >= 0),
  note              text check (length(note) <= 500)
);

alter table public.money_entries enable row level security;
alter table public.ccfp_claims enable row level security;
revoke all on public.money_entries, public.ccfp_claims from anon;
drop policy if exists money_entries_select on public.money_entries;
drop policy if exists money_entries_write on public.money_entries;
drop policy if exists ccfp_claims_select on public.ccfp_claims;
drop policy if exists ccfp_claims_write on public.ccfp_claims;
create policy money_entries_select on public.money_entries for select to authenticated using (public.can_view_finance());
create policy money_entries_write on public.money_entries for all to authenticated
  using (public.can_edit_finance()) with check (public.can_edit_finance());
create policy ccfp_claims_select on public.ccfp_claims for select to authenticated using (public.can_view_finance());
create policy ccfp_claims_write on public.ccfp_claims for all to authenticated
  using (public.can_edit_finance()) with check (public.can_edit_finance());

-- ───────────────────────── to-do list ─────────────────────────
create table if not exists public.todos (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  created_by   uuid references public.profiles(id) on delete set null default auth.uid(),
  title        text not null check (length(trim(title)) between 1 and 160),
  notes        text check (length(notes) <= 1000),
  assigned_to  uuid references public.profiles(id) on delete set null,
  due_on       date not null,
  repeat       text not null default 'none' check (repeat in ('none', 'weekly', 'monthly', 'yearly')),
  remind_days  int not null default 7 check (remind_days between 0 and 60),
  done_at      timestamptz,
  done_by      uuid references public.profiles(id) on delete set null,
  next_id      uuid
);
create index if not exists todos_open_idx on public.todos (due_on) where done_at is null;

alter table public.todos enable row level security;
revoke all on public.todos from anon;
drop policy if exists todos_all on public.todos;
create policy todos_all on public.todos for all to authenticated using (public.can_office()) with check (public.can_office());

-- Check one off. A repeating one comes back for its next date; returns that one's id.
create or replace function public.todo_done(p_id uuid)
returns uuid language plpgsql security definer set search_path = public as '
declare
  t public.todos;
  v_next uuid;
begin
  if not public.can_office() then raise exception ''Only the office can check off to-dos''; end if;
  update public.todos set done_at = now(), done_by = auth.uid() where id = p_id and done_at is null returning * into t;
  if not found or t.repeat = ''none'' then return null; end if;
  insert into public.todos (created_by, title, notes, assigned_to, due_on, repeat, remind_days)
  values (t.created_by, t.title, t.notes, t.assigned_to,
          (t.due_on + case t.repeat when ''weekly'' then interval ''7 days'' when ''monthly'' then interval ''1 month''
                                     else interval ''1 year'' end)::date,
          t.repeat, t.remind_days)
  returning id into v_next;
  update public.todos set next_id = v_next where id = p_id;
  return v_next;
end';

-- Undo a check-off: it's open again, and the next one it made (if nobody touched it) goes away.
create or replace function public.todo_undone(p_id uuid)
returns void language plpgsql security definer set search_path = public as '
declare
  t public.todos;
begin
  if not public.can_office() then raise exception ''Only the office can change to-dos''; end if;
  select * into t from public.todos where id = p_id;
  if t.next_id is not null then delete from public.todos where id = t.next_id and done_at is null; end if;
  update public.todos set done_at = null, done_by = null, next_id = null where id = p_id;
end';

-- The monthly reports (only when there isn't one with the same name still open).
insert into public.todos (title, notes, due_on, repeat, remind_days, created_by)
select x.title, x.notes, (date_trunc('month', (now() at time zone 'America/New_York')) + interval '1 month')::date, 'monthly', 7, null
  from (values
    ('Submit the Child Care Food Program claim', 'Florida Department of Health: last month''s meals claimed and its food and non-food costs. Then record it on Money → Food program.'),
    ('Submit School Readiness (SR) attendance', 'ELC of Miami-Dade/Monroe portal: last month''s SR attendance roster. Check afterwards that it was accepted, not rejected.'),
    ('Submit VPK attendance', 'ELC portal: last month''s VPK attendance roster.')
  ) as x(title, notes)
 where not exists (select 1 from public.todos t where t.title = x.title and t.done_at is null);

-- Changes page (012): money, the food program and to-dos under Tuition & payments.
do '
declare
  t text;
begin
  if to_regprocedure(''public.log_change()'') is not null then
    foreach t in array array[''money_entries'', ''ccfp_claims'', ''todos''] loop
      execute format(''drop trigger if exists log_change on public.%I'', t);
      execute format(''create trigger log_change after insert or update or delete on public.%I for each row execute function public.log_change(%L)'', t, ''finance'');
    end loop;
  end if;
end';

revoke execute on function public.can_office() from public, anon;
grant  execute on function public.can_office() to authenticated;
revoke execute on function public.todo_done(uuid) from public, anon;
revoke execute on function public.todo_undone(uuid) from public, anon;
grant  execute on function public.todo_done(uuid) to authenticated;
grant  execute on function public.todo_undone(uuid) to authenticated;
