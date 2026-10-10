#!/usr/bin/env bash
# DAII — continuous-integration entry point (R2, TEST-03). Platform-neutral: the same script runs in GitHub Actions, any other CI, or locally.
#   bash tools/ci/ci.sh            (from the backend/ folder of a clean checkout)
# Steps (all database-free; the real-PostgreSQL suites run on the dedicated, guarded cluster — see docs/decisions/test-program/DISPOSABLE-DB-POLICY-2026-10-10.md):
#   install (npm ci) → build → lint → structure validation → documentation link check → unit tests (unit mode) → database-guard tests
# Every step is logged to ci-output/<step>.log and summarised in ci-output/summary.md so a run is reproducible and reviewable. The script keeps going after a failing step
# (so one run shows ALL problems) and exits non-zero if any step failed. No secrets are read or printed; no database is contacted.
set -u
cd "$(dirname "$0")/../.."
OUT="ci-output"; rm -rf "$OUT"; mkdir -p "$OUT"
FAILED=0
{
  echo "# CI summary"; echo
  echo "- commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "- node: $(node --version)   npm: $(npm --version)"
  echo "- started (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo
  echo "| step | result | seconds |"; echo "|---|---|---|"
} > "$OUT/summary.md"

run_step() { # name, command...
  local name="$1"; shift
  local start; start=$(date +%s)
  echo "=== $name: $*"
  if "$@" > "$OUT/$name.log" 2>&1; then local res="PASS"; else local res="FAIL"; FAILED=1; tail -n 25 "$OUT/$name.log"; fi
  echo "| $name | $res | $(( $(date +%s) - start )) |" >> "$OUT/summary.md"
  echo "    -> $res"
}

run_step install      npm ci --no-audit --no-fund
run_step build        npm run build
run_step lint         npm run lint
run_step structure    npm run validate:structure
run_step doc-links    node tools/validation/check-doc-links.js --json "$OUT/doc-links.json"
run_step unit         npm run test:unit
run_step db-guard     npm run test:db-guard

echo >> "$OUT/summary.md"
if [ "$FAILED" -eq 0 ]; then echo "**Overall: PASS**" >> "$OUT/summary.md"; else echo "**Overall: FAIL** (see the step logs)" >> "$OUT/summary.md"; fi
cat "$OUT/summary.md"
exit "$FAILED"
