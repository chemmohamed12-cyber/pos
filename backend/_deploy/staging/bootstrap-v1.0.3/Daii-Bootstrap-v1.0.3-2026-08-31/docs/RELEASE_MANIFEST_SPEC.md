# Daii — Release Manifest Specification (`MANIFEST.json`)

The machine-readable descriptor at the root of every release artifact.
Schema source of truth: `src/foundation/release/release-manifest.ts`
(`ReleaseManifest`), validated by
`src/foundation/release/manifest-validation.ts` (`validateManifest`).

## Shape

```jsonc
{
  "version": "1.0.4",                 // REQUIRED — the version this package installs; MUST equal package.json version
  "packageType": "delta",             // "full" | "delta"  (also passed as a form field on upload)
  "baseVersion": "1.0.3",             // REQUIRED for "delta"; the installed version this delta applies onto
  "generatedAt": "2026-09-01T10:00:00Z",

  "files": [
    { "path": "dist/main.js",                    "action": "modify", "checksum": "<sha256 hex>" },
    { "path": "dist/database/migrations/1755853300000-Foo.js", "action": "add", "checksum": "<sha256 hex>" },
    { "path": "public/index.html",               "action": "modify", "checksum": "<sha256 hex>" },
    { "path": "public/assets/index-a1b2c3.js",    "action": "add",    "checksum": "<sha256 hex>" },
    { "path": "src/legacy/removed.ts",            "action": "delete" }          // no checksum for delete
  ],

  "migrations": [                      // migration NAMES this release expects to run, in order (traceability)
    "AddSalesOrderSkipDeposit1755852300000",
    "FixGenRandomUuidRfc4122Compliance1755852500000"
  ],

  "dependencyChanges": {               // optional — informational; triggers the `npm install` bootstrap note
    "yauzl": "^3.4.0",
    "multer": "^1.4.5-lts.1"
  },

  "rollbackInstructions": "…"          // optional free text shown to the operator
}
```

## Field rules (`validateManifest`)

| Field | Rule |
|---|---|
| `version` | non-empty string; `PackageValidator` also requires `== package.json` version |
| `packageType` | `"full"` or `"delta"` |
| `baseVersion` | required + non-empty when `packageType === "delta"`; ignored for `"full"` |
| `files` | non-empty array |
| `files[].path` | relative, `/`-separated, starts with `src/`, `dist/`, or `public/` (or is `MANIFEST.json`); no `..`, no absolute, no backslash |
| `files[].action` | `"add"` \| `"modify"` \| `"delete"` |
| `files[].checksum` | SHA-256 hex, **required** for `add`/`modify`, **absent** for `delete` |
| `migrations` | array of strings (may be empty) |

## Deployment-gate semantics

- **Base version**: `packageType === "delta"` and `baseVersion !==` the
  currently installed version → release is recorded `validation_failed`
  and cannot be deployed (v1.0.3 report §4: "REJECT UPDATE").
- **Manifest tamper**: `ReleaseManagerService` stores a SHA-256 of the
  canonical manifest JSON on the `releases` row; a later mismatch is
  detectable.
- **Frontend bundle**: if any `files[].path` is `public/index.html`
  (add/modify), every `assets/*.{js,css}` referenced by that `index.html`
  must also appear in `files` with a staged, checksummed copy.
- **Migration hygiene** (checked at deploy preflight, not manifest parse):
  the staged `dist/database/migrations/` must contain **no** `*.spec.js` /
  `*.test.js`, and if it contains any migration the package must ship
  `dist/database/data-source.js`.

## Backup manifest (separate — `BACKUP_RESTORE_RUNBOOK.md`)

Not the same file. `BackupManagerService` writes
`<backup-storage>/manifests/<backupRunId>.json`
(`schema: "daii.backup-manifest/1"`): backup run id, status, source app
version, DB name + migration head, Node/platform, artifact list with
`sha256`, app roots. It links a backup to what it can restore; the release
manifest describes what a package deploys.
