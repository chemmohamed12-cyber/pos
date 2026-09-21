# Release Package Manifest — v1.1.1 (human-readable)

This is the human-readable companion to the package's own machine-
readable `MANIFEST.json` (inside the zip, at its root) — the Metadata
Contract `migration-preflight.ts`/`manifest-validation.ts` actually
read at deploy time. This file summarizes it; it is not itself consumed
by any tooling.

**v1.1.0 is superseded — do not use it.** It was uploaded to the real
Hosting Release Center and **failed candidate verification**
(`dependencies_resolve`: `@types/yauzl` missing from `node_modules`,
2026-09-21 14:26). Root cause and fix: `@types/yauzl` was misdeclared
under `dependencies` instead of `devDependencies` in `package.json` (a
TypeScript type-definitions-only package, no runtime code) — moved to
`devDependencies`; the real `yauzl` runtime package was and remains
correctly in `dependencies`. See `CHANGELOG.md`'s `[1.1.1]` entry and
commit `a8a277d` for the full investigation. v1.1.0 was never activated
on Hosting — this was a candidate-verification rejection, not a rollback
of a live deployment.

## Package identity

| Field | Value |
|---|---|
| Package | `Daii-Release-v1.1.1-2026-09-21.zip` |
| Version | `1.1.1` |
| Package type | `full` |
| Built by | `tools/build/build-release.sh` (this project's own approved release engine) |
| SHA-256 (package) | `355f8d1a1cfb29e3153999acede70b08604e1d4e4c2ea6dddf285571261d6975` |
| Location | `_release-output/Daii-Release-v1.1.1-2026-09-21.zip` (+ `.sha256` sidecar) |
| Superseded package | `Daii-Release-v1.1.0-2026-09-21.zip` — FAILED real candidate verification, do not upload |

## Contents

- **3128** files under `dist/`, `src/`, `public/` — each individually
  SHA-256-checksummed in `MANIFEST.json`'s own `files[]` array.
- **234** migrations total in the package (all of them — this is a
  `full` package type, not a delta); **8 new** in this release (unchanged
  from v1.1.0 — this correction touched only dependency classification,
  no schema change), listed in `MIGRATION_REPORT.md`.
- **19** runtime dependencies declared (`runtimeDependencies`) — **20 in
  the superseded v1.1.0** (`@types/yauzl` no longer declared as a runtime
  dependency at all, per the fix above). Copied verbatim from the staged
  `package.json`'s own `dependencies` — cross-checked against the deploy
  target's real `node_modules` by `dependency-check.ts` at deploy time.
- `database.migrationRequired: true`, `database.migrationCount: 234` —
  internally consistent with the `migrations[]` array length.

## Verification already performed (by the build engine itself)

```
3128 manifest file(s), 0 problem(s)   — every file present, every checksum matches
dist JS syntax: 0 bad                 — every compiled file parses (node --check)
served bundle is internally consistent — frontend HTML references match built assets
secret scan: clean                    — no private key, credential literal, or .env packaged
no backslash paths, no .env, no node_modules in the archive
VERIFY: PASSED
```

**Additionally, for this release specifically**, the exact real check the
Hosting candidate-verification gate runs (`checkDependenciesResolve`,
`dependency-check.ts`) was re-run directly against the corrected source
tree: `{ "ok": true, "missing": [], "detail": "all 19 declared
dependencies resolve from the tree's node_modules" }`.

Re-run the build engine's own verification independently at any time:
```bash
bash backend/tools/build/build-release.sh --verify _release-output/Daii-Release-v1.1.1-2026-09-21.zip
```

## Companion documents

| Document | Purpose |
|---|---|
| `RELEASE_NOTES.md` | What's new, who should test it, what's excluded |
| `CHANGELOG.md` | Full dated changelog entry, including the `[1.1.1]` correction |
| `RELEASE_CANDIDATE_REVIEW.md` | Phase 1 review across every named area, PASS/FIX-REQUIRED/BLOCKED classification |
| `TEST_REPORT.md` | The definitive test evidence — 213/213, 26/26 suites |
| `MIGRATION_REPORT.md` | The 8 new migrations, reversibility, and what does/doesn't ship with the package |
| `DEPLOY_INSTRUCTIONS.md` | How to load this package onto a Hosting-test target — not a deployment authorization |
