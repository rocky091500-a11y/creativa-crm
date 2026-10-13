-- Migration 006: biweekly invoices, payments applied to invoices, contacts, Step Up (pending).
-- Runs after the other tests (users from db.test.sql: owner = admin, teacher = staff, books = finance edit).
\set ON_ERROR_STOP on
set client_min_messages = notice;
create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as 'begin
  if not coalesce(cond, false) then raise exception ''FAIL: %'', label; end if;
  raise notice ''ok - %'', label; end';
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as 'begin
  perform set_config(''request.jwt.claim.sub'', coalesce(uid::text, ''''), false); end';
\ir ../supabase/migrations/006_billing_contacts.sql
select pg_temp.as_user(null);

-- children for billing
insert into public.students (name, classroom_id, status, start_date)
  select x.n, c.id, x.st, x.sd::date
    from (values ('Bill Private', 'enrolled', null), ('Bill FES', 'enrolled', null), ('Bill NotInvoiced', 'enrolled', null),
                 ('Bill StepUp', 'enrolled', null), ('Bill NoRate', 'enrolled', null), ('Bill Late Start', 'enrolled', '2026-11-02'),
                 ('Bill Left', 'withdrawn', null), ('Bill Weekly', 'enrolled', null)) as x(n, st, sd)
    cross join (select id from public.classrooms where name = 'VPK') c;
update public.students set withdrawn_on = '2026-10-10' where name = 'Bill Left';
insert into public.student_finance (student_id, funding, tuition_amount, tuition_frequency, billing_program, bill_family)
  select s.id, x.f::text[], x.amt, x.freq, x.prog, x.bill
    from (values ('Bill Private', '{}', 560, 'biweekly', 'Preschool Full-Time', true),
                 ('Bill FES', '{fes_ua}', 400, 'biweekly', 'VPK Full Time', true),
                 ('Bill NotInvoiced', '{fes_ua}', 360, 'biweekly', 'VPK Full Time', false),
                 ('Bill StepUp', '{stepup_pending}', 500, 'biweekly', null, true),
                 ('Bill NoRate', '{}', null, 'biweekly', null, true),
                 ('Bill Late Start', '{}', 600, 'biweekly', null, true),
                 ('Bill Left', '{}', 560, 'biweekly', null, true),
                 ('Bill Weekly', '{}', 270, 'weekly', null, true)) as x(n, f, amt, freq, prog, bill)
    join public.students s on s.name = x.n;

-- ── generating a period ──
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- staff, no finance
do 'begin perform public.create_period_invoices(''2026-10-05''); raise exception ''FAIL: staff created invoices'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
select pg_temp.ok((select count(*) = 0 from public.invoices), 'staff cannot see invoices');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');   -- finance editor
do 'begin perform public.create_period_invoices(''2026-10-06''); raise exception ''FAIL: Tuesday accepted'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
select pg_temp.ok(public.create_period_invoices('2026-10-05') = 4, 'Oct 5: bills private, FES, weekly (x2) and the child who left Oct 10');
select pg_temp.ok(public.create_period_invoices('2026-10-05') = 0, 'running it again bills nobody twice');
select pg_temp.ok((select string_agg(s.name || '=' || i.amount || '/' || i.description, ', ' order by s.name)
                     from public.invoices i join public.students s on s.id = i.student_id where i.period_start = '2026-10-05')
                  = 'Bill FES=400.00/VPK Full Time, Bill Left=560.00/Tuition, Bill Private=560.00/Preschool Full-Time, Bill Weekly=540.00/Tuition',
                  'amounts and descriptions; no Step Up (pending), no rate, not-invoiced FES, or later starter');
select pg_temp.ok(public.create_period_invoices('2026-10-19') = 3, 'Oct 19: the child who left is no longer billed');
select pg_temp.ok(public.create_period_invoices('2026-11-02') = 4, 'Nov 2: the late starter joins');
select pg_temp.ok((select due_date = invoice_date and invoice_date = period_start from public.invoices limit 1), 'due the billing Monday');

-- ── payments against invoices ──
insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, payer, method, created_by)
  select i.student_id, i.id, '2026-10-06', '2026-10-01', 560, 'parent', 'zelle', auth.uid()
    from public.invoices i join public.students s on s.id = i.student_id where s.name = 'Bill Private' and i.period_start = '2026-10-05';
insert into public.payments (student_id, paid_on, covers_month, amount, payer, method, created_by, note)
  select id, '2026-10-07', '2026-10-01', 35, 'parent', 'zelle', auth.uid(), 'credit' from public.students where name = 'Bill FES';
do 'begin
  insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, created_by)
    select (select id from public.students where name = ''Bill FES''), i.id, ''2026-10-06'', ''2026-10-01'', 10, auth.uid()
      from public.invoices i join public.students s on s.id = i.student_id where s.name = ''Bill Private'' limit 1;
  raise exception ''FAIL: paid another child''''s invoice'';
exception when check_violation then null; end';
select pg_temp.ok((select count(*) = 1 from public.payments p join public.invoices i on i.id = p.invoice_id), 'payment applied to its invoice');
select pg_temp.ok((select count(*) = 1 from public.payments where invoice_id is null and note = 'credit'), 'a payment can sit as a credit');
-- deleting an invoice keeps the money as a credit
delete from public.invoices i using public.students s where s.id = i.student_id and s.name = 'Bill Private' and i.period_start = '2026-10-05';
select pg_temp.ok((select invoice_id is null from public.payments p join public.students s on s.id = p.student_id where s.name = 'Bill Private'),
                  'deleting an invoice turns its payment into a credit');
-- a voided invoice frees the period
update public.invoices i set void = true from public.students s where s.id = i.student_id and s.name = 'Bill FES' and i.period_start = '2026-10-19';
select pg_temp.ok(public.create_period_invoices('2026-10-19') = 1, 'void invoice can be re-issued');
-- fees
insert into public.invoices (student_id, kind, description, invoice_date, due_date, amount)
  select id, 'fee', 'Activity Fee', '2026-08-13', '2026-09-12', 350 from public.students where name = 'Bill StepUp';
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 1 from public.invoices where kind = 'fee'), 'fee invoices need no period');
do 'begin insert into public.invoices (student_id, description, invoice_date, due_date, amount)
  select id, ''x'', current_date, current_date, 1 from public.students limit 1; raise exception ''FAIL: tuition without period'';
exception when check_violation then null; end';

-- view-only finance sees, cannot change
update public.profiles set finance = 'view' where email = 'books@creativaacademy.com';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok((select count(*) > 0 from public.invoices), 'view-only finance sees invoices');
update public.invoices set amount = 1;
do 'begin perform public.create_period_invoices(''2026-11-16''); raise exception ''FAIL: view-only created invoices'';
exception when others then if sqlerrm like ''FAIL:%'' then raise; end if; end';
reset role;
select pg_temp.as_user(null);
select pg_temp.ok((select count(*) = 0 from public.invoices where amount = 1), 'view-only cannot change invoices');
update public.profiles set finance = 'edit' where email = 'books@creativaacademy.com';

-- ── contacts ──
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');   -- regular staff keep contacts
insert into public.student_contacts (student_id, role, relationship, first_name, last_name, cell_phone)
  select id, 'primary', 'Mother', 'Ana', 'Private', '(305) 555-0100' from public.students where name = 'Bill Private';
insert into public.student_contacts (student_id, role, relationship, first_name, last_name)
  select id, 'emergency', 'Aunt', 'Dalia', 'Private' from public.students where name = 'Bill Private';
update public.student_contacts set sms_phone = '(305) 555-0100' where first_name = 'Ana';
select pg_temp.ok((select count(*) = 2 from public.student_contacts), 'staff add and edit contacts');
do 'begin insert into public.student_contacts (student_id, role) select id, ''cousin'' from public.students limit 1;
  raise exception ''FAIL: bad role''; exception when check_violation then null; end';
reset role;
set role anon;
do 'begin perform count(*) from public.student_contacts; raise exception ''FAIL: anon reads contacts'';
exception when insufficient_privilege then null; end';
do 'begin perform count(*) from public.invoices; raise exception ''FAIL: anon reads invoices'';
exception when insufficient_privilege then null; end';
reset role;
delete from public.students where name = 'Bill NoRate';
select pg_temp.ok(true, 'a child with no invoices can still be deleted');
do 'begin delete from public.students where name = ''Bill FES''; raise exception ''FAIL: deleted a child with invoices'';
exception when foreign_key_violation then null; end';
select pg_temp.ok((select '{stepup_pending}'::text[] <@ funding from public.student_finance f join public.students s on s.id = f.student_id
                   where s.name = 'Bill StepUp'), 'Step Up (pending) is a funding type');

\echo ALL BILLING TESTS PASSED
