#!/usr/bin/env bash
#
# run-owner-tool.sh - launcher for the owner tools on the cPanel/CloudLinux host (2026-10-17).
#
#   bash run-owner-tool.sh status              # Stage A: company-migration-status.js (read-only)
#   bash run-owner-tool.sh plan                # company-migration-catchup.js without --apply (read-only)
#   bash run-owner-tool.sh catchup <args...>   # Stage B: company-migration-catchup.js <args> (ONLY after the plan was reviewed)
#   bash run-owner-tool.sh where               # prints what it found (node, environment source, variable NAMES) and runs nothing
#
# It solves two host problems and nothing else:
#  1. `node` is not on PATH in a bare SSH shell: it finds a Node.js >= 20 (cPanel Node Selector `~/nodevenv/<app>/<ver>/bin/node`, then CloudLinux
#     `/opt/alt/alt-nodejs*/root/usr/bin/node`), or uses $DAII_NODE if you set it.
#  2. The application's environment (set in cPanel -> Setup Node.js App) is not in an SSH shell: it takes it, in this order, from
#       (a) variables already exported in your shell (DB_NAME + DB_USER + DB_PASSWORD present),
#       (b) a `.env` file in the application root (read by the application's own config loader),
#       (c) the environment of the RUNNING application process of the same user (/proc/<pid>/environ, same-user read, only well-known variable families).
#     Values are only ever passed to the tool's process. They are NEVER printed: this script prints variable NAMES and yes/no only.
# It never edits a file, never writes a variable to disk, never runs `--apply` by itself, and never contacts anything but what the tool itself does.
#
# Override defaults with environment variables: DAII_APP_ROOT (default /home/xnexdrgr/daii.xnexustech.com/release-new/backend), DAII_NODE.
set -u

APP_ROOT="${DAII_APP_ROOT:-/home/xnexdrgr/daii.xnexustech.com/release-new/backend}"
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROC_ROOT="${DAII_PROC_ROOT:-/proc}"          # only changed by the self-test
HOME_DIR="${HOME:-/home/$(id -un)}"
MODE="${1:-}"; [ $# -gt 0 ] && shift

die() { echo "REFUSED: $*" >&2; exit 3; }

case "$MODE" in
  status) TOOL="company-migration-status.js"; EXTRA=() ;;
  plan)   TOOL="company-migration-catchup.js"; EXTRA=() ;;
  catchup) TOOL="company-migration-catchup.js"; EXTRA=("$@") ;;
  where)  TOOL=""; EXTRA=() ;;
  *) die "usage: bash run-owner-tool.sh status | plan | catchup <args> | where" ;;
esac
[ -f "$APP_ROOT/dist/main.js" ] || die "$APP_ROOT is not an installed release root (dist/main.js missing). Set DAII_APP_ROOT to the folder that contains dist/main.js."
if [ -n "$TOOL" ]; then [ -f "$TOOLS_DIR/$TOOL" ] || die "$TOOLS_DIR/$TOOL not found"; fi

# ---------------------------------------------------------------- node >= 20
node_major() { "$1" -v 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p'; }
NODE=""
REL="${APP_ROOT#"$HOME_DIR"/}"
CANDIDATES=()
[ -n "${DAII_NODE:-}" ] && CANDIDATES+=("$DAII_NODE")
for v in 24 22 20; do CANDIDATES+=("$HOME_DIR/nodevenv/$REL/$v/bin/node"); done
while IFS= read -r f; do CANDIDATES+=("$f"); done < <(find "$HOME_DIR/nodevenv" -maxdepth 8 \( -type f -o -type l \) -path '*/bin/node' 2>/dev/null | grep -E '/(2[0-9])/bin/node$' | sort -r)
for d in /opt/alt/alt-nodejs24 /opt/alt/alt-nodejs22 /opt/alt/alt-nodejs20; do CANDIDATES+=("$d/root/usr/bin/node"); done
command -v node >/dev/null 2>&1 && CANDIDATES+=("$(command -v node)")
for c in "${CANDIDATES[@]}"; do
  [ -x "$c" ] || continue
  m="$(node_major "$c")"
  if [ -n "$m" ] && [ "$m" -ge 20 ]; then NODE="$c"; break; fi
done
[ -n "$NODE" ] || die "no Node.js >= 20 found. Looked in ~/nodevenv/$REL/{24,22,20}/bin/node, ~/nodevenv/**, /opt/alt/alt-nodejs*/root/usr/bin/node. Find it with: ls -d ~/nodevenv/*/*/20 ~/nodevenv/*/*/*/20 ~/nodevenv/*/*/*/*/20 and set DAII_NODE=<that>/bin/node"
echo "node: $NODE ($("$NODE" -v))"
echo "application root: $APP_ROOT"

# ---------------------------------------------------------------- environment (values are never printed)
KEYRE='^(NODE_ENV|DB_[A-Z_]+|JWT_[A-Z_]+|INTEGRATION_[A-Z_]+|DATABASE_[A-Z_]+|CLOSING_[A-Z_]+|MEDIA_[A-Z_]+|ENTITLEMENT_[A-Z_]+|RELEASE_[A-Z_]+|PG_[A-Z_]+|FRONTEND_[A-Z_]+|PASSENGER_[A-Z_]+|NPM_BIN|NODE_BIN|TZ)$'
SOURCE=""
if [ -n "${DB_NAME:-}" ] && [ -n "${DB_USER:-}" ] && [ -n "${DB_PASSWORD:-}" ]; then
  SOURCE="variables already exported in this shell"
elif [ -r "$APP_ROOT/.env" ]; then
  SOURCE="$APP_ROOT/.env (read by the application's own config loader)"
else
  ME="$(id -u)"
  for p in "$PROC_ROOT"/[0-9]*; do
    [ -r "$p/environ" ] || continue
    [ "$(stat -c %u "$p" 2>/dev/null)" = "$ME" ] || continue
    cmd="$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)"
    cwd="$(readlink "$p/cwd" 2>/dev/null || true)"
    case "$cmd $cwd" in *"$APP_ROOT"*) ;; *) continue ;; esac
    n=0
    while IFS= read -r -d '' kv; do
      k="${kv%%=*}"
      [[ "$k" =~ $KEYRE ]] || continue
      export "$kv"; n=$((n+1))
    done < "$p/environ"
    if [ "$n" -gt 0 ] && [ -n "${DB_NAME:-}" ] && [ -n "${DB_USER:-}" ] && [ -n "${DB_PASSWORD:-}" ]; then SOURCE="running application process (pid ${p##*/}), $n variables"; break; fi
  done
fi
[ -n "$SOURCE" ] || die "could not obtain the application's database settings. Export DB_HOST DB_PORT DB_USER DB_NAME DB_PASSWORD DATABASE_CREDENTIAL_ENCRYPTION_KEY (and the other variables of Setup Node.js App) in this shell without echoing them, or place them in $APP_ROOT/.env, then run again."
echo "environment source: $SOURCE"
ENVFILE=""; case "$SOURCE" in *".env"*) ENVFILE="$APP_ROOT/.env" ;; esac
present() {
  if [ -n "$ENVFILE" ]; then if grep -q "^$1=" "$ENVFILE" 2>/dev/null; then echo "$1=set"; else echo "$1=MISSING"; fi
  elif [ -n "${!1:-}" ]; then echo "$1=set"; else echo "$1=MISSING"; fi
}
echo "variables (names and presence only): $(for k in NODE_ENV DB_HOST DB_PORT DB_USER DB_NAME DB_PASSWORD DATABASE_CREDENTIAL_ENCRYPTION_KEY JWT_ACCESS_SECRET; do present "$k"; done | tr '\n' ' ')"
RCM="${RELEASE_COMPANY_MIGRATIONS:-}"; [ -z "$RCM" ] && [ -n "$ENVFILE" ] && RCM="$(grep -E '^RELEASE_COMPANY_MIGRATIONS=' "$ENVFILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' | sed "s/[\"' ]//g")"
echo "RELEASE_COMPANY_MIGRATIONS=${RCM:-<not set here: engine default is off>}"
[ -n "$TOOL" ] || exit 0

echo "running: $TOOL (mode: $MODE)"
cd "$APP_ROOT" || die "cannot enter $APP_ROOT"
exec "$NODE" "$TOOLS_DIR/$TOOL" --app-root "$APP_ROOT" "${EXTRA[@]+"${EXTRA[@]}"}"
