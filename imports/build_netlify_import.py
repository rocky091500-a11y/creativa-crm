"""Build a one-time SQL import of past Netlify form submissions into the Creativa CRM.

Usage: python3 -I build_netlify_import.py <schedule-tour.csv> <contact.csv> > import.sql
The generated SQL is idempotent: rows already imported (same netlify_id) are skipped.
"""
import csv, json, re, sys
from datetime import date

# Tests and non-family contacts, identified by Netlify submission id.
SKIP = {
    '6ac7d56ab1f9670614b0d86a': 'Test Family (CRM integration test)',
    '6a957587bb702b357b7999ec': 'Ivan Say for Jayden (internal test)',
    '6a73f1f1b91b537b3c004995': 'Emily Say for Jayden (internal test)',
    '6ac38416cb0e5a2c88fb7eb8': 'Picture-day photography sales pitch',
    '6aaea2e097f61ed4622f9366': 'SEO sales pitch',
    '6a8128bedcaeca1923f26719': 'Job inquiry (student counselor)',
}

def clean(v):
    v = (v or '').strip()
    return v or None

def name_case(v):
    v = clean(v)
    if v and (v == v.lower() or v == v.upper()):
        v = ' '.join(w.capitalize() for w in v.split())
    return v

def join(*parts):
    s = ' '.join(p for p in (clean(x) for x in parts) if p)
    return s or None

def parse_dob(text, submitted):
    """Only a full MM/DD/YYYY (or MM/DD/YY) date counts; anything else stays as text."""
    m = re.search(r'\b(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})\b', text or '')
    if not m:
        return None
    mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000
    try:
        dob = date(y, mo, d)
    except ValueError:
        return None
    if not (date(2015, 1, 1) <= dob <= submitted):
        return None
    return dob.isoformat()

def q(v):
    return 'null' if v is None else "'" + str(v).replace("'", "''") + "'"

rows = []

with open(sys.argv[1], newline='', encoding='utf-8') as f:
    for r in csv.DictReader(f):
        if r['netlify_id'] in SKIP:
            continue
        submitted = date.fromisoformat(r['created_at'][:10])
        new_style = bool(clean(r.get('parent-first-name')) or clean(r.get('child-first-name')))
        if new_style:
            parent = join(name_case(r['parent-first-name']), name_case(r['parent-last-name']))
            child = join(name_case(r['child-first-name']), name_case(r['child-last-name']))
            dob = clean(r['child-dob'])
            age_note = None
        else:
            parent = join(name_case(r['first-name']), name_case(r['last-name']))
            child = name_case(r['child-name'])
            age_text = clean(r['child-age'])
            dob = parse_dob(age_text, submitted)
            age_note = f"Child's age/birthday as entered: {age_text}" if age_text and not dob else None
        heard = clean(r['referral'])
        if heard and clean(r['referred-by']):
            heard = f"{heard} ({clean(r['referred-by'])})"
        message = '\n\n'.join(x for x in (clean(r['notes']), age_note) if x) or None
        raw = {k: v.strip() for k, v in r.items() if clean(v) and k not in ('bot-field', 'referrer')}
        if 'days' in raw:
            raw['days'] = [d.strip() for d in raw['days'].split(',')]
        rows.append(dict(source='schedule-tour', created_at=r['created_at'], parent=parent,
                         email=(clean(r['email']) or '').lower() or None, phone=clean(r['phone']),
                         pref=clean(r['contact-pref']), child=child, dob=dob, program=clean(r['program']),
                         start=clean(r['start-time']), heard=heard, message=message, raw=raw))

with open(sys.argv[2], newline='', encoding='utf-8') as f:
    for r in csv.DictReader(f):
        if r['netlify_id'] in SKIP:
            continue
        raw = {k: v.strip() for k, v in r.items() if clean(v) and k != 'referrer'}
        rows.append(dict(source='contact', created_at=r['created_at'],
                         parent=join(name_case(r['first-name']), name_case(r['last-name'])),
                         email=(clean(r['email']) or '').lower() or None, phone=clean(r['phone']), pref=None,
                         child=None, dob=None, program=None, start=None, heard=None,
                         message=clean(r['message']), raw=raw))

rows.sort(key=lambda x: x['created_at'])

out = ["""-- Creativa CRM: one-time import of past website form submissions from Netlify Forms.
-- Paste into the Supabase SQL Editor and click Run. Safe to run twice: rows already
-- imported (same Netlify submission id) are skipped.
-- Skipped on purpose: """ + '; '.join(sorted(SKIP.values())) + """.

drop table if exists netlify_import;
create temporary table netlify_import (
  source text, created_at timestamptz, parent_name text, email text, phone text, contact_pref text,
  child_name text, child_dob date, program text, desired_start text, heard_from text, message text, raw jsonb
);

insert into netlify_import values"""]
vals = []
for x in rows:
    vals.append('  (' + ', '.join([
        q(x['source']), q(x['created_at']), q(x['parent']), q(x['email']), q(x['phone']), q(x['pref']),
        q(x['child']), q(x['dob']), q(x['program']), q(x['start']), q(x['heard']), q(x['message']),
        q(json.dumps(x['raw'], ensure_ascii=False)) + '::jsonb']) + ')')
out.append(',\n'.join(vals) + ';')
out.append("""
-- Insert, skipping anything already imported or already in the CRM from the live website.
insert into public.inquiries
    (created_at, updated_at, source, stage, parent_name, email, phone, contact_pref, child_name, child_dob,
     program, desired_start, heard_from, message, raw)
select n.created_at, n.created_at, n.source, 'new', n.parent_name, n.email, n.phone, n.contact_pref, n.child_name,
         n.child_dob, public._program_canon(n.program), n.desired_start, n.heard_from, n.message, n.raw
from netlify_import n
where not exists (select 1 from public.inquiries i where i.raw->>'netlify_id' = n.raw->>'netlify_id')
  and not exists (select 1 from public.inquiries i
                   where i.source = n.source and lower(i.email) = n.email
                       and abs(extract(epoch from i.created_at - n.created_at)) < 86400);

-- The insert trigger logged "Received from website form" with today's date; date it to the original submission.
update public.activities a
   set created_at = i.created_at,
       body = 'Imported from Netlify Forms (website form: ' || i.source || ')'
  from public.inquiries i
 where a.inquiry_id = i.id and a.kind = 'system' and i.raw ? 'netlify_id'
   and a.body like 'Received from website form%';

drop table netlify_import;

select source, count(*) as imported_inquiries
  from public.inquiries
 where raw ? 'netlify_id'
 group by source
 order by source;
""")
print('\n'.join(out))
print(f'-- {len(rows)} submissions in this file', file=sys.stderr)
