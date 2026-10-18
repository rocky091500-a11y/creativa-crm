-- Creativa CRM — the school's tuition rates by class (from the Programs & Hours sheet), Kindergarten's school-year tuition,
-- and the bills the school pays every month (rent, utilities...).
-- Run once in the Supabase SQL editor, after 019_projection.sql. Safe to run again.
--
--   classrooms.rate_full         full time (7:00–3:00) and full time with after care (7:00–5:45), a week; for
--   classrooms.rate_after_care   Kindergarten, a school year (rate_per = 'school_year'). Set on Settings → Classes.
--   classrooms.registration_fee  the registration fee for the class, and Kindergarten's one-time book/technology fee.
--   classrooms.book_fee
--   student_finance.tuition_frequency   gains 'school_year' (Kindergarten: 10 payments, August to May, no summer).
--   student_finance.rate_note    why a child's rate isn't the class rate (a sibling discount...). Children with a rate
--                                that isn't their class's, and no note, are listed to check on Money → Projection.
--   bills                        what the school pays on set days every month: rent (twice a month), utilities... with the
--                                amount each time (an estimate when it changes), what a month's total is made of (base rent,
--                                CAM...), and from when. Money → Bills shows each one due that month, paid or not; the
--                                projection counts them on their days.
--   money_entries.bill_id        the payment of a bill: which bill, and the day it was due (bill_due). "Mark paid" adds it.
--   money_entries.bill_due
--   Starts each class with the 2026–27 rates, only where a class has none yet: 15 months & 2 years $280 / $300 a week,
--   Early and Late 3s $270 / $280, VPK $180 / $200 (with the VPK certificate), registration $300; Kindergarten
--   $9,700 / $10,700 a school year, registration $350 and the $350 book/technology fee.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.classrooms
  add column if not exists rate_full numeric(10,2) check (rate_full >= 0 and rate_full < 100000),
  add column if not exists rate_after_care numeric(10,2) check (rate_after_care >= 0 and rate_after_care < 100000),
  add column if not exists rate_per text not null default 'week' check (rate_per in ('week', 'school_year')),
  add column if not exists registration_fee numeric(10,2) check (registration_fee >= 0 and registration_fee < 100000),
  add column if not exists book_fee numeric(10,2) check (book_fee >= 0 and book_fee < 100000);

alter table public.student_finance drop constraint if exists student_finance_tuition_frequency_check;
alter table public.student_finance add constraint student_finance_tuition_frequency_check
  check (tuition_frequency in ('monthly', 'biweekly', 'weekly', 'school_year'));
alter table public.student_finance add column if not exists rate_note text check (length(rate_note) <= 200);

alter table public.inquiries drop constraint if exists inquiries_expected_freq_check;
alter table public.inquiries add constraint inquiries_expected_freq_check
  check (expected_freq in ('weekly', 'biweekly', 'monthly', 'school_year'));

-- The 2026–27 rates. Classes are found by name, ignoring dashes, apostrophes and spaces ("Early 3's" = "Early 3s").
with c as (
  select id, regexp_replace(lower(translate(name, '–', '-')), '[^a-z0-9-]', '', 'g') as k from public.classrooms where rate_full is null
), x (ks, r_full, r_ac, per, reg, book) as (values
  ('{15-17months,18-23months,18-24months,early2s,late2s,toddlers}'::text[], 280, 300, 'week', 300, null::numeric),
  ('{early3s,late3s}',                                                    270, 280, 'week', 300, null),
  ('{vpk}',                                                               180, 200, 'week', 300, null),
  ('{kindergarten,kinder}',                                              9700, 10700, 'school_year', 350, 350)
)
update public.classrooms cl
   set rate_full = x.r_full, rate_after_care = x.r_ac, rate_per = x.per, registration_fee = x.reg, book_fee = x.book
  from c, x
 where cl.id = c.id and c.k = any (x.ks);

-- ───────────────────────── bills paid every month ─────────────────────────
create table if not exists public.bills (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  name        text not null check (length(trim(name)) between 1 and 80),
  category    text not null check (length(trim(category)) between 1 and 60),
  party       text check (length(party) <= 120),
  amount      numeric(12,2) not null check (amount > 0 and amount < 10000000),
  days        int[] not null check (cardinality(days) between 1 and 4
                and days <@ '{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31}'::int[]),
  varies      boolean not null default false,
  parts       jsonb not null default '[]' check (jsonb_typeof(parts) = 'array' and jsonb_array_length(parts) <= 6),
  starts_on   date not null default current_date,
  ends_on     date,
  note        text check (length(note) <= 500),
  sort        int not null default 0,
  check (ends_on is null or ends_on >= starts_on)
);

alter table public.money_entries
  add column if not exists bill_id uuid references public.bills(id) on delete set null,
  add column if not exists bill_due date;
create unique index if not exists money_entries_one_per_bill_due on public.money_entries (bill_id, bill_due) where bill_id is not null;

alter table public.bills enable row level security;
revoke all on public.bills from anon;
drop policy if exists bills_select on public.bills;
drop policy if exists bills_write on public.bills;
create policy bills_select on public.bills for select to authenticated using (public.can_view_finance());
create policy bills_write on public.bills for all to authenticated using (public.can_edit_finance()) with check (public.can_edit_finance());

-- Added, changed and deleted bills show on the Changes page (012), under Tuition & payments.
do '
begin
  if to_regprocedure(''public.log_change()'') is not null then
    drop trigger if exists log_change on public.bills;
    create trigger log_change after insert or update or delete on public.bills
      for each row execute function public.log_change(''finance'');
  end if;
end';
