#!/usr/bin/env bash
#
# Controlled UUID Data Repair — full rehearsal on an ISOLATED scratch
# PostgreSQL cluster. Stands up its own cluster on a non-default port,
# runs every migration, then hands off to `scratch-rehearsal.ts` which
# injects legacy non-compliant ids and drives the CTO's chain:
#
#   pre-repair backup -> audit -> mapping -> repair (one txn) ->
#   integrity verify -> @IsUUID() passes -> restore/rollback
#
# NEVER touches staging or production. Evidence lands in
# tools/data-repair/rehearsal-evidence/.
#
# Requires: an `initdb`/`pg_ctl`/`pg_dump`/`pg_restore` on PATH or via
# $PGBIN. Usage:
#   bash tools/data-repair/scratch-rehearsal.sh
#   PGBIN=/usr/pgsql-16/bin bash tools/data-repair/scratch-rehearsal.sh

set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-}"
pgbin() { if [ -n "$PGBIN" ]; then echo "$PGBIN/$1"; else echo "$1"; fi; }

PORT="${SCRATCH_PG_PORT:-55433}"
WORK="$(mktemp -d)"
PGDATA="$WORK/pgdata"
DBNAME="daii_scratch"
DBUSER="daii"
DBPASS="scratch_only"

cleanup() {
  "$(pgbin pg_ctl)" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== initdb (isolated cluster, port $PORT) =="
"$(pgbin initdb)" -D "$PGDATA" -U "$DBUSER" --auth=trust -E UTF8 >/dev/null

echo "== start =="
# unix_socket_directories='' — the scratchpad path is often > the 107-byte
# socket-path limit; TCP on 127.0.0.1 is all we need.
"$(pgbin pg_ctl)" -D "$PGDATA" -o "-p $PORT -c unix_socket_directories=" -l "$WORK/pg.log" start >/dev/null 2>&1 || true
for i in $(seq 1 30); do
  if "$(pgbin psql)" -h 127.0.0.1 -p "$PORT" -U "$DBUSER" -d postgres -tc "select 1" >/dev/null 2>&1; then break; fi
  sleep 1
done
"$(pgbin psql)" -h 127.0.0.1 -p "$PORT" -U "$DBUSER" -d postgres -c "create database $DBNAME" >/dev/null
"$(pgbin psql)" -h 127.0.0.1 -p "$PORT" -U "$DBUSER" -d postgres -c "alter user $DBUSER password '$DBPASS'" >/dev/null

export DB_HOST=127.0.0.1 DB_PORT="$PORT" DB_USER="$DBUSER" DB_PASSWORD="$DBPASS" DB_NAME="$DBNAME"
export PG_DUMP_BIN="$(pgbin pg_dump)" PG_RESTORE_BIN="$(pgbin pg_restore)"

echo "== migrate =="
( cd "$BACKEND_DIR" && npm run migration:run >/dev/null )

echo "== rehearsal =="
( cd "$BACKEND_DIR" && npx ts-node tools/data-repair/scratch-rehearsal.ts )

echo
echo "Rehearsal complete. Evidence: $BACKEND_DIR/tools/data-repair/rehearsal-evidence/"
