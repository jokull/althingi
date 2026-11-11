#!/usr/bin/env bash
# Run ON the mac-mini (bash; the login shell is fish). Idempotent. Additive only:
#   - creates database `althingi` + roles althingi_rw (ingest) / althingi_ro (web, MCP)
#   - does NOT touch planitor, postgresql.conf, shared_preload_libraries or any extension
# Passwords are generated once and stored in ~/althingi/.env (mode 600).
set -euo pipefail
export PATH=/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:$PATH
ENV=$HOME/althingi/.env
mkdir -p "$HOME/althingi/raw" "$HOME/althingi/logs" "$HOME/althingi/backups"

if [ ! -f "$ENV" ]; then
  RW=$(openssl rand -hex 16); RO=$(openssl rand -hex 16)
  umask 077
  cat > "$ENV" <<EOF
RW_PASSWORD=$RW
RO_PASSWORD=$RO
DATABASE_URL=postgres://althingi_rw:$RW@localhost:5432/althingi
DATABASE_URL_RO=postgres://althingi_ro:$RO@localhost:5432/althingi
RAW_DIR=$HOME/althingi/raw
EOF
fi
set -a; . "$ENV"; set +a

psql -d postgres -v ON_ERROR_STOP=1 <<SQL
select 'create role althingi_rw login password ' || quote_literal('$RW_PASSWORD')
  where not exists (select from pg_roles where rolname = 'althingi_rw') \gexec
select 'create role althingi_ro login password ' || quote_literal('$RO_PASSWORD')
  where not exists (select from pg_roles where rolname = 'althingi_ro') \gexec
select 'create database althingi owner althingi_rw encoding ''UTF8'' template template0 lc_collate ''en_US.UTF-8'' lc_ctype ''en_US.UTF-8'''
  where not exists (select from pg_database where datname = 'althingi') \gexec
SQL

psql -d althingi -v ON_ERROR_STOP=1 <<'SQL'
revoke all on database althingi from public;
grant connect on database althingi to althingi_ro, althingi_rw;
grant usage on schema public to althingi_ro;
alter default privileges for role althingi_rw in schema public grant select on tables to althingi_ro;
alter role althingi_ro set default_transaction_read_only = on;
alter role althingi_ro set statement_timeout = '2s';
alter role althingi_ro set work_mem = '32MB';
SQL
echo "ok: database althingi and roles ready; credentials in $ENV"
