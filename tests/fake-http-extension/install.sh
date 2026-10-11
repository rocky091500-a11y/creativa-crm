#!/usr/bin/env bash
# Installs the fake http extension into the local Postgres (needs write access to its share dir).
set -euo pipefail
dir="$(psql -qtAc "select setting from pg_config where name = 'SHAREDIR'" -d postgres)/extension"
cp "$(dirname "$0")/http.control" "$(dirname "$0")/http--1.0.sql" "$dir/"
