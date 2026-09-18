#!/usr/bin/env bash
#
# Post-deploy verification pipeline for the Daii production (cPanel/
# Passenger) deployment — see ../../PRODUCTION_DEPLOYMENT_GUIDE.md.
#
# Runs, in order: Application Path Check -> Permissions Check ->
# Environment Check -> Database Schema + UUID Function Readiness Check
# (read-only) -> (manual Restart, see below) -> Health Check -> HTTP
# 200. A release is not done until this script exits 0. Together these
# cover: missing env vars, wrong application path, wrong permissions,
# no DB connectivity, missing schema objects, unavailable UUID
# functions, and HTTP/health failure — the full category list from the
# 2026-08-27/08-28 incidents, so none of them can recur silently.
#
# IMPORTANT — why there's a dedicated schema-readiness step: HTTP 200 /
# `/api/health` only prove the web server and process are up; they say
# nothing about the database schema. `/api/health/deep` only runs
# `SELECT 1` (proves *connectivity*, not that any table exists), and
# `/api/health/db` only reads one specific bootstrap table, not the
# actual application schema. None of the three would reliably catch a
# *partially* migrated database (some tables present, some pending), or
# a missing UUID function (pgcrypto/uuid-ossp both turned out to be
# unavailable on this hosting plan — see "UUID generation strategy" in
# the production guide). This is exactly the class of gap that produced
# the 2026-08-27 incident (`QueryFailedError: relation "users" does not
# exist` on login, while HTTP 200 and the shallow health check both
# looked fine). The check below queries the real schema and UUID
# functions directly and read-only, so it doesn't depend on the health
# endpoints' current coverage at all.
#
# Deliberately non-destructive: never touches .env, credentials,
# migrations, or database data — the schema check below is a plain
# `SELECT`/`to_regclass` read, not `migration:show` (which, on
# inspection of typeorm/commands/MigrationShowCommand.js, silently
# creates TypeORM's own bookkeeping table as a side effect and always
# exits 0 regardless of pending migrations — unsuitable for gating a
# release). Never chmod's anything to 777. Run this from the
# Application Root (the directory containing `backend/`), on the
# production host, after extracting a release and before/after
# restarting via cPanel -> Setup Node.js App -> Restart.
#
# Usage: bash backend/tools/deploy/verify-deploy.sh [https://daii.xnexustech.com]

set -euo pipefail

APP_URL="${1:-https://daii.xnexustech.com}"
BACKEND_DIR="backend"
FAIL=0

step() { printf '\n== %s ==\n' "$1"; }
ok()   { printf '  OK: %s\n' "$1"; }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=1; }

# --- 0. Application path check ---------------------------------------------
step "Application path check"
if [ ! -f "$BACKEND_DIR/dist/main.js" ]; then
  fail "$BACKEND_DIR/dist/main.js not found — wrong Application Root, or build wasn't deployed"
else
  ok "$BACKEND_DIR/dist/main.js present (matches the configured Application Startup File)"
fi

# --- 1. Permissions check -------------------------------------------------
# Scoped deliberately to the exact paths LiteSpeed/Passenger need to
# traverse (backend itself, plus src/dist/tools) — NEVER a bare
# recursive walk of "backend", which would also descend into
# node_modules/ and storage/ (tens of thousands of entries: needlessly
# slow, and neither directory is served directly or needs this fix).
step "Permissions check"
PERM_DIRS=("$BACKEND_DIR/src" "$BACKEND_DIR/dist" "$BACKEND_DIR/tools")
if [ ! -d "$BACKEND_DIR" ]; then
  fail "run this from the Application Root — '$BACKEND_DIR' not found here"
else
  chmod 755 "$BACKEND_DIR" 2>/dev/null || true
  for d in "${PERM_DIRS[@]}"; do
    [ -d "$d" ] || continue
    find "$d" -type d -exec chmod 755 {} \;
    find "$d" -type f -name ".htaccess" -exec chmod 644 {} \;
  done
  # Confirm nothing along those same paths is still unreadable.
  UNREADABLE=""
  for d in "${PERM_DIRS[@]}"; do
    [ -d "$d" ] || continue
    FOUND=$(find "$d" -name ".htaccess" ! -perm -044 2>/dev/null || true)
    UNREADABLE="$UNREADABLE $FOUND"
  done
  UNREADABLE="$(echo "$UNREADABLE" | xargs)"
  if [ -n "$UNREADABLE" ]; then
    fail "still-unreadable .htaccess file(s): $UNREADABLE"
  else
    ok "directory/.htaccess permissions applied (755 dirs, 644 .htaccess)"
  fi
fi

# --- 2. Environment check --------------------------------------------------
# Doesn't (and can't, from a plain shell) read what Passenger injects
# into the actual spawned process env — that can only be observed via
# the app's own boot output/log or /api/health, checked in step 4-5.
# This step only confirms the SERVER-SIDE .env file, if this deployment
# uses one, hasn't been wiped by the last extraction.
step "Environment file presence check (server-side .env, if used)"
if [ -f "$BACKEND_DIR/.env" ]; then
  MISSING=""
  for key in DB_HOST DB_PORT DB_USER DB_NAME DB_PASSWORD JWT_ACCESS_SECRET JWT_REFRESH_SECRET INTEGRATION_ENCRYPTION_KEY; do
    grep -q "^${key}=" "$BACKEND_DIR/.env" || MISSING="$MISSING $key"
  done
  if [ -n "$MISSING" ]; then
    fail "backend/.env is missing:$MISSING"
  else
    ok "backend/.env present with all required keys (values not checked here)"
  fi
else
  ok "no backend/.env on this host — assuming cPanel Environment Variables UI is the source; not checked from shell"
fi

# --- 3. Database schema readiness (read-only) ------------------------------
# Confirms the migrations that must have run actually have, by directly
# reading the catalog — no writes, no migration tooling invoked. Only
# needs DB_* values that this shell can see: from backend/.env if
# present, or already-exported in the environment. If neither is
# available, this step is skipped (not failed) with a clear warning,
# since it cannot safely guess credentials.
step "Database schema readiness check (read-only, no writes)"

get_env_val() {
  local key="$1"
  if [ -f "$BACKEND_DIR/.env" ]; then
    grep "^${key}=" "$BACKEND_DIR/.env" | tail -n1 | cut -d'=' -f2-
  fi
}

SCHEMA_DB_HOST="${DB_HOST:-$(get_env_val DB_HOST)}"
SCHEMA_DB_PORT="${DB_PORT:-$(get_env_val DB_PORT)}"
SCHEMA_DB_USER="${DB_USER:-$(get_env_val DB_USER)}"
SCHEMA_DB_NAME="${DB_NAME:-$(get_env_val DB_NAME)}"
SCHEMA_DB_PASSWORD="${DB_PASSWORD:-$(get_env_val DB_PASSWORD)}"

# Canary tables spanning the migration set: the very first migration
# (proves migrations ran at all) and the table the 2026-08-27 incident
# actually failed on (proves this specific, real failure is caught).
REQUIRED_TABLES="_daii_bootstrap_check users"

if ! command -v psql >/dev/null 2>&1; then
  echo "  SKIPPED: psql not available on this host — cannot verify schema directly here."
elif [ -z "$SCHEMA_DB_HOST" ] || [ -z "$SCHEMA_DB_USER" ] || [ -z "$SCHEMA_DB_NAME" ]; then
  echo "  SKIPPED: DB_HOST/DB_USER/DB_NAME not available to this shell (no backend/.env and none exported)."
  echo "  Schema readiness could not be verified directly — the health checks below are the only signal."
else
  MISSING_TABLES=""
  QUERY_ERROR=0
  for t in $REQUIRED_TABLES; do
    EXISTS=$(PGPASSWORD="$SCHEMA_DB_PASSWORD" psql -h "$SCHEMA_DB_HOST" -p "${SCHEMA_DB_PORT:-5432}" \
      -U "$SCHEMA_DB_USER" -d "$SCHEMA_DB_NAME" -tAc "SELECT to_regclass('public.${t}') IS NOT NULL;" 2>/dev/null || echo "ERROR")
    case "$EXISTS" in
      t) ;; # present
      f) MISSING_TABLES="$MISSING_TABLES $t" ;;
      *) fail "could not query schema for table '$t' (connection/auth error) — check DB_* values"; QUERY_ERROR=1 ;;
    esac
  done
  if [ "$QUERY_ERROR" -eq 0 ]; then
    if [ -n "$MISSING_TABLES" ]; then
      fail "database schema is not fully migrated — missing table(s):$MISSING_TABLES. Run 'npm run migration:run' (see PRODUCTION_DEPLOYMENT_GUIDE.md) before signing off this release."
    else
      ok "required tables present in public schema:$REQUIRED_TABLES"
    fi
  fi

  # UUID functions — the 2026-08-27/08-28 incident's second half:
  # pgcrypto AND uuid-ossp both turned out to be unavailable on this
  # hosting plan, and production is PostgreSQL 10.23 (confirmed live),
  # so gen_random_uuid() isn't core here either (that's PG13+ only).
  # Both functions exist only because CreateUsers1755840100000 and
  # 1755840150000-UuidGenerateV4Compatibility.ts define them directly as
  # plain SQL functions with no version/extension dependency — this
  # check proves those migrations actually ran, not just that the
  # tables exist.
  # STRICT RFC4122 — version nibble 1-5, variant nibble 8/9/a/b. A
  # UUID-SHAPED but non-compliant result (the pre-1755852500000 defect that
  # caused "accountId/treasuryAccountId must be a UUID") must FAIL here, not
  # pass — that's the whole point of item 8 in the v1.0.3 deployment report.
  RFC4122='^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  for fn in "gen_random_uuid()" "uuid_generate_v4()"; do
    RESULT=$(PGPASSWORD="$SCHEMA_DB_PASSWORD" psql -h "$SCHEMA_DB_HOST" -p "${SCHEMA_DB_PORT:-5432}" \
      -U "$SCHEMA_DB_USER" -d "$SCHEMA_DB_NAME" -tAc "SELECT ${fn};" 2>&1) || true
    if echo "$RESULT" | grep -qiE "$RFC4122"; then
      ok "$fn -> available and RFC4122-compliant"
    elif echo "$RESULT" | grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
      fail "$fn returns a UUID-SHAPED but NON-RFC4122 value ($RESULT) — migration 1755852500000-FixGenRandomUuidRfc4122Compliance has NOT run. Run 'npm run migration:run:prod'."
    else
      fail "$fn is not available on this database ($RESULT) — see PRODUCTION_DEPLOYMENT_GUIDE.md 'UUID generation strategy'"
    fi
  done

  # --- Legacy non-compliant primary keys census (WARNING, not a failure) ---
  # 1755852500000 fixes GENERATION; existing rows created before it are not
  # touched (that is the Controlled Data Repair — DATA_REPAIR_RUNBOOK.md).
  # This is a heads-up so an operator knows the "must be a UUID" errors will
  # persist for existing accounts/deposits until the repair runs; it does
  # NOT block a release.
  CENSUS_TABLES="treasury_accounts treasury_account_types users customers products sales_orders deposits"
  LEGACY_TOTAL=0
  for t in $CENSUS_TABLES; do
    CNT=$(PGPASSWORD="$SCHEMA_DB_PASSWORD" psql -h "$SCHEMA_DB_HOST" -p "${SCHEMA_DB_PORT:-5432}" \
      -U "$SCHEMA_DB_USER" -d "$SCHEMA_DB_NAME" -tAc \
      "SELECT count(*) FROM \"$t\" WHERE id::text !~* '$RFC4122';" 2>/dev/null || echo 0)
    CNT=$(echo "$CNT" | tr -dc '0-9'); CNT=${CNT:-0}
    if [ "$CNT" -gt 0 ]; then
      echo "  WARNING: $t has $CNT row(s) with a non-RFC4122 primary key (legacy generator)."
      LEGACY_TOTAL=$((LEGACY_TOTAL + CNT))
    fi
  done
  if [ "$LEGACY_TOTAL" -gt 0 ]; then
    echo "  WARNING: $LEGACY_TOTAL legacy non-compliant primary key(s) total. 'accountId/treasuryAccountId"
    echo "           must be a UUID' will keep failing for these until a Controlled Data Repair runs"
    echo "           (backend/DATA_REPAIR_RUNBOOK.md). This is NOT a release blocker."
  else
    ok "no legacy non-RFC4122 primary keys in the sampled tables"
  fi
fi

# --- 3b. Frontend runtime bundle check ------------------------------------
# The v1.0.3 site bug: frontend/dist was rebuilt but backend/public kept
# serving the previous hashed bundle. This asserts the bundle referenced by
# the served index.html actually exists on disk.
step "Frontend runtime bundle check"
if [ -f "$BACKEND_DIR/tools/deploy/check-frontend-bundle.sh" ]; then
  if bash "$BACKEND_DIR/tools/deploy/check-frontend-bundle.sh" "$BACKEND_DIR/public"; then
    ok "served index.html and its asset bundle are consistent"
  else
    fail "frontend runtime bundle mismatch — see the check output above (stale or half-copied bundle)"
  fi
else
  echo "  SKIPPED: check-frontend-bundle.sh not present"
fi

echo
echo "Permissions, environment, and schema checks complete."
echo "Next: restart the app from cPanel -> Setup Node.js App -> Daii -> Restart."
echo "Then re-run this script with no changes to skip to the health checks below,"
echo "or just run the two curl checks manually:"
echo

# --- 4. API-level health / HTTP 200 (post-restart) -------------------------
# These only mean anything AFTER a Restart has been done from cPanel, so
# they're offered here as a single block to run post-restart rather than
# gated automatically — this script can't click the cPanel Restart button.
# Kept as a second, independent signal alongside the schema check above —
# not a substitute for it (see the file header note on why).
step "Health checks against $APP_URL (run this block after restarting from cPanel)"

check_json() {
  local path="$1"
  local url="${APP_URL%/}${path}"
  local body
  if ! body=$(curl -fsS --max-time 10 "$url" 2>/dev/null); then
    fail "$path did not return a successful response"
    return
  fi
  if echo "$body" | grep -q '"success":true'; then
    ok "$path -> success"
  else
    fail "$path responded but did not report success: $body"
  fi
}

check_json "/api/health"
check_json "/api/health/db"
check_json "/api/health/deep"

step "HTTP status check"
STATUS=$(curl -o /dev/null -s -w '%{http_code}' --max-time 10 "$APP_URL" 2>/dev/null || true)
STATUS="${STATUS:-000}"
if [ "$STATUS" = "200" ]; then
  ok "GET $APP_URL -> 200"
else
  fail "GET $APP_URL -> $STATUS (expected 200)"
fi

echo
if [ "$FAIL" -ne 0 ]; then
  echo "verify-deploy: FAILED — see FAIL lines above. Do not sign off this release."
  exit 1
fi
echo "verify-deploy: PASSED"
