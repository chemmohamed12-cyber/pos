#!/usr/bin/env bash
#
# Daii release build + packaging pipeline.
#
# One deterministic script that produces a package the Release Center can
# load directly (`MANIFEST.json` + `dist/` + `src/` + `public/`).
#
# Release Engine overhaul (CTO Directive, Production Incident 2026-09-15
# post-mortem — Migration Preflight -> Metadata Contract -> Upgrade Resolver
# -> Release Center UI -> Full Regression). This script's `generate_manifest()`
# is the ONE place that populates the Metadata Contract fields
# (`ReleaseManifest.database.{migrationRequired,migrationCount}`,
# `runtimeDependencies`, optionally `minimumCompatibleVersion`) that
# `backend/src/foundation/release/migration-preflight.ts` cross-checks at
# deploy time. A field declared in the TS type but never actually populated
# here gives no real protection (confirmed gap, Production Incident
# 2026-09-15) — every Metadata Contract field below is derived from the
# ACTUAL staged tree, never hand-typed or invented.
#
# Older gap this reconstruction closes:
#   - `runtimeDependencies` — was declared in `ReleaseManifest` but nothing
#     in this pipeline ever populated it. Now copied verbatim from the
#     staged `package.json`'s own `dependencies` (the full set, not a diff)
#     — `dependency-check.ts`'s `checkDependenciesResolve` cross-checks this
#     declaration against the candidate's real `node_modules`, so the
#     declaration itself must come from the same source of truth
#     (`package.json`), never a separately-maintained list.
#   - `database.migrationRequired`/`migrationCount` — computed from the SAME
#     per-tag migration scan that populates `migrations[]` below (one scan,
#     never two independent counts that could silently disagree). Scoped to
#     `dist/database/migrations/<tag>/[0-9]*.js` PER TAG SUBDIRECTORY —
#     mirrors `discoverMigrationTags()`/`createMigrationDataSource()` in
#     `migration-datasource.ts` exactly (a `dist/database/migrations/*.js`
#     flat scan would silently miss every per-module-partitioned migration,
#     the same class of bug the `accounting`-omission incident already
#     taught this codebase not to repeat via a hand-maintained list — see
#     `migration-datasource.ts`'s own doc comment).
#   - `minimumCompatibleVersion` — optional, set ONLY via `--min-compatible-version`
#     (or `$RELEASE_MIN_COMPATIBLE_VERSION`). Never invented/guessed by this
#     script: absent unless the release author explicitly knows of a real
#     architectural floor (`release-manifest.ts`'s own doc comment).
#
# Usage:
#   bash tools/build/build-release.sh [--package-type full|delta] [--base-version X.Y.Z] [--min-compatible-version X.Y.Z] [--out DIR] [--skip-install]
#   bash tools/build/build-release.sh --verify <package.zip>
#   bash tools/build/build-release.sh --manifest-only <staged-dir> [--min-compatible-version X.Y.Z]   # regenerate MANIFEST.json for an already-assembled tree
#   bash tools/build/build-release.sh --check-determinism [--skip-install] [--out DIR]
#       # clean-build + assemble TWICE, compare every file, write
#       # <OUT_DIR>/determinism-report.txt, non-zero exit on any diff.
#
# The build NEVER writes into an ACTIVE release or the working src/ dist/
# tree — `assert_out_dir_safe` refuses such an --out.
#
# Env (all have safe dev defaults; production sets absolutes):
#   NODE_BIN, NPM_BIN, RELEASE_BUILD_MAX_THREADS, RELEASE_MIN_COMPATIBLE_VERSION
#   RELEASE_FRONTEND_DIR   — the frontend source tree. OPTIONAL — a manual
#                            override should NOT be needed. The default resolver
#                            (resolve_frontend_dir) finds it whether the repo
#                            layout is `backend/` + `frontend/` siblings (dev
#                            workspace) or backend-contents-at-root with
#                            `frontend/` as a child (packaged / extracted tree).
#   SOURCE_DATE_EPOCH      — if set, MANIFEST.json "generatedAt" is derived from
#                            this Unix timestamp instead of the wall clock, so
#                            two builds of the same source produce a byte-
#                            identical manifest (reproducible-builds convention).
#
# Flags:
#   --skip-install  — reuse the present node_modules instead of `npm ci`. For
#                     determinism checks / CI on a host that can't reach the
#                     registry. The default (full) path always does `npm ci`.

set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Resolve the frontend source tree from the repository, not from a manual
# server override. Try, in order: $RELEASE_FRONTEND_DIR, sibling
# (`backend/` + `frontend/` — dev workspace), child (`frontend/` under the
# backend root — packaged / extracted parity tree), grandparent-sibling.
# First candidate that exists AND looks like the frontend (package.json +
# vite config / index.html) wins. `set -e`-safe: never `cd`s a bad path.
resolve_frontend_dir() {
  local c
  for c in \
    "${RELEASE_FRONTEND_DIR:-}" \
    "$BACKEND_DIR/../frontend" \
    "$BACKEND_DIR/frontend" \
    "$BACKEND_DIR/../../frontend"
  do
    [ -n "$c" ] && [ -d "$c" ] || continue
    if [ -f "$c/package.json" ] && { [ -f "$c/vite.config.ts" ] || [ -f "$c/vite.config.js" ] || [ -f "$c/index.html" ]; }; then
      ( cd "$c" && pwd ) && return 0
    fi
  done
  return 1
}
FRONTEND_DIR="$(resolve_frontend_dir || true)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"
MAX_THREADS="${RELEASE_BUILD_MAX_THREADS:-2}"
NODE_DIR="$(dirname "$NODE_BIN")"
SKIP_INSTALL=0

log() { printf '\n== %s ==\n' "$1"; }

# Translate a path to a form Node understands when it differs from the shell's
# (Git Bash / msys: `/tmp` is a mount, but `node` resolves bare `/tmp` to the
# current drive). No-op on Linux/macOS — cygpath isn't installed there.
npath() { cygpath -m "$1" 2>/dev/null || echo "$1"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Zip the CONTENTS of directory $1 at the archive root (FLAT — `MANIFEST.json`
# / `src/` / `dist/` / `public/` at top level, exactly what
# `PackageValidatorService` accepts; NO wrapper dir).
# Forward-slash paths only, files 644, entries sorted for a stable archive.
# Prefers `zip` (CloudLinux); falls back to a Node + yazl zipper.
make_zip() {
  local srcdir="$1" out="$2"
  if command -v zip >/dev/null 2>&1; then
    ( cd "$srcdir" && find . -type f | LC_ALL=C sort | sed 's|^\./||' | zip -q -X -@ "$out" )
  else
    "$NODE_BIN" -e '
      const fs=require("fs"), path=require("path");
      const [, backend, srcdir, out] = process.argv;   // node -e: argv[1] is the 1st passed arg
      const yazl=require(backend+"/node_modules/yazl");
      const zip=new yazl.ZipFile();
      (function walk(dir){
        for (const name of fs.readdirSync(dir).sort()) {
          const abs=path.join(dir,name);
          const rel=path.relative(srcdir,abs).split(path.sep).join("/");
          if (fs.statSync(abs).isDirectory()) walk(abs);
          else zip.addFile(abs, rel, { mode: 0o644 });
        }
      })(srcdir);
      const ws=fs.createWriteStream(out);
      zip.outputStream.pipe(ws).on("close", ()=>console.log("  (zipped via yazl fallback)"));
      zip.end();
    ' "$(npath "$BACKEND_DIR")" "$(npath "$srcdir")" "$(npath "$out")"
  fi
}

# Emit MANIFEST.json for a staged directory: every file under src/ dist/
# public/ as an {path, action:"modify", checksum} entry, plus version,
# packageType, baseVersion, minimumCompatibleVersion, generatedAt, the
# per-tag migration name list, database.{migrationRequired,migrationCount},
# and runtimeDependencies — the full Metadata Contract shape
# (`release-manifest.ts`'s `ReleaseManifest`).
#
# Reproducibility: the manifest is byte-identical across two runs over the
# same staged tree —
#   - `version` read straight from package.json (no node module resolution),
#   - `generatedAt` = SOURCE_DATE_EPOCH (RFC-3339 UTC) if set, else now,
#   - `files[]` sorted `LC_ALL=C` by path,
#   - `migrations[]` = the TypeORM migration NAME (class-name + timestamp,
#     matching the DB `migrations.name` column), read from each compiled
#     migration's `name = '...'` field, scanned PER TAG SUBDIRECTORY and
#     sorted — the exact same shape `migration-datasource.ts`'s
#     `discoverMigrationTags()` + per-tag glob loads at deploy time.
generate_manifest() {
  local staged="$1" pkgtype="$2" baseversion="$3" mincompat="${4:-}"

  local version
  version="$("$NODE_BIN" -e '
    const fs=require("fs"), p=require("path");
    try { process.stdout.write(String(JSON.parse(fs.readFileSync(p.join(process.argv[1],"package.json"),"utf8")).version || "0.0.0")); }
    catch (e) { process.stdout.write("0.0.0"); }
  ' "$(npath "$staged")")"

  local gen_at
  if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then
    gen_at="$(date -u -d "@${SOURCE_DATE_EPOCH}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || "$NODE_BIN" -e 'process.stdout.write(new Date(Number(process.argv[1])*1000).toISOString().replace(/\.\d+Z$/,"Z"))' "$SOURCE_DATE_EPOCH")"
  else
    gen_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi

  # Hash every in-scope file in ONE `sha256sum` pass (not one process per
  # file — that made the manifest step minutes-long on a large tree).
  local shalist; shalist="$(mktemp)"
  ( cd "$staged" && find src dist public -type f -print0 2>/dev/null | xargs -0 -r sha256sum ) > "$shalist" 2>/dev/null || true

  # Metadata Contract — runtimeDependencies: the full `dependencies` object
  # from the staged package.json, copied verbatim (never re-derived/diffed;
  # `dependency-check.ts` is what proves these actually resolve, at deploy
  # time, against the candidate's own node_modules).
  local runtime_deps_json
  runtime_deps_json="$("$NODE_BIN" -e '
    const fs=require("fs"), p=require("path");
    try {
      const pkg=JSON.parse(fs.readFileSync(p.join(process.argv[1],"package.json"),"utf8"));
      process.stdout.write(JSON.stringify(pkg.dependencies||{}));
    } catch (e) { process.stdout.write("{}"); }
  ' "$(npath "$staged")")"

  # Metadata Contract — migrations[] PER TAG SUBDIRECTORY
  # (`dist/database/migrations/<tag>/[0-9]*.js`), mirroring
  # `discoverMigrationTags()`/`createMigrationDataSource()` exactly. A flat
  # `dist/database/migrations/*.js` scan would silently miss every
  # per-module-partitioned migration (the tag directories ARE the real
  # scope TypeORM loads at deploy time) — this must never re-diverge from
  # that real loader the way the pre-2026-09-15 hardcoded tag list did.
  local migrations_json migration_count
  migrations_json="$("$NODE_BIN" -e '
    const fs=require("fs"), p=require("path");
    const migRoot=process.argv[1];
    let tags=[];
    try { tags=fs.readdirSync(migRoot,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort(); } catch(e) {}
    const names=[];
    for (const tag of tags) {
      const dir=p.join(migRoot,tag);
      const files=fs.readdirSync(dir).filter(f=>/^[0-9].*\.js$/.test(f)).sort();
      for (const f of files) {
        const src=fs.readFileSync(p.join(dir,f),"utf8");
        const m=src.match(/^\s+name = ["\x27]([A-Za-z0-9_]+)["\x27]/m);
        if (m) { names.push(m[1]); continue; }
        const b=f.replace(/\.js$/,""); const i=b.indexOf("-");
        names.push(b.slice(i+1)+b.slice(0,i));
      }
    }
    names.sort();
    process.stdout.write(JSON.stringify(names));
  ' "$(npath "$staged/dist/database/migrations")" 2>/dev/null || echo '[]')"
  [ -n "$migrations_json" ] || migrations_json='[]'
  migration_count="$("$NODE_BIN" -e 'try{process.stdout.write(String(JSON.parse(process.argv[1]).length));}catch(e){process.stdout.write("0");}' "$migrations_json")"

  {
    printf '{\n'
    printf '  "version": "%s",\n' "$version"
    printf '  "packageType": "%s",\n' "$pkgtype"
    if [ -n "$baseversion" ]; then printf '  "baseVersion": "%s",\n' "$baseversion"; fi
    if [ -n "$mincompat" ]; then printf '  "minimumCompatibleVersion": "%s",\n' "$mincompat"; fi
    printf '  "generatedAt": "%s",\n' "$gen_at"
    printf '  "files": [\n'
    # Emit files[] via node: parse the sha list, forward-slash every path,
    # sort by path, format as JSON. Robust against odd path characters.
    "$NODE_BIN" -e '
      const fs=require("fs");
      const rows=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)
        .map(l=>{const m=l.match(/^([0-9a-f]{64}) [ *](.+)$/); return m?{path:m[2].replace(/\\/g,"/"),checksum:m[1]}:null;})
        .filter(Boolean)
        .sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
      process.stdout.write(rows.map(r=>"    { \"path\": "+JSON.stringify(r.path)+", \"action\": \"modify\", \"checksum\": \""+r.checksum+"\" }").join(",\n"));
    ' "$(npath "$shalist")"
    rm -f "$shalist"
    printf '\n  ],\n'
    printf '  "migrations": [\n'
    "$NODE_BIN" -e '
      const names=JSON.parse(process.argv[1]);
      process.stdout.write(names.map(n=>"    "+JSON.stringify(n)).join(",\n"));
    ' "$migrations_json"
    printf '\n  ],\n'
    printf '  "database": { "migrationRequired": %s, "migrationCount": %s },\n' "$([ "$migration_count" -gt 0 ] && echo true || echo false)" "$migration_count"
    printf '  "runtimeDependencies": %s\n' "$runtime_deps_json"
    printf '}\n'
  } > "$staged/MANIFEST.json"
}

# Content scan for accidentally-packaged secrets. Path checks alone can't
# catch a secret hard-coded inside a shipped file. Returns non-zero (and
# prints the hits) on anything that looks like a REAL credential.
#
# Scope: the runtime surface only — `src/ dist/ public/` plus a stray
# `.env*` / `.htaccess` at the package root. `tools/*.sh` (which legitimately
# reference `$DB_PASSWORD` / `$PGPASSWORD` env vars) are NOT scanned — they
# never reach the app runtime and are not part of a normal Release artifact.
#
# A "real credential" = a quoted string LITERAL of >=16 chars that contains
# both a letter and a digit, assigned to a credential-named identifier —
# NOT `$VAR`, NOT `process.env.X`, NOT a `Joi.*` schema call, NOT a
# `*_do_not_use_in_prod` dev placeholder.
scan_secrets() {
  local dir="$1" hits=0
  local roots=() d
  for d in src dist public; do [ -d "$dir/$d" ] && roots+=("$dir/$d"); done
  [ ${#roots[@]} -eq 0 ] && roots=("$dir")

  # 1. private key blocks — anywhere in the package
  if grep -rIlE -- '-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----' "$dir" 2>/dev/null | grep .; then
    echo "  secret: private key block (above)"; hits=1
  fi

  # 2. a credential-named identifier assigned a QUOTED literal with real entropy.
  #    Test fixtures (*.spec / *.test) are excluded — their fake secrets are not
  #    a deployment risk and a real artifact ships no spec files anyway.
  if grep -rInoE --include='*.ts' --include='*.js' --include='*.json' --include='*.mjs' --include='*.cjs' \
      --exclude='*.spec.*' --exclude='*.test.*' \
      -- "(PGPASSWORD|DB_PASSWORD|[A-Z_]*_SECRET|[A-Z_]*_TOKEN|[A-Z_]*_API_KEY|INTEGRATION_ENCRYPTION_KEY)['\"]?\s*[:=]\s*['\"][A-Za-z0-9+/_=.-]{16,}['\"]" "${roots[@]}" 2>/dev/null \
      | grep -vE 'do_not_use_in_prod|process\.env|Joi\.|\bexample\b' \
      | grep -E "['\"][A-Za-z0-9+/_=.-]*[A-Za-z][A-Za-z0-9+/_=.-]*['\"]" \
      | grep -E "['\"][A-Za-z0-9+/_=.-]*[0-9][A-Za-z0-9+/_=.-]*['\"]" \
      | grep .; then
    echo "  secret: hard-coded credential literal (above)"; hits=1
  fi

  # 3. LiteSpeed SetEnv secret lines — only in an actual .htaccess with a literal value ([^$] = not a var ref)
  if [ -f "$dir/.htaccess" ] && grep -nE 'SetEnv\s+(JWT_[A-Z]+_SECRET|INTEGRATION_ENCRYPTION_KEY|DB_PASSWORD)\s+[^$[:space:]]' "$dir/.htaccess" 2>/dev/null | grep .; then
    echo "  secret: SetEnv literal in .htaccess (above)"; hits=1
  fi

  # 4. any .env file other than .env.example
  if find "$dir" \( -name '.env' -o -name '.env.*' \) 2>/dev/null | grep -vE '/\.env\.example$' | grep .; then
    echo "  secret: .env file present (above; only .env.example is allowed)"; hits=1
  fi

  return $hits
}

verify_package() {
  local zip="$1"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  log "Verifying $zip"
  unzip -q "$zip" -d "$tmp"
  local root="$tmp"
  [ -f "$root/MANIFEST.json" ] || { root="$(dirname "$(find "$tmp" -name MANIFEST.json | head -1)")"; }
  [ -f "$root/MANIFEST.json" ] || { echo "FAIL: no MANIFEST.json in package"; exit 1; }

  local rc=0
  # 1. every manifest file present + checksum matches, and the Metadata
  #    Contract fields (database.migrationCount vs migrations.length,
  #    runtimeDependencies present) are internally consistent — the same
  #    check `manifest-validation.ts`'s `validateManifest()` does server-side.
  "$NODE_BIN" -e '
    const fs=require("fs"), path=require("path"), crypto=require("crypto");
    const root=process.argv[1];
    const m=JSON.parse(fs.readFileSync(path.join(root,"MANIFEST.json"),"utf8"));
    let bad=0;
    for (const f of m.files||[]) {
      const p=path.join(root,f.path);
      if (!fs.existsSync(p)) { console.log("  MISSING "+f.path); bad++; continue; }
      if (f.checksum) {
        const h=crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
        if (h!==f.checksum) { console.log("  CHECKSUM "+f.path); bad++; }
      }
    }
    console.log(`  ${m.files.length} manifest file(s), ${bad} problem(s)`);
    if (m.database) {
      const declaredCount=Array.isArray(m.migrations)?m.migrations.length:0;
      if (m.database.migrationCount!==declaredCount) { console.log("  METADATA CONTRACT: database.migrationCount("+m.database.migrationCount+") != migrations.length("+declaredCount+")"); bad++; }
      if (m.database.migrationRequired!==(declaredCount>0)) { console.log("  METADATA CONTRACT: database.migrationRequired("+m.database.migrationRequired+") disagrees with migrations.length("+declaredCount+")"); bad++; }
    } else {
      console.log("  METADATA CONTRACT: manifest has no \"database\" block"); bad++;
    }
    if (!m.runtimeDependencies || typeof m.runtimeDependencies !== "object") { console.log("  METADATA CONTRACT: manifest has no \"runtimeDependencies\""); bad++; }
    process.exit(bad?1:0);
  ' "$(npath "$root")" || rc=1

  # 2. node --check every compiled JS
  local jsbad=0
  while IFS= read -r js; do
    "$NODE_BIN" --check "$(npath "$js")" 2>/dev/null || { echo "  SYNTAX $js"; jsbad=$((jsbad+1)); rc=1; }
  done < <(find "$root/dist" -name '*.js' 2>/dev/null)
  echo "  dist JS syntax: $jsbad bad"

  # 3. no backslash paths, no .env, no node_modules
  if unzip -l "$zip" | grep -qE '\\|(^|/)\.env$|/node_modules/'; then
    echo "  FAIL: package contains a backslash path, a .env, or node_modules"
    rc=1
  fi

  # 4. frontend bundle consistency
  if [ -f "$root/public/index.html" ]; then
    bash "$BACKEND_DIR/tools/deploy/check-frontend-bundle.sh" "$root/public" || rc=1
  fi

  # 5. no accidentally-packaged secrets
  if scan_secrets "$root"; then
    echo "  secret scan: clean"
  else
    echo "  FAIL: possible secret(s) in the package (see hits above) — do not deploy"
    rc=1
  fi

  if [ $rc -eq 0 ]; then echo "VERIFY: PASSED"; else echo "VERIFY: FAILED"; fi
  return $rc
}

# Run the backend + frontend builds (extracted so --check-determinism can
# invoke the exact same steps the real build uses). Honors --skip-install.
run_builds() {
  log "Backend: install + build"
  if [ "$SKIP_INSTALL" -eq 1 ]; then
    echo "  --skip-install: reusing $BACKEND_DIR/node_modules (no npm ci)"
    # `nest build` needs @nestjs/cli (a devDependency). A node_modules that was
    # installed with omit=dev / --production won't have it — fail clearly here
    # instead of a cryptic `sh: nest: command not found` mid-build.
    if [ ! -x "$BACKEND_DIR/node_modules/.bin/nest" ] && [ ! -f "$BACKEND_DIR/node_modules/@nestjs/cli/bin/nest.js" ]; then
      echo "FATAL: --skip-install, but @nestjs/cli is not in $BACKEND_DIR/node_modules."
      echo "  The build toolchain (devDependencies) is missing. Run this WITHOUT --skip-install"
      echo "  (it does 'npm ci --include=dev'), or run 'npm ci --include=dev' first."
      echo "  Do NOT install the build tool by hand (npm i --no-save)."
      exit 3
    fi
    ( cd "$BACKEND_DIR" && "$NPM_BIN" run build && "$NODE_BIN" tools/validation/check-dist-integrity.js )
  else
    # --include=dev so the build toolchain (@nestjs/cli, typescript, ts-loader,
    # tsconfig-paths, source-map-support) installs even when the environment
    # has omit=dev configured (CloudLinux nodevenv / NODE_ENV=production).
    ( cd "$BACKEND_DIR" && "$NPM_BIN" ci --include=dev && "$NPM_BIN" run build && "$NODE_BIN" tools/validation/check-dist-integrity.js )
  fi

  log "Frontend: install (with dev deps) + build   ($FRONTEND_DIR)"
  if [ "$SKIP_INSTALL" -eq 1 ]; then
    echo "  --skip-install: reusing $FRONTEND_DIR/node_modules (no npm ci)"
    if [ ! -x "$FRONTEND_DIR/node_modules/.bin/vite" ]; then
      echo "FATAL: --skip-install, but vite is not in $FRONTEND_DIR/node_modules."
      echo "  Run without --skip-install (does 'npm ci --include=dev'), or 'npm ci --include=dev' first."
      exit 3
    fi
    ( cd "$FRONTEND_DIR" && RAYON_NUM_THREADS="$MAX_THREADS" "$NPM_BIN" run build )
  else
    ( cd "$FRONTEND_DIR" && "$NPM_BIN" ci --include=dev \
      && RAYON_NUM_THREADS="$MAX_THREADS" "$NPM_BIN" run build )
  fi
}

# Clean the build outputs so run_builds does a true clean build (determinism
# check + reproducible release both need this — no incremental tsbuildinfo reuse).
clean_build_outputs() {
  ( cd "$BACKEND_DIR" && rm -rf dist tsconfig.build.tsbuildinfo )
  ( cd "$FRONTEND_DIR" && rm -rf dist )
}

# Assemble the Release Artifact tree at $1 from the CURRENT build outputs.
# cp -> hygiene -> secret scan -> MANIFEST.json.  Returns non-zero on a secret
# hit (fail-closed; caller must STOP).  Writes ONLY inside $1.
assemble_staged() {
  local pkg="$1"
  mkdir -p "$pkg"
  cp -r "$BACKEND_DIR/dist" "$pkg/dist"
  cp -r "$BACKEND_DIR/src" "$pkg/src"
  mkdir -p "$pkg/public"
  cp -r "$FRONTEND_DIR/dist/." "$pkg/public/"
  cp "$BACKEND_DIR/package.json" "$BACKEND_DIR/package-lock.json" "$pkg/"

  # hygiene: no test files, no incremental-build cache, no .env, POSIX perms.
  find "$pkg" \( -name '*.spec.ts' -o -name '*.spec.js' -o -name '*.test.ts' -o -name '*.test.js' \) -delete
  find "$pkg" \( -name '*.tsbuildinfo' \) -delete
  find "$pkg" -name '.env' -delete
  find "$pkg" -type d -exec chmod 755 {} +
  find "$pkg" -type f -exec chmod 644 {} +

  if ! scan_secrets "$pkg"; then
    echo "ABORT: possible secret(s) in the staged tree (see hits above)."
    return 1
  fi

  generate_manifest "$pkg" "$PKG_TYPE" "$BASE_VERSION" "$MIN_COMPATIBLE_VERSION"
}

# Refuse to write a package into a place that is (or is inside) a live runtime
# or the working source tree. The build NEVER touches an ACTIVE release.
assert_out_dir_safe() {
  local out; out="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" || out="$1"
  local app_root=""; [ -n "${RELEASE_APP_ROOT:-}" ] && app_root="$(cd "${RELEASE_APP_ROOT}" 2>/dev/null && pwd || echo "${RELEASE_APP_ROOT%/}")"
  local deploy_root=""; [ -n "${RELEASE_DEPLOY_ROOT:-}" ] && deploy_root="$(cd "${RELEASE_DEPLOY_ROOT}" 2>/dev/null && pwd || echo "${RELEASE_DEPLOY_ROOT%/}")"
  local p="$out"
  while [ "$p" != "/" ] && [ -n "$p" ]; do
    if [ -f "$p/dist/main.js" ] && { [ -f "$p/.htaccess" ] || [ -e "$p/tmp/restart.txt" ]; }; then
      echo "FATAL: --out '$1' is inside what looks like a live runtime ($p). The build must never write into an ACTIVE release."; exit 2
    fi
    case "$p" in
      "$BACKEND_DIR"/src|"$BACKEND_DIR"/src/*|"$BACKEND_DIR"/dist|"$BACKEND_DIR"/dist/*|"$FRONTEND_DIR"/src|"$FRONTEND_DIR"/src/*|"$FRONTEND_DIR"/dist|"$FRONTEND_DIR"/dist/*)
        echo "FATAL: --out '$1' is inside a build source/output dir ($p). Write the artifact outside src/ and dist/."; exit 2 ;;
    esac
    [ -n "$app_root" ] && [ "$p" = "$app_root" ] && { echo "FATAL: --out '$1' is inside RELEASE_APP_ROOT ($p) — that is an ACTIVE release."; exit 2; }
    [ -n "$deploy_root" ] && [ "$p" = "$deploy_root" ] && { echo "FATAL: --out '$1' is inside RELEASE_DEPLOY_ROOT ($p) — deploy-engine territory."; exit 2; }
    p="$(dirname "$p")"
  done
}

# --check-determinism: build + assemble TWICE (fixed SOURCE_DATE_EPOCH), then
# compare every file. Writes determinism-report.txt. Non-zero exit on any diff.
check_determinism() {
  : "${SOURCE_DATE_EPOCH:=1735689600}"; export SOURCE_DATE_EPOCH   # 2025-01-01T00:00:00Z
  local d; d="$(mktemp -d)"
  local report="$OUT_DIR/determinism-report.txt"
  mkdir -p "$OUT_DIR"

  log "Determinism check — clean build + assemble, TWICE, then compare"
  echo "  SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH  skip-install=$SKIP_INSTALL  NODE=$("$NODE_BIN" -v)"

  clean_build_outputs; run_builds; assemble_staged "$d/A" || { echo "assemble A failed"; exit 1; }
  clean_build_outputs; run_builds; assemble_staged "$d/B" || { echo "assemble B failed"; exit 1; }

  "$NODE_BIN" -e '
    const fs=require("fs"), p=require("path"), crypto=require("crypto");
    const [,A,B,report,node,sde]=process.argv;
    const walk=(root,base="",acc={})=>{for(const n of fs.readdirSync(p.join(root,base))){const rel=base?base+"/"+n:n;const abs=p.join(root,rel);fs.statSync(abs).isDirectory()?walk(root,rel,acc):acc[rel]=crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");}return acc;};
    const a=walk(A), b=walk(B);
    const all=[...new Set([...Object.keys(a),...Object.keys(b)])].sort();
    let same=0; const differ=[], onlyA=[], onlyB=[];
    for(const f of all){ if(!(f in b))onlyB.push(f); else if(!(f in a))onlyA.push(f); else if(a[f]===b[f])same++; else differ.push(f); }
    const ok = differ.length===0 && onlyA.length===0 && onlyB.length===0;
    const lines=[
      "Daii — Build & Release Packaging — Determinism Report",
      "generated: "+new Date().toISOString(),
      "node: "+node+"   SOURCE_DATE_EPOCH: "+sde,
      "method: clean build + assemble, run twice, compare every file by SHA-256",
      "",
      "files compared: "+all.length,
      "identical:      "+same,
      "DIFFER:         "+differ.length,
      "only in run A:  "+onlyA.length,
      "only in run B:  "+onlyB.length,
      "",
      "VERDICT: "+(ok?"DETERMINISTIC":"NON-DETERMINISTIC"),
    ];
    if(differ.length) lines.push("", "-- differing files --", ...differ);
    if(onlyA.length)  lines.push("", "-- only in run A --", ...onlyA);
    if(onlyB.length)  lines.push("", "-- only in run B --", ...onlyB);
    fs.writeFileSync(report, lines.join("\n")+"\n");
    console.log(lines.slice(4).join("\n"));
    process.exit(ok?0:1);
  ' "$(npath "$d/A")" "$(npath "$d/B")" "$(npath "$(dirname "$report")")/$(basename "$report")" "$("$NODE_BIN" -v)" "$SOURCE_DATE_EPOCH"
  local rc=$?
  echo; echo "report: $report"
  rm -rf "$d"
  return $rc
}

# ---- arg parsing --------------------------------------------------------
MIN_COMPATIBLE_VERSION="${RELEASE_MIN_COMPATIBLE_VERSION:-}"

if [ "${1:-}" = "--verify" ]; then verify_package "$2"; exit $?; fi
if [ "${1:-}" = "--manifest-only" ]; then
  shift
  MANIFEST_STAGED_DIR="$1"; shift || true
  MANIFEST_PKG_TYPE="full"; MANIFEST_BASE_VERSION=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --package-type) MANIFEST_PKG_TYPE="$2"; shift 2 ;;
      --base-version) MANIFEST_BASE_VERSION="$2"; shift 2 ;;
      --min-compatible-version) MIN_COMPATIBLE_VERSION="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  generate_manifest "$MANIFEST_STAGED_DIR" "$MANIFEST_PKG_TYPE" "$MANIFEST_BASE_VERSION" "$MIN_COMPATIBLE_VERSION"
  echo "wrote $MANIFEST_STAGED_DIR/MANIFEST.json"
  exit 0
fi

PKG_TYPE="full"; BASE_VERSION=""; OUT_DIR="$BACKEND_DIR/_deploy/build"
MODE="build"
while [ $# -gt 0 ]; do
  case "$1" in
    --package-type) PKG_TYPE="$2"; shift 2 ;;
    --base-version) BASE_VERSION="$2"; shift 2 ;;
    --min-compatible-version) MIN_COMPATIBLE_VERSION="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --check-determinism) MODE="determinism"; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

log "Build environment"
echo "  NODE_BIN     = $NODE_BIN ($("$NODE_BIN" -v))"
echo "  NPM_BIN      = $NPM_BIN"
echo "  FRONTEND_DIR = $FRONTEND_DIR"
echo "  OUT_DIR      = $OUT_DIR"
echo "  MIN_COMPATIBLE_VERSION = ${MIN_COMPATIBLE_VERSION:-<none>}"
echo "  RAYON_NUM_THREADS / RELEASE_BUILD_MAX_THREADS = $MAX_THREADS"
echo "  skip-install = $SKIP_INSTALL   mode = $MODE"
export PATH="$NODE_DIR:$PATH"   # only so `#!/usr/bin/env node` tools resolve the right node

assert_out_dir_safe "$OUT_DIR"

# `build` and `determinism` both build the frontend — it must have resolved.
if [ -z "$FRONTEND_DIR" ]; then
  echo "FATAL: could not locate the frontend source tree. Looked for a dir with"
  echo "  package.json + a vite config / index.html at, in order:"
  echo "    \$RELEASE_FRONTEND_DIR (${RELEASE_FRONTEND_DIR:-<unset>})"
  echo "    $BACKEND_DIR/../frontend      (sibling — dev workspace layout)"
  echo "    $BACKEND_DIR/frontend         (child  — packaged / extracted layout)"
  echo "    $BACKEND_DIR/../../frontend"
  echo "  Fix the repository/package layout so one of these holds — do NOT pass a manual override on the server."
  exit 3
fi

if [ "$MODE" = "determinism" ]; then
  check_determinism; exit $?
fi

VERSION="$("$NODE_BIN" -e '
  const fs=require("fs"),p=require("path");
  try{process.stdout.write(String(JSON.parse(fs.readFileSync(p.join(process.argv[1],"package.json"),"utf8")).version||"0.0.0"));}
  catch(e){process.stdout.write("0.0.0");}
' "$BACKEND_DIR")"
STAMP="$(date -u +%Y-%m-%d)"
STAGE="$(mktemp -d)"
PKG_NAME="Daii-Release-v${VERSION}-${STAMP}"

run_builds

log "Assembling package $PKG_NAME"
if ! assemble_staged "$STAGE/$PKG_NAME"; then
  echo "ABORT: not packaging (see hits above). ACTIVE release untouched."
  rm -rf "$STAGE"
  exit 1
fi

mkdir -p "$OUT_DIR"
make_zip "$STAGE/$PKG_NAME" "$OUT_DIR/${PKG_NAME}.zip"
sha256_of "$OUT_DIR/${PKG_NAME}.zip" > "$OUT_DIR/${PKG_NAME}.zip.sha256"

log "Verifying the package we just built"
verify_package "$OUT_DIR/${PKG_NAME}.zip"

rm -rf "$STAGE"
echo
echo "Package: $OUT_DIR/${PKG_NAME}.zip"
echo "SHA256 : $(cat "$OUT_DIR/${PKG_NAME}.zip.sha256")"
