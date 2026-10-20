#!/usr/bin/env bash
# Re-runs one CR-2026-10-15 observation probe on the approved dedicated cluster (127.0.0.1:5546) and removes it from src afterwards.
# The probes are kept here as *.ts.txt so they never run in CI or the regression list. Nothing touches daii_dev or any host.
#   bash docs/decisions/evidence-2026-10-15-cr-review/run-probe.sh probe-spec.ts.txt  procurement/interface   [out.json]
#   bash docs/decisions/evidence-2026-10-15-cr-review/run-probe.sh probe2-movement-dates.spec.ts.txt inventory-warehouse/interface [out.json]
# Run from backend/. Requires the cluster to be started: node tools/testing/biz-cluster-setup.js start
set -euo pipefail
EVID="docs/decisions/evidence-2026-10-15-cr-review"
PROBE="$1"; DIR="src/domains/$2"; OUT="${3:-$PWD/probe-rerun-results.json}"
TARGET="$DIR/zz-cr-rerun.company-isolation.spec.ts"
LIST="$(mktemp)"
trap 'rm -f "$TARGET" "$LIST"' EXIT
cp "$EVID/$PROBE" "$TARGET"
echo "$TARGET" > "$LIST"
# probe-spec.ts.txt writes to a fixed scratch path; probe2 honours CR_PROBE_OUT.
CR_PROBE_OUT="$OUT" node tools/testing/biz-run.js --regression "$LIST"
