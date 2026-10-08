#!/usr/bin/env bash
# Applies the migration to a fresh database on a local Postgres and runs tests/db.test.sql.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres tests/run-db-tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=creativa_crm_test
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d $DB -f tests/supabase-stub.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d $DB -f "$f"; done
psql -qtA -v ON_ERROR_STOP=1 -d $DB -f tests/db.test.sql 2>&1 | grep -vE "^$"
psql -qtA -v ON_ERROR_STOP=1 -d $DB -f tests/calendar.test.sql 2>&1 | grep -vE "^$"
