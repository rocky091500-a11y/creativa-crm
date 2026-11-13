-- Creativa CRM — the accountant's books: each Profit & Loss report from the accountant, line by line and month by month,
-- and each balance sheet, on Money → Accountant (with totals, gross profit and net income, to print or download).
-- Run once in the Supabase SQL editor, after 039_online_registration.sql. Safe to run again.
--
--   books_pl             one line of a report for one period (a month, or a whole year when that's all there is):
--                        income, cost of goods sold, expenses or other expenses; grp = the heading it's under ("Auto
--                        Expense", "Payroll expenses"…), line = the line. pay = what one person was paid.
--   books_pl_rows(year)  what Money → Accountant shows, for staff who see the money: everyone's pay by name only for
--                        staff who do payroll; for the others, one line per heading ("Pay, by person on Payroll").
--   books_bs             one line of a balance sheet on a date: assets, liabilities or equity (grp = "Bank Accounts"…).
--   books_bs_rows(year)  the balance sheets of a year, for staff who see the money.
--   books_pl_years()     the years there are reports for (profit & loss or balance sheet).
--   Reports are put in by the office's SQL files (each one replaces the periods it covers); nobody types them in.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create table if not exists public.books_pl (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  period_start  date not null,
  period_end    date not null,
  section       text not null check (section in ('income', 'cogs', 'expense', 'other_expense')),
  grp           text check (length(grp) <= 80),
  line          text not null check (length(line) between 1 and 80),
  amount        numeric(12,2) not null,
  pay           boolean not null default false,
  sort          int not null default 0,
  source        text check (length(source) <= 200),
  check (period_end >= period_start)
);
create unique index if not exists books_pl_one_line on public.books_pl (period_start, period_end, section, coalesce(grp, ''), line);
alter table public.books_pl enable row level security;
revoke all on public.books_pl from anon, authenticated;   -- read through books_pl_rows(); written by the SQL files

create or replace function public.books_pl_rows(p_year int)
returns table (period_start date, period_end date, section text, grp text, line text, amount numeric, pay boolean, sort int, source text)
language sql stable security definer set search_path = public as '
  select b.period_start, b.period_end, b.section, b.grp, b.line, b.amount, b.pay, b.sort, b.source
    from public.books_pl b
   where public.can_view_finance() and extract(year from b.period_start) = p_year and (not b.pay or public.can_payroll())
  union all
  select b.period_start, b.period_end, b.section, b.grp, ''Pay, by person on Payroll'', sum(b.amount), true, min(b.sort), min(b.source)
    from public.books_pl b
   where public.can_view_finance() and not public.can_payroll() and extract(year from b.period_start) = p_year and b.pay
   group by b.period_start, b.period_end, b.section, b.grp
   order by 8, 1
';
create table if not exists public.books_bs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  as_of       date not null,
  section     text not null check (section in ('asset', 'liability', 'equity')),
  grp         text check (length(grp) <= 80),
  line        text not null check (length(line) between 1 and 80),
  amount      numeric(12,2) not null,
  sort        int not null default 0,
  source      text check (length(source) <= 200)
);
create unique index if not exists books_bs_one_line on public.books_bs (as_of, section, coalesce(grp, ''), line);
alter table public.books_bs enable row level security;
revoke all on public.books_bs from anon, authenticated;   -- read through books_bs_rows(); written by the SQL files

create or replace function public.books_bs_rows(p_year int)
returns table (as_of date, section text, grp text, line text, amount numeric, sort int, source text)
language sql stable security definer set search_path = public as '
  select b.as_of, b.section, b.grp, b.line, b.amount, b.sort, b.source
    from public.books_bs b
   where public.can_view_finance() and extract(year from b.as_of) = p_year
   order by b.as_of, b.sort
';
drop function if exists public.books_pl_years();
create or replace function public.books_pl_years()
returns table (year int, periods int, last_end date, balance_sheets int)
language sql stable security definer set search_path = public as '
  select y.year, coalesce(p.periods, 0), p.last_end, coalesce(s.sheets, 0)
    from (select extract(year from period_start)::int as year from public.books_pl
          union select extract(year from as_of)::int from public.books_bs) y
    left join (select extract(year from period_start)::int as year, count(distinct (period_start, period_end))::int as periods,
                      max(period_end) as last_end from public.books_pl group by 1) p on p.year = y.year
    left join (select extract(year from as_of)::int as year, count(distinct as_of)::int as sheets from public.books_bs group by 1) s on s.year = y.year
   where public.can_view_finance()
   order by y.year desc
';
revoke execute on function public.books_pl_rows(int), public.books_bs_rows(int), public.books_pl_years() from public, anon;
grant execute on function public.books_pl_rows(int), public.books_bs_rows(int), public.books_pl_years() to authenticated;
