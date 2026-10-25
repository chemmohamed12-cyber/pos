# Gap status register (2026-10-25) — five independent statuses

Supersedes the single «Status» column of `DELIVERY_MATRIX_AND_IMPLEMENTATION_PLAN.md` §3. A status never implies another: code that exists is not verified, verified is not approved, approved is not proof it works.

Definitions
- **PROPOSED** — the rule/design is written down (addendum, memo) and awaiting or carrying an owner decision.
- **IMPLEMENTED** — code exists in the branch (commit cited).
- **VERIFIED** — an executed test or browser journey passed on a commit; evidence cited. «real PG» = disposable two-Company PostgreSQL harness, never mocked.
- **APPROVED** — the owner/CTO approved the **rule** (not the code). «Mandate» = adopted by the CTO decision of 2026-10-25 as the working contract (C16 = S2, addenda A-1…A-11); the formal ADR-070/071/072 approval stays **PENDING**.
- **BLOCKED** — cannot proceed without a named decision or environment.

Evidence keys. **S1** `payroll-gap-closure.company-isolation.spec` (10/10) · **S2** `payroll-commission-consumption.company-isolation.spec` (6/6) · **S3** `payroll-financial-e2e.company-isolation.spec` (7/7) · **S4** `hr.company-isolation.spec` (8/8 incl. G-09) · **BR** `evidence-browser-2026-10-25/BROWSER_ACCEPTANCE_2026-10-25.md` journey number · **RG1** full regression on `4eb2801` (113/115, `evidence-regression-2026-10-25/full-regression-4eb2801.log`) · **RG2** full regression on `4ec632b` (see §3). Commits: backend core `1790100000000` migration + services in the branch history up to `4eb2801`; UI `da962a5`; browser fixes `4ec632b`.

## 1. Register

| ID | Gap | Decision / authority | Main files | PROPOSED | IMPLEMENTED | VERIFIED | APPROVED | BLOCKED |
|---|---|---|---|---|---|---|---|---|
| R-HR-1 | Employee↔User link only to an active member of the same Company | ADR-059 D2, B-1 | `hr.service.ts`, `hr.controller.ts` | yes | yes (B-1) | S4 7/7, RG1 | Mandate | no |
| R-HR-1/UI | Link-candidate picker (G-09): the screen used the platform-only `/admin/users`; now Company-scoped `GET /hr/link-candidates` (active members of this Company, not yet linked) | mandate §10 | `hr.service.listLinkCandidates`, `hr.controller`, `HrEmployees.tsx` | yes | yes (this commit) | S4 8/8 (new G-09 test), BR: picker lists the Company's active members | Mandate | no |
| R-PAY-01 | One active regular run per period, no `populationScope` | A-5 | migration `1790100000000`, `payroll.service.ts` | yes | yes | S1 (R-PAY-08 case), BR 4/14 | Mandate | no |
| R-PAY-02 | Effective-dated compensation + reason | ADR-067 §B | `payroll.service.ts`, `PayrollCompensation.tsx` | yes | yes | S1, BR 3 | Mandate | no |
| R-PAY-03 | Exact decimal money | PA-36 | `foundation/money/decimal-money.ts` | yes | yes | S1 (cent test), S3 totals | Mandate | no |
| R-PAY-04 | Exceptions (4 classes, fingerprint, acknowledge, B_APPROVE) | A-9/A-10 | `payroll-exception.service.ts`, `PayrollRunPanels.tsx` | yes | yes | S1 ×2, BR 4–6 | Mandate | no |
| R-PAY-05 | Stage actors + server-side SoD (standard / strict) | A-6 | `payroll-sod.service.ts` | yes | yes (`minimal`, waiver **not**) | S1 ×2, S3, BR 5/8 | Mandate; **policy + waiver pending (memo F-5)** | waiver: owner D-6 |
| R-PAY-06 | Rejection → recalculated → resubmit | A-9 | `payroll.service.ts` | yes | yes | S1, BR 9–10 | Mandate | no |
| R-PAY-07 | Period overlap trigger, close, post-close path | A-9 | migration, `payroll.service.ts`, `PayrollPeriods.tsx` | yes | yes | S1 ×2, BR 15/17 | Mandate | no |
| R-PAY-08 | Supersede / supplementary delta | A-4 | `payroll.service.ts`, `PayrollRunDetail.tsx` | yes | yes | S1, BR 14/16 | Mandate; **proration of mid-month change pending (see below)** | no |
| R-PAY-09 | Adjustments consumed once | A-3 | `payroll-input-consumption.entity.ts` | yes | yes | S2 | Mandate; **independent approval pending (memo F-1)** | no |
| R-COM-01 | Attribution date = source business date | A-1 | `commission.service.ts` | yes | yes | S2 | Mandate | no |
| R-COM-02 | Once-only consumption, DB-enforced, concurrency-safe | A-2 | `payroll_input_consumptions` | yes | yes | S2 (concurrent case) | Mandate | no |
| R-COM-03 | Late approval → first open run, flagged | A-1 | `listConsumableForPayroll` | yes | yes | S2 | Mandate | no |
| R-COM-04 | Adjustment/reversal consumed once | A-3 | `commission.service.ts` | yes | yes | S2 | Mandate | no |
| R-COM-05 | `net_sales` / `customer_group` disabled | A-11 | `createPolicy`, `CommissionPolicies.tsx` | yes | yes | S2, BR 19, RG1 (fixture fix) | Mandate | definitions: owner |
| R-ACC-01 | Dr 5201 / Cr 2150, commission recognised once | A-8 | `payroll-run-posted.handler.ts` | yes | yes | S3, BR 10 + DB ledger check | Mandate; **basis pending (memo F-2)** | deductions: F-6 |
| R-ACC-02/03 | Payout batches/items, partial/failed/re-issue | A-7 | `payroll-payout.service.ts`, `payroll-payout-settled.handler.ts` | yes | yes | S3, BR 11–12 | Mandate | no |
| R-ACC-03/ret | Return of paid money | memo F-4 | — | yes | **no** | no | no | **BLOCKED** (Treasury reversal decision) |
| R-ACC-04 | Reconciliation lines = journal = payouts = treasury | A-7 | `/runs/:id/reconciliation`, `RunReconciliationPanel` | yes | yes | S3, BR 13 + DB check | Mandate | no |
| R-ACC-05 | Idempotent payout under concurrency | A-7 | payout idempotency key | yes | yes | S3 | Mandate | no |
| R-ACC-06 | Closed fiscal period: rejected-and-visible, redrive once | ADR-070 §14 | existing `redrive` | yes | yes | S3 | Mandate | no |
| R-ACC-date | Entry date at approval vs period end | memo F-3 | handler `businessDate` | yes | today's behaviour | BR DB check (dated approval day) | **no** | owner decision |
| R-ATT-01 | No approved attendance ⇒ exception, not silent pay | A-10 | `calculate` | yes | yes | S1, BR 4 | Mandate | no |
| R-ATT-02 | Business date / timezone | DEC-06 | — | yes | UTC-day helper only | partly (UTC helper) | **no** | **BLOCKED** owner decision |
| R-ATT-03 | Holiday calendar / absence deductions | H0-2 | — | yes | **no** (fail-safe refusal) | no | no | **BLOCKED** |
| R-DED | Deductions of any kind | memo F-6 | handler refuses | yes | refusal only | **no test of the refusal** | no | **BLOCKED** |
| R-SEC-01 | Company isolation of every new table/route | mandate §11 | specs | yes | yes | S1, S3, S4 (A/B leak checks), RG1 | Mandate | no |
| R-SEC-02 | Manifest nodes = routes; unused removed | A-10 | `payroll.manifest.ts`, `payroll.module.ts` | yes | yes | **no static test** | Mandate | no |
| R-UI | Screens in AR/EN, RTL/LTR, responsive | mandate §10 | `pages/payroll/*`, `CommissionPolicies.tsx`, terminology seed | yes | yes (commits `da962a5`, `4ec632b`) | BR 1–19 desktop AR + EN; tsc -b + oxlint clean | Mandate | mobile: shell limitation (global) |
| R-PAY-05/UI | SoD profile settings screen (`/payroll/settings`) | A-6 | `PayrollSettings.tsx`, cover shortcut | yes | yes (this commit) | BR: standard→strict→standard persisted, localized | Mandate | no |
| R-UI/err | Localized refusals (stable code + parameters, 48 ar/en labels), actor names, payout failure label | A-10 / mandate §10 | `payroll-refusal.ts`, `all-exceptions.filter.ts` (opt-in), `ErrorText.tsx` | yes | yes (`0f387a5`, `f35412c`) | BR 23–25 | Mandate | no |
| R-UI/mobile | Responsive shell (off-canvas sidebar) | mandate §10 | `Layout.tsx/css` | yes | yes (`f35412c`) | BR 20 (375px, AR + EN) | Mandate | no |
| R-SEC-03 | Permission denial and view-only role | A-10 | `PermissionGuard` | yes | yes | BR 26 | Mandate | no |
| R-UI/gap | Commission adjustment creation in the browser | — | — | yes | partly | **NOT VERIFIED in browser** (no commission results in the environment; S2 covers the service) | — | no |
| R-FIN | Numerical acceptance (mandate §8) | mandate §8 | S1–S3 | yes | yes | S1–S3 + DB ledger/treasury check after browser run | Mandate | no |

Proration (R-PAY-08): the supplementary run in the browser paid the **whole-period** difference (+1,000.00) for a rise effective on 15 October. Proration by days is a payroll rule that no ADR defines; it is left as an owner decision and the current behaviour is documented, not assumed correct.

## 2. ADR addenda

| Addendum | Content | PROPOSED | IMPLEMENTED | VERIFIED | APPROVED |
|---|---|---|---|---|---|
| ADR-070 A-1…A-5 | attribution, consumption, adjustments, revisions, population | yes | yes | S1/S2, RG1 | Mandate (working contract); formal ADR approval **pending** |
| ADR-071 A-6…A-9 | SoD, payout/exception tables, rejection and period | yes | yes (SoD `minimal`/waiver excluded) | S1/S3, BR | Mandate; formal approval **pending** |
| ADR-072 A-10, A-11 | attendance exception, disabled commission kinds | yes | yes | S1/S2, BR | Mandate; formal approval **pending** |

## 3. Regression status

- **RG1** `4eb2801`: 113 PASS / 2 FAIL of 115 — `commission.company-isolation.spec` (caused by this branch's `net_sales` guard, fixture moved, re-run 5/5 PASS) and `release-migration-registry.real-pg.spec` (known baseline, needs port 5544, BLOCKED, unrelated).
- **RG2** `4ec632b`: started 2026-10-25 22:34, namespace `biz_t44_`, result recorded in the final report; until it ends the final commit is **NOT VERIFIED by a full regression**.
- Ambient (non-isolation) functional specs: edited but **NOT RUN** — the ambient database is blocked by the DB guard (T-1 record).
