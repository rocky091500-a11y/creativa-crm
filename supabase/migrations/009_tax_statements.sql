-- Creativa CRM — the school's tax ID on receipts and on the annual statements families ask for at tax time.
-- Run once in the Supabase SQL editor, after 001–008 (in that order). Safe to run again.
--
--   settings.receipt_tax_id   the school's federal tax ID (EIN). Printed on every receipt and on annual statements
--                             (families need it, with the amount paid, for the child and dependent care credit).
--                             Set it on Settings → Receipts.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

alter table public.settings add column if not exists receipt_tax_id text check (length(receipt_tax_id) <= 20);
