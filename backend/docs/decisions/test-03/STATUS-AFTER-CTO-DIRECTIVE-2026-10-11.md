# TEST-03 — status after the CTO directive "Findings, Decisions & Authorized Next Steps" (2026-10-11)

Current status (unchanged by this record): **TEST-03 ASSESSED — REMEDIATION AUTHORIZED — NOT SIGNED OFF.** This record maps every finding of `TECHNICAL-ASSET-VALUATION-READINESS-REPORT-2026-10-11.md` to its state after the work done under the directive, and states which commit each artifact belongs to. Two sessions worked in the same working tree (see §3).

## 1. Finding movement
| ID | Was | Now | Evidence | Commit |
|---|---|---|---|---|
| N-01 numbering / process-engine plain-manager race | Open, High | **CLOSED for the local scope (2026-10-11)** — code fixed (`23e5ec1`, plus `7097796` for `registerDocumentType`); clean-snapshot evidence of `a6002fa` reviewed in §7 of the N-01 report; superseded wording follows: closure was not declared at the time of writing — T-17: numbering 200/200, transitions capped at 2, customer create 120/120; 78 caller-manager sites protected by construction; regression from a clean snapshot and per-endpoint specs pending (other session) | `N-01-REMEDIATION-AND-CLOSURE-REPORT-2026-10-11.md`, `evidence/callsite-table.md`, `evidence-2026-10-10-biz/T-17/…` | `23e5ec1` |
| H-01 governing documents outside the repository | Open, High | **Closed (R1)** — 80 files copied verbatim into the repository with a SHA-256 manifest; `docs:check` finds 0 unresolved links from a clean checkout (15 documented external references: source systems outside the repo by design, the credentials file that must never be committed, a runtime folder, one historical handover). Originals untouched | `IMPORTED-GOVERNING-DOCUMENTS-2026-10-11.md`, `evidence/doc-links-after.json`, `doc-links-clean-snapshot.json` | `1829794` |
| C-01 no CI; lint failing | Open, Med–High | **Closed locally (R2)** — `tools/ci/ci.sh` + `.github/workflows/ci.yml`; lint 144 → 0 errors on a clean snapshot (see §2); all seven CI steps PASS from a `git archive` of the tree (install, build, lint, structure, doc links, unit 59/430, guard 50/50). **Not yet run on a hosted CI runner** (Linux) — UNVERIFIED there | `evidence/ci-run-clean-snapshot-2.log`, `evidence/eslint-r2-*.json` | `1829794`, `258965f` |
| B-03 `tsc` error in the staged copy | Open, Low | **Closed** — `tsconfig.json` excludes `_deploy`, `archive`, `storage`, `tmp`, `public.pre-v1.0.3`; `tsc --noEmit` exit 0, build OK | — | `258965f` |
| P-02 duplicate trees | Open, Medium | **Plan only** — inventory with references, risk and order; nothing removed | `REPOSITORY-HYGIENE-PLAN-2026-10-11.md` | `258965f` |
| D-03 Integrations tenancy mismatch | Open, Medium | **Evidence recorded, decision pending** — options A/B/C with acceptance criteria; no routing or migration change | `INTEGRATIONS-TENANCY-DECISION-RECORD-2026-10-11.md` | `258965f` |
| A-01 contract-bypassing imports; layering inversions | Open | Unchanged (boundary rule stays an error for production code; only the test harness folder is exempted) | `ARCHITECTURE-GRAPH-2026-10-11.md` | — |
| D-1 | Open | **Resolved** (scope adopted; historical definition left unedited) | `D-1-RESOLUTION-RECORD-2026-10-11.md` | `258965f` |
| D-9 F-INV-001 usage verification | Blocked | Queries and evidence guide ready; **still blocked** on a designated operator; the HTTP 410 change must not be deployed | `test-program/F-INV-001-OPERATOR-EXECUTION-GUIDE-2026-10-11.md` | `f14f162` |
| D-10 capacity | Pending | Brief, assumptions, measurement method, environment limits, staging profile and load generator prepared; **targets not approved**; hosting capacity UNVERIFIED | `test-program/CAPACITY-DECISION-BRIEF-FOR-CTO-2026-10-11.md`, `STAGING-CAPACITY-PROFILE-2026-10-11.md`, `tools/testing/capacity-loadgen.js` | `f14f162` |
| S-04 dependency vulnerabilities | UNVERIFIED | **Still UNVERIFIED** — `npm audit` needs network authorization that has not been confirmed in this session; no package was upgraded | — | — |
| L-01/L-02 licenses | Risk | Inventory unchanged; confirmation of the three undeclared licenses and the legal review list are with the verification session | `evidence/license-scan.json` | — |
| P-01/P-03 history, uncommitted work | Open | Open — 18 files of other tracks still modified/untracked in the working tree; not part of any assessed commit | `git status` | — |
| Q-01/Q-03/Q-04 test effectiveness | Open | Partly addressed (T-17 probes, spec for probes); per-endpoint concurrency specs pending | — | — |

## 2. Lint (R2) — what was done and what was not hidden
- Starting point at the previous head: 138 errors (64 architectural-boundary, 74 other), growing to 144 as new harness files were added.
- Boundary rule: **still an error everywhere except `src/foundation/testing/**`**, the folder whose purpose is to wire real services of several domains to a real database (documented override in `eslint.config.mjs`; `no-require-imports`, `no-explicit-any`, `no-unsafe-function-type` are relaxed there only). No production file and no domain spec was exempted.
- Production code: unused imports removed and unused parameters renamed with a leading underscore (signature, arity and callers unchanged; one commit, behaviour-neutral, typecheck/build/unit green). Unused locals removed. One regression found and fixed by the clean-snapshot gate: replacing the `REVIEWER_ROLES` constant by a comment broke the legacy-`admin` register spec (it counts that reference), so the constant was restored with a reasoned `eslint-disable`.
- Six spec files carry file-level or line-level `eslint-disable` comments **with a stated reason** (reflection helpers typed `Function`, `jest.spyOn` on private methods, a pre-existing regex, a destructure used only to omit a property). Two files owned by other tracks were fixed through an index-only change against HEAD so their working-tree edits were not touched.
- Findings that remain outside this commit: the uncommitted LA-1 spec (`company-lifecycle-admission.real-pg.spec.ts`) imports domain internals — it will fail the boundary rule when its owner commits it, which is the intended behaviour.

## 3. Commit reconciliation (this session's part)
`e9be53a` was HEAD when the TEST-03 analyses started, and the clean-build/unit result in the report belongs to `git archive e9be53a`. The TEST-03 documents, the T-17/T-18 probes and the 60-spec isolation run belong to the commit **`f14f162`**, but those probes and isolation specs executed in the **working tree**, which also contained uncommitted edits of other tracks (schedulers, `installation-audit.controller.ts`, `company-audit-access` spec, LA-1 files). Commit `74920fc` (a closure report by the parallel session) and `23e5ec1` (N-01 code, this session) follow. The other session is verifying `23e5ec1` from a clean `git archive` and owns the complete reconciliation; until it lands, treat results from the working tree as "tested on HEAD + uncommitted changes of other tracks", and treat only clean-snapshot results (clean build, unit, CI script, T-17 re-run from the snapshot) as results of an exact commit.
| Artifact | Belongs to |
|---|---|
| Clean build + unit (TEST-03 §7) | `git archive e9be53a` |
| T-17 before / T-18 / 60-spec isolation run | working tree on top of `e9be53a`+test-only edits (committed later as `f14f162`) |
| T-17 after N-01 | working tree on top of `f14f162`+`74920fc`; code committed as `23e5ec1` |
| CI script (7 steps) PASS | `git archive` of tree `2beace02…`, the index from which `258965f` was committed (the commit adds only two evidence files — the CI logs — to that tree; no source differs) |
| Lint 0 errors | same snapshot |

## 4. Still requires the CTO
Dependency-audit network authorization (and legal review of licenses); designation of the F-INV-001 operator (D-9); approval of capacity targets (D-10) and a staging host; the Integrations tenancy option (R4); approval to remove the duplicate trees (hygiene plan); authorization for N-02 (the other primitives using the same idiom: inventory reservation methods, moving-average engine, shipment transitions, limit service).
