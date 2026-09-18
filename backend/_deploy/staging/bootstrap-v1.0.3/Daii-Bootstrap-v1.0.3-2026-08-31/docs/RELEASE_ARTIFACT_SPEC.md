# Daii — Release Artifact Specification

The one format every future Release / Delta upload MUST follow so the
Release Center can validate → back up → stage → deploy → verify → roll back
with no manual SSH steps. Built by `tools/build/build-release.sh`, consumed
by `PackageValidatorService` + `ReleaseExecutionService`.

## 1. Container

- A single **`.zip`** (not `.tar`, not `.tar.gz` — `PackageValidatorService`
  streams it via `yauzl`).
- One top-level directory: `Daii-Release-v<version>-<YYYY-MM-DD>/`.
- A sibling `<name>.zip.sha256` (single line: the hex digest).
- **All entry paths use `/`** — never `\`. A backslash entry is rejected
  outright (v1.0.3 report item 11). `build-release.sh` builds with `zip`
  or a `yazl` fallback, never a tool that emits Windows separators.
- Permissions inside: dirs `755`, files `644` (v1.0.3 report item 12).
- **No `node_modules/`** — ever. It is a symlink to the nodevenv on the
  host; the deploy must never touch it. New runtime dependencies are
  installed with `$NPM_BIN install` on the host (see §5), not shipped.
- **No `.env` / `.env.*`** (except `.env.example`). No secrets in any file.
- **No `*.sh`/`*.exe`/`*.bat`/`*.ps1`/`*.dll`/`*.so`/`*.cmd`/`*.msi`.**

## 2. Contents (allowed top-level prefixes: `src/`, `dist/`, `public/`)

```
Daii-Release-v1.0.4-2026-09-01/
├── MANIFEST.json              # REQUIRED — see RELEASE_MANIFEST_SPEC.md
├── package.json               # target version — MUST equal MANIFEST.version
├── package-lock.json          # for `npm install` of any new deps on the host
├── dist/                      # compiled backend (the running app)
│   ├── main.js
│   └── database/
│       ├── data-source.js     # REQUIRED if the release touches migrations
│       └── migrations/[0-9]*.js   # timestamped only — NO *.spec.js / *.test.js
├── src/                       # backend source (traceability; not executed)
└── public/                    # frontend build output → served from backend/public
    ├── index.html
    └── assets/index-<hash>.{js,css}
```

- **Frontend goes under `public/`**, never `frontend/dist/` (v1.0.3 report
  item 5). `build-release.sh` copies `frontend/dist/*` → `public/`.
- If the package contains `public/index.html`, it MUST also contain every
  `assets/*.{js,css}` that `index.html` references (frontend-bundle-drift
  guard — the exact v1.0.3 site bug). Enforced by `PackageValidatorService`.

## 3. Full vs Delta

| | `full` | `delta` |
|---|---|---|
| `MANIFEST.baseVersion` | optional | **required** |
| base-version check | — | installed version MUST equal `baseVersion`, else `validation_failed` / REJECT (v1.0.3 report §4) |
| file list | complete tree | only changed/new files (+ their matching `dist/`) |
| `action` per file | `modify` (or `add`) | `add` / `modify` / `delete` |

## 4. Integrity

- Every non-`delete` manifest file carries a SHA-256 `checksum`.
- `PackageValidatorService` cross-checks **both directions**: every manifest
  file is staged with a matching checksum, AND every staged file (besides
  `MANIFEST.json`) is declared. A smuggled extra file fails validation.
- `build-release.sh --verify <zip>` re-does all of the above offline plus
  `node --check` on every `dist/**/*.js`.

## 5. Host dependency note (Release Center bootstrap)

The Release Center adds runtime deps (`yauzl`, `multer`, `@types/*` are
dev). The **first** delta that carries `src/foundation/release/` must be
followed on the host by:

```
cd /home/xnexdrgr/daii.xnexustech.com/release-new/backend
"$NPM_BIN" install        # resolves new deps into the nodevenv lib
```

before restarting. `package-lock.json` in the artifact makes this
deterministic. Subsequent deltas that don't change dependencies skip this.

## 6. What the operator uploads

Just the `.zip`. Everything else — checksum verify, base-version check,
backup, stage, build (if needed), migrate, publish to `public/`, restart,
health check, rollback — is the pipeline's job (`DEPLOYMENT_ARCHITECTURE.md`).
