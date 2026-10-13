#!/usr/bin/env bash
# Installs the fake http and pg_net extensions into the local Postgres (needs write access to its share dir).
set -euo pipefail
dir="$(psql -qtAc "select setting from pg_config where name = 'SHAREDIR'" -d postgres)/extension"
cd "$(dirname "$0")"
cp http.control http--1.0.sql pg_net.control pg_net--1.0.sql "$dir/"
