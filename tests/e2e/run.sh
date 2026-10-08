#!/usr/bin/env bash
# End-to-end test: migrated Postgres + real PostgREST + fake auth + headless Chromium.
# Needs: a local Postgres (PGHOST/PGPORT/PGUSER), a PostgREST binary at $POSTGREST,
# a copy of supabase-js UMD at $SUPABASE_JS, and Playwright installed globally.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${POSTGREST:?path to postgrest binary}" "${SUPABASE_JS:?path to supabase.min.js 2.45.4}"
DB=creativa_crm_e2e
TMP="${E2E_TMP:-$(mktemp -d)}"; mkdir -p "$TMP"; export E2E_TMP="$TMP"
export JWT_SECRET="e2e-secret-e2e-secret-e2e-secret-0123456789"
export ANON_KEY_PLACEHOLDER="anon-test-key"
export E2E_USERS='[
  {"id":"00000000-0000-0000-0000-00000000000a","email":"owner@creativaacademy.com","password":"owner-pass-1"},
  {"id":"00000000-0000-0000-0000-00000000000b","email":"teacher@creativaacademy.com","password":"teacher-pass-1"},
  {"id":"00000000-0000-0000-0000-00000000000c","email":"newhire@creativaacademy.com","password":"newhire-pass-1"}]'

psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d $DB -f tests/supabase-stub.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d $DB -f "$f"; done
psql -q -v ON_ERROR_STOP=1 -d $DB -f tests/e2e/seed.sql

cat > "$TMP/pgrst.conf" <<EOF
db-uri = "postgres://authenticator@/$DB?host=${PGHOST}&port=${PGPORT}"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-port = 3300
server-host = "127.0.0.1"
EOF
"$POSTGREST" "$TMP/pgrst.conf" > "$TMP/pgrst.log" 2>&1 &
PG_PID=$!
node tests/e2e/server.mjs > "$TMP/server.log" 2>&1 &
SRV_PID=$!
trap 'kill $PG_PID $SRV_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf http://127.0.0.1:3300/ >/dev/null && curl -sf http://localhost:8787/ >/dev/null && break; sleep 0.2; done

NODE_PATH="$(npm root -g)" node tests/e2e/spec.mjs
