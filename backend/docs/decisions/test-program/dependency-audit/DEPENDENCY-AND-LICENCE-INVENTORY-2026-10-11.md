# Dependency and licence inventory (backend) — offline, read-only (2026-10-11)

Scope: `backend/package.json` + `package-lock.json` (lockfile v3) + installed `node_modules` metadata. **No network access, no installs, no upgrades, no secrets involved.** Raw data: `offline-inventory-2026-10-11.json`; cross-check with the parallel track's `docs/decisions/test-03/evidence/license-scan.json` (same total of 908 packages). The frontend and the other projects are not covered here.

## 1. Confirmed facts (from the lock file / installed metadata)
| Item | Value |
|---|---|
| Direct dependencies / devDependencies | 19 / 23 |
| Packages in the lock file | 908 (387 production-reachable, 521 dev-only; the parallel scan counts 369 runtime with a different reachability rule) |
| Own package licence | `UNLICENSED` (package.json); no `LICENSE` file is tracked in the repository |
| Dominant licences | MIT 708 · ISC 98 · Apache-2.0 31 · BSD-3-Clause 31 · BSD-2-Clause 18 · BlueOak-1.0.0 5 · Unlicense 3 · others ≤ 2 each |
| `node` engines | >= 20 |

## 2. Separated findings
**A. Confirmed vulnerabilities — NONE CONFIRMED, NOT ASSESSED.** A vulnerability statement needs the advisory database; that requires network access (see §4). Absence of findings here is NOT evidence of safety.

**B. Deprecated packages (deprecation flag present in the lock file) — 22 entries.** Production-reachable ones and who pulls them in:
| Package | Pulled in by (direct dependency chain) |
|---|---|
| `tar@6.2.1`, `npmlog@5.0.1`, `gauge@3.0.2`, `are-we-there-yet@2.0.0`, `rimraf@3.0.2/2.7.1`, `glob@7.2.3`, `inflight@1.0.6` | `bcrypt` → `@mapbox/node-pre-gyp` (native-module installer chain) |
| `fstream@1.0.12`, `rimraf@2.7.1`, `lodash.isequal@4.5.0`, `uuid@8.3.2/9.0.1` | `exceljs` (→ `unzipper` → `fstream`; → `fast-csv`; → `uuid`); `@nestjs/typeorm` → `uuid` |
| `glob@10.5.0` | transitive of production tooling |
Dev-only: `eslint@9.39.5`, `glob@7.2.3/10.4.5` (jest chain). Whether a deprecation is a security issue is **not determined offline** (the `tar` deprecation notice is security-related in npm's metadata and must be verified through the advisory check).

**C. Undeclared licence metadata**
- `buffers@0.1.1` (production, via `exceljs` → `unzipper` → `binary`): **no licence field at all** — needs a licence determination from the upstream repository/LICENSE text (legal/engineering follow-up).
- `busboy`, `streamsearch`, `exit`: licence declared only in the legacy `licenses: [{type: "MIT", url}]` array form (the parallel scan reports them as UNDECLARED; they declare MIT, in an old format).
- Own package: `UNLICENSED` and no LICENSE file → the project's own licensing statement is a business decision.

**D. Needs legal interpretation (not decided here)**
- `jszip@3.10.1` (production via `exceljs`): `(MIT OR GPL-3.0-or-later)` — dual licence; elect MIT in the notice/compliance record.
- `(MIT AND Zlib)`, `(MIT AND BSD-3-Clause)`: attribution requirements of both parts.
- `caniuse-lite` CC-BY-4.0 (dev-only data), `argparse` Python-2.0 (dev), `BlueOak-1.0.0` (5, mostly production-reachable: `jackspeak`, `minipass`, `path-scurry`, `package-json-from-dist`; permissive), `Unlicense` (3, incl. `big-integer` in production), `0BSD` (`tslib`), `MIT/X11` (`chainsaw`, `traverse`): permissive; listed so counsel can confirm a notices file can include them.
- No GPL/AGPL/LGPL-only (non-dual) production package was found by the pattern scan.

## 3. What was NOT done and why
No upgrade, no `npm install/audit fix`, no lock-file change. No advisory lookup (needs network). No SBOM signing. No review of the frontend bundle's dependencies.

## 4. Network authorization needed before the external audit
Command (read-only; sends package names and versions from the lock file, no source code and no secrets, to the npm registry's audit endpoint): `npm audit --omit=dev --json` (production) and `npm audit --json` (all), run from `backend/` after the CTO authorises outbound HTTPS to `registry.npmjs.org` for this purpose. Alternative without network: an offline advisory database export approved by the CTO. Requested authorisation: **one-time outbound HTTPS to registry.npmjs.org for `npm audit` (no install)**. Output to be stored under this folder; findings classified as confirmed / reachable / not reachable, with no automatic upgrades.
