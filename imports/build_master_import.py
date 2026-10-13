"""Build the SQL import of the CRM master data (students, contacts, invoices, payments, credits).

Usage: python3 -I imports/build_master_import.py data/creativa-crm-master.json data/creativa-crm-master.md > import.sql

Run the output in the Supabase SQL editor after migrations 001-007. It is safe to run twice: rows that
are already there are left alone, and blanks in the master data never erase what the CRM already has.
The data files hold real family information: they live in data/ (ignored by git) and must never be
committed — this repository is public and Netlify publishes its root.
"""
import csv, io, json, re, sys
from datetime import date

CLASSROOM = {"18-23 months": "18–23 months", "Early 2's": "Early 2s", "Late 2's": "Late 2s", "Early 3's": "Early 3s",
             "Late 3's": "Late 3s", "VPK": "VPK", "Kindergarten": "Kindergarten"}
FUNDING = {"FES": "fes", "School Readiness": "sr", "Step Up (pending eligibility)": "stepup_pending", "Private Pay": ""}
ROLE = {"Primary": "primary", "Secondary": "secondary", "Emergency/Authorized": "emergency"}
METHOD = {"zelle": "zelle", "cash": "cash", "check": "check", "card": "card", "ach": "ach"}


def q(v):
    if v is None or v == "":
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def md_blocks(md):
    """{heading: [csv/json text, ...]} for every fenced block, keyed by the nearest heading above it."""
    out, heading = {}, ""
    for m in re.finditer(r"^(#{2,3} [^\n]+)$|^```(\w+)\n(.*?)^```", md, re.M | re.S):
        if m.group(1):
            heading = m.group(1).lstrip("# ").strip()
        else:
            out.setdefault(heading, []).append((m.group(2), m.group(3)))
    return out


def csv_rows(text):
    return list(csv.DictReader(io.StringIO(text)))


def values(rows, cols):
    return ",\n".join("  (" + ", ".join(q(r[c]) for c in cols) + ")" for r in rows)


def main(json_path, md_path):
    data = json.load(open(json_path, encoding="utf-8"))
    blocks = md_blocks(open(md_path, encoding="utf-8").read())
    rules = json.loads(next(t for k, t in blocks["0. Business rules for the CRM"] if k == "json"))
    as_of = re.search(r"as of (\d{1,2})/(\d{1,2})/(\d{4})", open(md_path, encoding="utf-8").readline())
    as_of = date(int(as_of.group(3)), int(as_of.group(1)), int(as_of.group(2))).isoformat()
    unapplied = csv_rows(blocks["5. Unapplied payments"][0][1])
    ar = csv_rows(blocks["6. Open A/R as of 10/09/2026 — $1,625.00"][0][1])
    withdrawn = csv_rows(blocks["Withdrawn"][0][1])
    anchor = rules["billing"]["schedule_2026"][0]
    period_days = rules["billing"]["period_length_days"]

    students = []
    for s in data["students"]:
        docs = all(s[k] == "received" for k in ("enrollment_packet", "blue_form", "yellow_form", "birth_certificate"))
        students.append({
            "name": f"{s['first_name']} {s['last_name']}".strip(),
            "classroom": CLASSROOM[s["classroom"]],
            "program": s["program"] or None,
            "funding": FUNDING[s["funding_type"]],
            "award": str(s["scholarship_id"]) if s["scholarship_id"] != "" else None,
            "rate": float(s["biweekly_rate"]) if s["biweekly_rate"] != "" else None,
            "rbt": {"yes": "yes", "in process": "in_process"}.get(s["rbt"]),
            "therapy": s["therapy"] or None,
            "start": s["start_date"] or None,
            "docs": docs,
            "bill_family": s["billing_status"] != "fes_not_invoiced",
            "notes": s["notes"] or None,
        })
    primary = {p["child"]: p for p in data["parents"] if p["role"] == "Primary"}
    accounts = {p["child"]: p["family_account"] for p in data["parents"]}
    for s in students:
        p = primary.get(s["name"])
        s["family"] = accounts.get(s["name"])
        s["parent"] = f"{p['first_name']} {p['last_name']}".strip() if p else None
        s["phone"] = (p["cell_phone"] or p["sms_phone"] or p["work_phone"] or p["home_phone"]) if p else None
    contacts = [{"child": p["child"], "role": ROLE[p["role"]], "rel": p["relationship"] or None,
                 "first": p["first_name"] or None, "last": p["last_name"] or None, "cell": p["cell_phone"] or None,
                 "work": p["work_phone"] or None, "home": p["home_phone"] or None, "sms": p["sms_phone"] or None,
                 "notes": p["notes"] or None} for p in data["parents"]]
    invoices = [{"child": i["child"], "program": i["program"], "amount": float(i["amount"]), "paid": i["paid_by"] or None}
                for i in data["invoices_2026_10_05"]]
    tuition_items = {i["program"].upper() for i in invoices} | {"SCHOOL READINESS"}
    fees = [{"child": r["child"], "item": r["item"], "inv": r["invoice_date"], "due": r["due_date"], "amount": float(r["amount"])}
            for r in ar if r["child"] and float(r["amount"]) > 0 and r["item"].upper() not in tuition_items]
    credits = [{"child": r["children"].split(";")[0].strip(), "method": METHOD.get(r["method"].lower(), "other"),
                "date": r["date"], "amount": float(r["amount"]),
                "note": f"Unapplied credit in the billing system ({r['family_account']}). {r['notes']}"[:500]}
               for r in unapplied]
    imported = f"Imported {as_of} from the billing system (Billing History 10/5/2026)"

    print(f"""-- Creativa CRM: master data import (as of {as_of}). Generated by imports/build_master_import.py.
-- Run in the Supabase SQL Editor after migrations 001-007. Safe to run twice.
-- Contains children's and parents' names, phone numbers, scholarship IDs and billing: do not commit or share.
begin;

-- Billing schedule and the school's legal name (business rules).
update public.settings set billing_anchor = {q(anchor)}, billing_period_days = {period_days} where id = 1;
update public.settings set school_name = {q(rules['school']['name'])} where id = 1 and school_name = 'Creativa Academy';

create temp table m_students (name text, classroom text, program text, funding text, award text, rate numeric,
  rbt text, therapy text, start_date date, docs boolean, bill_family boolean, notes text, family text, parent text, phone text) on commit drop;
insert into m_students values
{values(students, ['name', 'classroom', 'program', 'funding', 'award', 'rate', 'rbt', 'therapy', 'start', 'docs', 'bill_family', 'notes', 'family', 'parent', 'phone'])};

-- 1. Students: add any that are missing; fill in what the CRM doesn't have yet.
insert into public.students (name, classroom_id, status, school_year)
select m.name, c.id, 'enrolled', '2026-27' from m_students m join public.classrooms c on c.name = m.classroom
 where not exists (select 1 from public.students s where lower(s.name) = lower(m.name));
update public.students s set
  classroom_id     = coalesce((select c.id from public.classrooms c where c.name = m.classroom), s.classroom_id),
  start_date       = coalesce(s.start_date, m.start_date),
  rbt              = coalesce(m.rbt, s.rbt),
  therapy          = coalesce(m.therapy, s.therapy),
  family_account   = coalesce(m.family, s.family_account),
  parent_name      = coalesce(s.parent_name, m.parent),
  parent_phone     = coalesce(s.parent_phone, m.phone),
  doc_registration = case when m.docs then coalesce(s.doc_registration, {q(as_of)}) else s.doc_registration end,
  doc_blue_form    = case when m.docs then coalesce(s.doc_blue_form, {q(as_of)}) else s.doc_blue_form end,
  doc_yellow_form  = case when m.docs then coalesce(s.doc_yellow_form, {q(as_of)}) else s.doc_yellow_form end,
  doc_birth_cert   = case when m.docs then coalesce(s.doc_birth_cert, {q(as_of)}) else s.doc_birth_cert end
  from m_students m where lower(s.name) = lower(m.name);

-- 2. Funding and biweekly rate. FES stays FES-EO where the CRM already says so (else FES-UA);
--    SR – BPIECE and VPK flags already in the CRM are kept.
insert into public.student_finance as f (student_id, funding, tuition_amount, tuition_frequency, award_id, billing_program, bill_family, notes)
select s.id,
       array(select distinct x from unnest(
         case coalesce(m.funding, '') when 'fes' then array[case when 'fes_eo' = any (coalesce(old.funding, '{{}}')) then 'fes_eo' else 'fes_ua' end]
                        when '' then array[]::text[] else array[m.funding] end
         || array(select k from unnest(coalesce(old.funding, '{{}}')) k
                   where k = 'vpk' or (k = 'sr_bpiece' and m.funding = 'sr'))) x order by 1),
       coalesce(m.rate, old.tuition_amount), 'biweekly', coalesce(m.award, old.award_id), m.program, m.bill_family,
       case when m.notes is null or position(m.notes in coalesce(old.notes, '')) > 0 then old.notes
            else concat_ws(chr(10), old.notes, 'Master data {as_of}: ' || m.notes) end
  from m_students m join public.students s on lower(s.name) = lower(m.name)
  left join public.student_finance old on old.student_id = s.id
on conflict (student_id) do update set
  funding = excluded.funding, tuition_amount = excluded.tuition_amount, tuition_frequency = excluded.tuition_frequency,
  award_id = excluded.award_id, billing_program = excluded.billing_program, bill_family = excluded.bill_family,
  notes = excluded.notes;

-- 3. Parents, guardians and emergency contacts.
create temp table m_contacts (child text, role text, rel text, first_name text, last_name text, cell text, work text,
  home text, sms text, notes text) on commit drop;
insert into m_contacts values
{values(contacts, ['child', 'role', 'rel', 'first', 'last', 'cell', 'work', 'home', 'sms', 'notes'])};
insert into public.student_contacts (student_id, role, relationship, first_name, last_name, cell_phone, work_phone, home_phone, sms_phone, notes)
select s.id, m.role, m.rel, m.first_name, m.last_name, m.cell, m.work, m.home, m.sms, m.notes
  from m_contacts m join public.students s on lower(s.name) = lower(m.child)
 where not exists (select 1 from public.student_contacts c where c.student_id = s.id and c.role = m.role
                     and lower(coalesce(c.first_name, '')) = lower(coalesce(m.first_name, ''))
                     and lower(coalesce(c.last_name, '')) = lower(coalesce(m.last_name, '')));

-- 4. Invoices for the period of {anchor}, and the payments that cleared them.
create temp table m_invoices (child text, program text, amount numeric, paid_by date) on commit drop;
insert into m_invoices values
{values(invoices, ['child', 'program', 'amount', 'paid'])};
insert into public.invoices (student_id, kind, description, period_start, invoice_date, due_date, amount, source, note)
select s.id, 'tuition', m.program, {q(anchor)}, {q(anchor)}, {q(anchor)}, m.amount, 'import', {q(imported)}
  from m_invoices m join public.students s on lower(s.name) = lower(m.child)
on conflict (student_id, period_start) where kind = 'tuition' and not void do nothing;
insert into public.payments (student_id, invoice_id, paid_on, covers_month, amount, payer, method, reference, note)
select i.student_id, i.id, m.paid_by, date_trunc('month', i.invoice_date)::date, m.amount, 'parent', 'other', 'Billing system',
       'Paid in the billing system (imported {as_of})'
  from m_invoices m join public.students s on lower(s.name) = lower(m.child)
  join public.invoices i on i.student_id = s.id and i.kind = 'tuition' and i.period_start = {q(anchor)} and not i.void
 where m.paid_by is not null and not exists (select 1 from public.payments p where p.invoice_id = i.id);

-- 5. Fees still open on the A/R report.
insert into public.invoices (student_id, kind, description, invoice_date, due_date, amount, source, note)
select s.id, 'fee', v.item, v.inv::date, v.due::date, v.amount, 'import', {q('Imported ' + as_of + ' from the A/R report')}
  from (values
{values(fees, ['child', 'item', 'inv', 'due', 'amount'])}
  ) as v(child, item, inv, due, amount)
  join public.students s on lower(s.name) = lower(v.child)
 where not exists (select 1 from public.invoices i where i.student_id = s.id and i.kind = 'fee'
                     and i.description = v.item and i.invoice_date = v.inv::date);

-- 6. Money received but not applied to an invoice (credits). Skipped when the child already has a payment
--    made that day the same way, applied or not: a credit corrected and applied later is not added again.
insert into public.payments (student_id, paid_on, covers_month, amount, payer, method, reference, note)
select s.id, v.paid::date, date_trunc('month', v.paid::date)::date, v.amount, 'parent', v.method, 'Unapplied credit', v.note
  from (values
{values(credits, ['child', 'date', 'amount', 'method', 'note'])}
  ) as v(child, paid, amount, method, note)
  join public.students s on lower(s.name) = lower(v.child)
 where not exists (select 1 from public.payments p where p.student_id = s.id
                     and p.paid_on = v.paid::date and p.method = v.method);

-- 7. Withdrawn students stay withdrawn (nothing to change; listed for the check below).
create temp table m_withdrawn (name text) on commit drop;
insert into m_withdrawn values {", ".join("(" + q((w['first_name'] + ' ' + w['last_name']).strip()) + ")" for w in withdrawn)};

-- Checks: compare with the master data.
select 'enrolled students' as what, count(*)::text as now, '{len(students)}' as expected from public.students where status = 'enrolled'
union all select 'withdrawn (of the {len(withdrawn)} listed)', count(*)::text, '{len(withdrawn)}'
  from public.students s join m_withdrawn w on lower(w.name) = lower(s.name) where s.status = 'withdrawn'
union all select 'contacts', count(*)::text, '{len(contacts)}' from public.student_contacts
union all select 'invoices for {anchor}', count(*)::text, '{len(invoices)}' from public.invoices where period_start = {q(anchor)} and not void
union all select 'billed for {anchor}', sum(amount)::text, '{sum(i["amount"] for i in invoices):.2f}' from public.invoices where period_start = {q(anchor)} and not void
union all select 'open A/R (open invoices minus credits)',
  ((select coalesce(sum(greatest(i.amount - coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0), 0)), 0)
      from public.invoices i where not i.void)
   - (select coalesce(sum(amount), 0) from public.payments where invoice_id is null))::text, '1625.00';
commit;""")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
