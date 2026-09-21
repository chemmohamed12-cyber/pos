# Release Package Manifest — v1.1.0 (human-readable)

This is the human-readable companion to the package's own machine-
readable `MANIFEST.json` (inside the zip, at its root) — the Metadata
Contract `migration-preflight.ts`/`manifest-validation.ts` actually
read at deploy time. This file summarizes it; it is not itself consumed
by any tooling.

## Package identity

| Field | Value |
|---|---|
| Package | `Daii-Release-v1.1.0-2026-09-21.zip` |
| Version | `1.1.0` |
| Package type | `full` |
| Generated at | `2026-09-21T06:06:22Z` |
| Built by | `tools/build/build-release.sh` (this project's own approved release engine) |
| SHA-256 (package) | `27875a4cf01bf84724731b01762087de217dd07da721f24199fc4af198d4dc34` |
| Location | `_release-output/Daii-Release-v1.1.0-2026-09-21.zip` (+ `.sha256` sidecar) |

## Contents

- **3128** files under `dist/`, `src/`, `public/` — each individually
  SHA-256-checksummed in `MANIFEST.json`'s own `files[]` array.
- **234** migrations total in the package (all of them — this is a
  `full` package type, not a delta); **8 new** in this release, listed
  in `MIGRATION_REPORT.md`.
- **20** runtime dependencies declared (`runtimeDependencies`), copied
  verbatim from the staged `package.json`'s own `dependencies` — cross-
  checked against the deploy target's real `node_modules` by
  `dependency-check.ts` at deploy time, not asserted here.
- `database.migrationRequired: true`, `database.migrationCount: 234` —
  internally consistent with the `migrations[]` array length (verified
  by the build script's own `--verify` step, and independently
  re-derivable from `MANIFEST.json` itself).

## Verification already performed (by the build engine itself)

```
3128 manifest file(s), 0 problem(s)   — every file present, every checksum matches
dist JS syntax: 0 bad                 — every compiled file parses (node --check)
served bundle is internally consistent — frontend HTML references match built assets
secret scan: clean                    — no private key, credential literal, or .env packaged
no backslash paths, no .env, no node_modules in the archive
VERIFY: PASSED
```

Re-run independently at any time:
```bash
bash backend/tools/build/build-release.sh --verify _release-output/Daii-Release-v1.1.0-2026-09-21.zip
```

## Companion documents

| Document | Purpose |
|---|---|
| `RELEASE_NOTES.md` | What's new, who should test it, what's excluded |
| `CHANGELOG.md` | Full dated changelog entry |
| `RELEASE_CANDIDATE_REVIEW.md` | Phase 1 review across every named area, PASS/FIX-REQUIRED/BLOCKED classification, the one defect found and fixed |
| `TEST_REPORT.md` | The definitive test evidence — 211/211, 25/25 suites |
| `MIGRATION_REPORT.md` | The 8 new migrations, reversibility, and what does/doesn't ship with the package |
| `DEPLOY_INSTRUCTIONS.md` | How to load this package onto a Hosting-test target — not a deployment authorization |
