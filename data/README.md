# data/

Real school data (children, parents, phone numbers, scholarship IDs, billing) goes here **only on your
own computer**. Everything in this folder except this note is ignored by git, because this repository
is public and Netlify publishes the repository root as the CRM site (`/data/*` is also blocked in
`netlify.toml` as a second safeguard).

To load the master data into the CRM:

```bash
python3 -I imports/build_master_import.py data/creativa-crm-master.json data/creativa-crm-master.md > data/import.sql
```

then paste `data/import.sql` into the Supabase SQL Editor (after migrations 001–007). It is safe to run
twice. The last query compares the CRM with the master data (students, contacts, invoices, open A/R).
