# WP-0.4 — Working-tree Ownership & Stable Source — Evidence

**Verdict: NOT MET.** (CTO ruling: "CONDITIONAL — NOT YET VERIFIED"; WP-4.1 may not start on this basis.)
What *is* established: a source-hash-bound, non-concurrent test window for the WP-0.5 runs. What is **not**: a standing stable tree, and resolved ownership of every change group. Date: 2026-10-05.

## 1. Definition applied (CTO) and result

| Requirement | Result | Evidence |
|---|---|---|
| Record Git HEAD | **MET** | `4bb71f8391321b883b40145b2b5fb6c233048fa2` (unchanged T0 → T1) |
| Manifest of modified + untracked files with SHA-256 | **MET** for `backend/src` + `backend/docs` | `evidence/T0-manifest-20261005-0530.sha256` (356 files), `evidence/T1-manifest-20261005-0551.sha256` (366 files). **Gap closed:** `dist/database/migrations` is part of the anchor below — the T0 manifest omitted it |
| Identify the owner of each unresolved change group | **PARTIAL** | §3 — attributed by transcript evidence for named files only; everything else UNATTRIBUTED |
| Confirm no concurrent writes during the test | **MET for the WP-0.5 window** | `src/` + `dist/database/migrations/` (1,759 files): no file mtime after 05:41:30, last `src` write 05:40:28; test window 05:46:36–05:50:20; live anchor at 05:54 equals the pinned anchor |
| Bind test results to the actual source hash | **MET** | anchor `ba5a16beb64a497d33415974df11d9d2aa8c0181bb6ce080b68f4c83113044f1`; each spec also recorded migration digests at start and end (unchanged) |
| A standing stable tree | **NOT MET** | §2 |

## 2. Why the tree is not stable (observed, not inferred)

Between T0 (05:30:31) and T1 (05:51:14) these files changed in the shared tree (`evidence/T0-to-T1-changed-files.txt`):
`foundation/approval-engine/approval-engine.service.ts`, `approval-engine.module.ts`, `approval.controller.ts`, new `approval-engine.company-isolation.spec.ts`, `domains/inventory-warehouse/application/inventory.service.ts`, `domains/accounting/application/financial-events/inventory-costing-handler.service.ts`, `foundation/module-registry/manifests/logistics.manifest.ts`.
Earlier today (all verified by mtime) other workstreams changed shared guards, the exception filter, closed Area 21 services and `financial-event.service.ts`. A `dist/` rebuild at 05:37–05:38 (by a process not identified) invalidated one of my own runs.
The quiet interval 05:41→now is real but short and is **not** a stable-source declaration.

## 3. Ownership of change groups (attribution = a verbatim Write result in a session transcript; nothing inferred from file presence)

| Group | Files (examples) | Attributed to | Basis | Ratified? |
|---|---|---|---|---|
| Plans / packages / per-Company entitlement resolver | `foundation/plans/*`, `core/1789890000000-CreatePlansAndCompanyAssignments`, `module-registry/{entitlement-resolver.token,require-module.decorator,require-feature.decorator}.ts`, `entitlement.controller`, `navigation.*`, `app.module.ts`, front-end control-plane pages | **"DAII HR (fork)"** (`local_43695077-…`) for `company-package.service.ts`; the rest of the group by co-location and timestamps (**inferred**) | transcript Write result + diff | **No** — migration header cites a CTO instruction this workstream has not seen |
| Approval Engine retrofit | `approval-engine.service.ts`, `approval-engine.module.ts`, `approval.controller.ts`, `approval-engine.company-isolation.spec.ts` | **"DAII HR (fork)"** (spec Write result at 02:45Z) | transcript + diff (+199/−85 lines) | **No** — Area 21 Approval Engine decision has not been issued |
| Isolated test environment | `docs/acceptance/ISOLATED_TEST_ENVIRONMENT.md`, tools, exception filter edits | **"DAII HR (fork)"** | transcript | not applicable (tooling) |
| Event Engine D10 + D3/D4 policies + manual receipt + edits to closed Area 21 services | `foundation/events/*`, `inventory-posting-policy*`, `returns/*`, `financial-event.service.ts` (05:10), `manual-receipt…spec` | **"Multi-Company front"** (`local_0f4192f6-…`) | transcript Write results (dispatcher, event spec, policy registry, manual-receipt spec) | **No** (CTO: external/unauthorized until established) |
| Area 21 retrofit (27 controllers) | the retrofit files, matrix, ratification package | this workstream (`Multi-Company back21`) | own history | GL pending ratification |
| SaaS control-plane documents and characterization tooling | `docs/decisions/saas-control-plane/*`, the characterization specs and helpers | this workstream | own history | docs only |
| **Everything else** among 366 changed files | — | **UNATTRIBUTED** | — | **NEEDS RE-PROOF** |

## 4. What would make WP-0.4 MET (proposed, for the CTO)

1. A CTO-declared **freeze window** or per-file ownership ruling covering the shared-engine files (guards, Approval Engine, Event Engine, entitlement) — or a ruling that the other workstreams' changes are ratified (so they become part of the baseline instead of foreign changes).
2. Owners (or the CTO) to confirm the **UNATTRIBUTED** remainder.
3. A manifest that includes `dist/database/migrations` (done here) taken immediately before and after WP-4.1's tests.
4. Until then, WP-4.1 and any shared-engine package use **pinned-snapshot execution** (as for WP-0.5): hash-anchored, immune to concurrent edits — valid only for that anchored state.

## 5. Status line
**WP-0.4: NOT MET — evidence recorded.** WP-4.1: **not startable** on this basis.
