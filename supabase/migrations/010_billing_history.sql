-- Creativa CRM — balances from the billing system's "Balance Summary (Family)" sheets, kept as history.
-- Run once in the Supabase SQL editor, after 001–009 (in that order). Safe to run again.
--
--   billing_history   one row per family per sheet: what the family owed on the day the sheet was printed
--                     (as_of), for the tuition period written on it. Kept for reference only: it changes no
--                     invoice, payment or annual statement. Finance access only, like invoices.
--                     family_account matches students.family_account (the billing system's family name).
--
-- The rows themselves are loaded with a private SQL file (family names never go in this repository).
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create table if not exists public.billing_history (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  as_of           date not null,
  period_start    date,
  period_end      date,
  customer        text not null check (length(customer) between 1 and 120),   -- as printed on the sheet
  family_account  text check (length(family_account) <= 80),
  balance         numeric(10,2) not null check (balance > -100000 and balance < 100000),   -- negative = credit
  note            text check (length(note) <= 300),
  unique (as_of, customer)
);
create index if not exists billing_history_family_idx on public.billing_history (upper(family_account));

alter table public.billing_history enable row level security;
revoke all on public.billing_history from anon;
drop policy if exists billing_history_select on public.billing_history;
drop policy if exists billing_history_insert on public.billing_history;
drop policy if exists billing_history_update on public.billing_history;
drop policy if exists billing_history_delete on public.billing_history;
create policy billing_history_select on public.billing_history for select to authenticated using (public.can_view_finance());
create policy billing_history_insert on public.billing_history for insert to authenticated with check (public.can_edit_finance());
create policy billing_history_update on public.billing_history for update to authenticated
  using (public.can_edit_finance()) with check (public.can_edit_finance());
create policy billing_history_delete on public.billing_history for delete to authenticated using (public.can_edit_finance());
