# Central integration — final report (2026-10-26 / 27)

**Status: READY FOR RELEASE DECISION — candidate package built and verified; NOT released, NOT deployed, NOT merged into `release/1.1.12`.** Financial activation stays blocked (section 8).

## 1. Candidate identity
| | |
|---|---|
| Integration branch | `integration/central-2026-10-26` (built on the other session's `integration/final-mfg-hr-org-vw-2026-10-26` 2c58ada; worktrees `central`, `central-th`) |
| Source commit of the package | **`6936c44516674a70668d4728dfafd4321c2d694e`** (the evidence/report commit on top of it changes documentation only) |
| Version | **1.1.15** (history 1.1.10 → 1.1.11 → 1.1.12 → 1.1.13 → 1.1.14 = Vehicle Workspace baseline; no branch holds a higher number; bump commit 0366732) |
| Package | `Daii-Release-v1.1.15-2026-10-27.zip`, SHA-256 **`5e20da2dc23889b77c2b73bf72db20fbcad1e481050c9a63f04846732c392c8f`**, built from `git archive 6936c44`, `VERIFY: PASSED`, secret scan clean |
| Migrations | 351 in the package (320 on the 1.1.13 baseline → +31) |
| Preserved baseline | `release/1.1.12` 1a0d187 / d05520f (Vehicle Workspace 1.1.14) is untouched; this candidate contains it |

## 2. Included workstreams (source → integration)
See `CENTRAL-INTEGRATION-REGISTER-2026-10-26.md` for the full table. In order: release line 1.1.13 + Vehicle Workspace/org/direct-sale merge (a13f9ee) · final-int content: org WP-A/WP-C, manufacturing engine + UX, HR/payroll gap closure + HR B-1, ownership-aware terminology seeds · org documentation (7ff7005) · customer-statement series (D2 repair, statement engine + PDF/CSV/XLSX, official screen, indicators, tests; T2 reversal was already on the line) · order stage visibility b661124 · Treasury ledger/menu hotfix (428f8c7, 6fa4dbd, 2c8ed33) · Vehicle Workspace fixes of this integration.

## 3. Conflicts and merge defects found and resolved
| Item | Cause | Resolution |
|---|---|---|
| `payments.service.ts`, `customer-finance.module.ts`, `unit-specs.txt`, `Shipments.tsx`, `SalesOrdersList.tsx` | adjacent additions of two workstreams | both sides kept |
| `PurchaseOrders.tsx` (PO picker b5a5463) | the line already holds a later implementation (`excludedIds`) | newer kept; commit skipped |
| Treasury hotfix: controller imports, navigation registry, `App.tsx`, `TreasuryCover.tsx`, `TreasuryLedger.tsx` | two Treasury navigations and the T2 idempotency changes in the same page | navigation keeps Workspace / Documents / Bank statements / Cash sessions and replaces only the old "accounts" entry by Settings + Balances (old route redirects); ledger page = hotfix page with the T2 idempotency key and required-field changes re-applied; controller-constructor specs updated; unit list gets the ledger label spec |
| **`Layout.css`: closing brace of `.nav-subsection` missing** | silent loss in the automatic merge of the release line into final-int; it nested every later rule and broke the production CSS minification (the reported nested `@page` error) | brace restored (142b4df); all CSS files checked for balance |
| Eight ESLint errors | unused imports/locals from the manufacturing and payroll sessions (`ProcessEdge`, `byOp`, `byId`, `run`, `primary`, `ConflictException`/`NotFoundException` ×3) — genuine, pre-existing in the included branches | removed, no rule suppressed; 0 errors now |
| **Vehicle Workspace: `POST vehicles/:id/expense-float` had no branch-scope check** (the only vehicle-id route without it) | gap in my earlier integration audit | `assertVehicleInScope` added; new read-only `GET vehicles/:id/expense-float-candidates` (same rules as the assignment); specs: out-of-scope vehicle → 404 for both routes (negative), in-scope answered (positive), candidate list = what the assignment accepts |
| Float picker listed custody accounts; category dropdown showed raw keys | UI | picker uses the candidates endpoint; readable category names (key stays the stored value). The third reported item (reason field not cleared) did **not** reproduce — it was an artefact of duplicate typing during the first test; verified cleared in the final package |
| Regression: 4 specs failed with `user_roles does not exist` | `dist` was missing | environmental; built; the later clean run passed them |
| Regression: H3 registry spec could not load migrations | the spec's cut-off tree omitted `dist/database/seed-helpers`, which the new ownership-aware seed migrations import | spec copies the folder (the real package contains it) |
| Regression: payment-reversal R11 | date-dependent (payments recorded "now", fixed as-of date; failed from 2026-10-27) | explicit collection period passed |
| Regression: Treasury Documents HTTP spec | controller gained ledger-report / company dependencies | inert stand-ins provided |
| `company-audit-access.real-pg.spec.ts` | refused by the DB guard (unapproved disposable DB name); never part of the regression lists | removed from the central list |

## 4. Verification (all on the final source; product code of the package is identical to the code of the browser/regression runs — the only later differences are three spec files, two test lists and documentation)
| Check | Result |
|---|---|
| Backend `tsc --noEmit`, build | 0 errors |
| ESLint | exit 0, **0 errors**, 5 warnings (pre-existing) |
| Unit tests | **83 suites / 684 tests** pass |
| Frontend `tsc -b`, production build, model tests | pass (build fixed, see Layout.css); 14/14 |
| Central PostgreSQL regression (clean run, ns `biz_t90_`, 171 specs, source 0366732) | 168 pass; 2 failed: Treasury Documents HTTP (fixed, re-run PASS) and `company-audit-access` (guard refusal, removed). First informational run (pre-hotfix source, ns `biz_t91_`) kept in full; its 4 missing-`dist` failures were **not** counted as resolved by building — they are covered by the clean run |
| Re-run after fixes on `7b32e2e` (ns `biz_t87_`): treasury-documents.http 10/10, payment-reversal 10/10, H3 registry 21/21, vehicle-branch 10/10 (incl. expense-float scope), custody-expenses 14/14 (incl. candidate list) | **PASS** |
| Release Engine on the unmodified 1.1.13 engine, final package | deploy succeeded, 320→351, company gate/fan-out; upgrade schema == fresh install (`1e7c6928…` / `b7828f7e…`); up / no-op / down / up proved; smoke 36/36; Stage C acceptance 42 PASS 0 FAIL; previous 1.1.13 slot runs on the upgraded schema (health 200, Stage C route 404) |
| Browser acceptance on the deployed packaged build (package from 0366732) | float picker lists only eligible accounts (FLT-VH101, MAIN-CASH; no custody accounts, no bank); categories read وقود / رسوم طريق; reason cleared after submit; Treasury menu shows Workspace/Documents/Bank statements/Cash sessions/Settings/Balances/Ledger; Ledger page loads 17 rows, report + export 200; customer statement 200 and PDF/XLSX/CSV in ar and en (pdfkit/bidi-js present); orders list shows incomplete/completed tiles; Vehicle Workspace scenarios 1–10 earlier on 282ed63 |
| Source ↔ package | package built from `git archive 6936c44`; `package-source-commit.txt`; `git diff 0366732 6936c44` = specs, lists, docs only |

## 5. Migration evidence and accepted exceptions
Rollback of all 31 new migrations (down) leaves the baseline schema except: **E1** `org_units` parent FK stays `RESTRICT` (was `CASCADE`; deliberate protection, migration `core/1790021000000-OrgUnitLifecycle`, accepted by the CTO); **E2** an **empty** helper table `terminology_seed_ownership` (0 rows after down) created on first use by the ownership-aware terminology seeds — additive residue, no data. Data recovery relies on application rollback with the schema kept or the engine's per-Company restore point, never on destructive down.

## 6. Deployment prerequisite found (not a code defect)
The 1.1.15 package declares two **new runtime dependencies** (`pdfkit@0.15.2`, `bidi-js@1.0.3`, used by the customer statement PDF). The Release Engine correctly **refused** the first rehearsal (`CANDIDATE verification failed: dependencies_resolve (missing from node_modules: bidi-js, pdfkit)`; log kept in `rehearsal-dependency-refusal/`) — the same class as the 2026-09-15 incident. **Before deploying 1.1.15 on any host, install those two packages into the host's shared `node_modules`** (exact versions from `package-lock.json`). With them present the deployment succeeded.

## 7. Known exclusions / open
- Direct-sale **shipping fee** (uncommitted work of another session): preserved (`snapshot/direct-sale-shipping-wip-2026-10-26`, `refs/snapshots/*`, patch in `D:\DAII-INTEGRATION-SNAPSHOT-2026-10-26`), **not** integrated; its migration number 1790031000000 **collides** with the procurement migration of the same number and must be renumbered by its owner.
- `main` (POS upload 505584d) and the review/handover branches: not integrated (separate history, other session's ownership).
- Untracked work in inventory-lifecycle, f11-verify, master-data-item worktrees: left in place.
- The first regression process (informational run) could not be stopped by me (kill denied by the host's safety check); it finished on its own — nothing overlapped the clean run's database namespace.

## 8. Financial activation
Still **BLOCKED**: no company-specific float account, expense-category → account mapping or role assignment has been verified; the code fails closed.

## 9. Merge / release status
Not merged into `release/1.1.12`, no tag, no release artifact published, no deployment. The package exists only in the local build folder `D:\DAII-LOCAL-DEPLOY-R1111K\out`. Verdict: **candidate verified; awaiting the release decision.**
