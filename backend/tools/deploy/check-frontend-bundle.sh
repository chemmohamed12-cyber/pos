#!/usr/bin/env bash
#
# Frontend runtime bundle consistency check (v1.0.3 deployment report
# items 6 / 33 / 34).
#
# THE v1.0.3 SITE BUG: `release-new/frontend/dist` was rebuilt with a new
# hashed bundle (`index-DtuYiAhd.js`), but the SPA is actually served from
# `release-new/backend/public`, which still contained the PREVIOUS bundle
# (`index-Dgc6to3g.js`). The site kept showing old behaviour even though
# "the build succeeded". This check would have caught it in one line.
#
# What it does (read-only): parses the served `index.html`, extracts every
# `assets/*.{js,css}` it references, and confirms each of those files
# exists and is non-empty in the same directory tree. Optionally also
# compares against a freshly-built `frontend/dist` to detect drift BEFORE
# deploying.
#
# Usage:
#   bash check-frontend-bundle.sh <runtime-public-dir> [frontend-dist-dir]
#
# Examples:
#   bash tools/deploy/check-frontend-bundle.sh public
#   bash tools/deploy/check-frontend-bundle.sh \
#     /home/xnexdrgr/daii.xnexustech.com/release-new/backend/public \
#     /home/xnexdrgr/daii.xnexustech.com/release-new/frontend/dist
#
# Exit code: 0 = consistent, 1 = mismatch / missing bundle.

set -euo pipefail

RUNTIME_DIR="${1:-public}"
DIST_DIR="${2:-}"
FAIL=0

INDEX="$RUNTIME_DIR/index.html"
if [ ! -f "$INDEX" ]; then
  echo "  no $INDEX — backend-only host, nothing to check"
  exit 0
fi

# Extract referenced assets/*.js|css from src="" / href="".
referenced_assets() {
  local file="$1"
  grep -oE '(src|href)="[^"]*assets/[^"]+\.(js|css)[^"]*"' "$file" 2>/dev/null \
    | sed -E 's/^(src|href)="//; s/"$//; s/^\.?\///; s/\?.*$//; s#^public/##' \
    | sort -u
}

echo "  runtime index: $INDEX"
MISSING=0
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  # asset is like "assets/index-XXXX.js"
  path="$RUNTIME_DIR/${asset#public/}"
  if [ ! -s "$path" ]; then
    echo "  MISSING: index.html references '$asset' but '$path' is absent or empty"
    MISSING=$((MISSING + 1))
    FAIL=1
  else
    echo "  OK: $asset"
  fi
done <<EOF
$(referenced_assets "$INDEX")
EOF

if [ "$MISSING" -eq 0 ]; then
  echo "  served bundle is internally consistent"
fi

# Optional pre-deploy drift check against a fresh frontend build.
if [ -n "$DIST_DIR" ] && [ -f "$DIST_DIR/index.html" ]; then
  RUNTIME_REF="$(referenced_assets "$INDEX" | tr '\n' ' ')"
  DIST_REF="$(referenced_assets "$DIST_DIR/index.html" | tr '\n' ' ')"
  if [ "$RUNTIME_REF" != "$DIST_REF" ]; then
    echo "  DRIFT: served bundle != freshly built bundle"
    echo "         served : $RUNTIME_REF"
    echo "         dist   : $DIST_REF"
    echo "         -> copy $DIST_DIR/* into $RUNTIME_DIR/ (and restart) before signing off."
    FAIL=1
  else
    echo "  served bundle matches $DIST_DIR (no drift)"
  fi
fi

exit $FAIL
