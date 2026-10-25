# T-1 — HR & Attendance baseline verification (isolated) — 2026-10-25

**Authorization:** CTO decision "C16 Resolution, Contract Closure & Controlled GO" — Gate T-1 GO.
**Result summary:** `PASS` for the scope the DB guard allows to run (2 real-Postgres suites, 11 tests; backend type-check/build). The three **functional** HR/Attendance suites (`hr-phase1`, `attendance-phase1`, `attendance-biometric-import`) are `BLOCKED` — they need an "ambient" platform database and the DB guard refuses to create one (see §4). T-1 therefore is **not a full baseline**; it is a verified partial baseline. No failure, no regression observed in what ran.

## 1. Environment (preserved original untouched)
| Item | Value |
|---|---|
| Source commit | `2fe55a87343d2cf01253647fa859bc4a566d1364` (branch `docs/hr-payroll-integration-audit`); `git diff b661124 2fe55a8 -- backend/src` is empty ⇒ backend code = `b661124` (committed HEAD of `feature/direct-sale-shipping`) |
| Why a snapshot | the main checkout has other sessions' uncommitted edits; the run uses `git archive` of a committed ref only |
| Snapshot path | `D:\s\t1\backend` (short path; extracted with `git archive --format=tar` + `tar -x`) |
| Dependencies | `node_modules` = **junction (read-only use)** to the main checkout's `backend/node_modules`; `package.json` and `package-lock.json` byte-identical to the snapshot's (`cmp`) ; **no `npm ci` / install / rebuild of any shared directory** |
| Runtime | Node v20.20.2, TypeScript 5.9.3 |
| Database cluster | dedicated test cluster `127.0.0.1:5546` (PostgreSQL 18.6), `systemIdentifier 7695619915229547252` = the `expectedSystemIdentifier` in the guard's approved list; harness guard `tools/testing/db-guard.js` preflight accepted |
| Database identity used by specs | disposable databases created by the specs' own harness, namespace `biz_t41_` (`daii_test_biz_t41_*`); no database of other sessions was read or modified (pre-run listing showed t54…t98 databases of other work; untouched) |
| Shared systems untouched | `daii_dev`, company databases, ports 5173/3500, 5433 — not used |
| Peers | all five peer sessions were `idle` (ListAgents) and `pg_stat_activity` showed no `daii_test_*` activity before the run |

## 2. Commands and results
| # | Command (working dir `D:\s\t1\backend`) | Result | Evidence |
|---|---|---|---|
| 1 | `node_modules\.bin\tsc.cmd -p tsconfig.build.json` | **PASS** — exit 0, 32.3 s (builds `dist`, needed by the harness; also the type check) | this report |
| 2 | `REGRESSION_NS=biz_t41_ DAII_SOURCE_COMMIT=2fe55a8 node tools/testing/biz-run.js --regression tools/testing/t1-hr-attendance.txt` (list = the 2 specs below; list file exists only in the snapshot) | **PASS 2/2**, exit 0, 19:36:17 → 19:38:06 (+03:00) | `t1-isolation-run.log` |

| Suite | Tests | Result |
|---|---|---|
| `src/domains/hr/interface/hr.company-isolation.spec.ts` | 6/6 | PASS |
| `src/domains/attendance/interface/attendance.company-isolation.spec.ts` | 5/5 | PASS |

Covered by those 11 tests: employee/department creation with per-Company numbering; cross-Company read/edit/reference refused; status, termination, manager and **user link** inside the Company (one User can be an Employee in two Companies independently); leave-request round-trip and maker-only cancel; punches, connectors/mappings, approval batches (SoD across Companies), post-approval correction needing re-approval; no leakage between Company tables.

## 3. Post-run cleanup (scoped)
No `daii_test_biz_t41_*` database remained after the run (checked by listing `pg_database`). Nothing else was deleted. The snapshot folder `D:\s\t1` is kept until Gate B-1's own run is finished, then removed junction-first (`[System.IO.Directory]::Delete(junction,$false)`) — never `rm -rf` through the junction.

## 4. What did NOT run (and why)
| Item | Status | Reason |
|---|---|---|
| `hr-phase1.spec.ts` (ambient) | **BLOCKED** | needs a seeded ambient platform DB; the guard's approved entry allows only `daii_test_biz_tNN…` databases created by the harness; `daii_test_ambient` is `blockedAlways` |
| `attendance-phase1.spec.ts`, `attendance-biometric-import.spec.ts` (ambient) | **BLOCKED** | same |
| Attempt made | one: `provision-isolated-ambient-db.js --db daii_test_biz_t41_ambient` on 5546 → **REFUSED by the guard** ("not an approved disposable database name"; "Nothing was executed"). Not retried, not bypassed. The wrapper script's final cleanup then issued `DROP DATABASE IF EXISTS` for that same non-existent name through an unguarded client in the parent process (no effect; the database never existed). Recorded for transparency. | |
| Payroll / Commission / Targets suites | **NOT RUN** | outside T-1 scope (C16 freeze) |
| Lint, full unit suite, full regression | **NOT RUN** | outside T-1 scope |

## 5. Verdict
- No failure or regression in the executed scope.
- Baseline is **partial**: functional suites BLOCKED by the DB guard. To close that gap an authorised ambient database name (an approved-list change = a reviewed commit by the guard's owner) is required. Decision needed from the CTO/guard owner: approve a disposable ambient pattern (e.g. `daii_test_biz_tNN_ambient`) for the dedicated cluster, or accept the isolation suites as the HR/Attendance baseline.
- Relevant to Gate B-1: the existing isolation spec already exercises `linkUser` (positive, duplicate, cross-Company with one user in two Companies) — it is the regression net for B-1.
