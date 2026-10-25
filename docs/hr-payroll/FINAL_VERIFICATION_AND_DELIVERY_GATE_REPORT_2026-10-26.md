# HR · Attendance · Payroll · Commission — Final Verification & Delivery Gate Report (2026-10-26)

Branch `feature/hr-payroll-gap-closure`. **Production / merge / release: HOLD.** This report does **not** declare READY FOR DELIVERY.

## 1. Commits

| Role | Commit |
|---|---|
| Candidate for delivery (code) | `47d5894` |
| Code the final full regression ran on | `47d5894` (snapshot built from `git archive`, own `dist`) |
| Code the unit suite ran on | `47d5894` |
| Browser acceptance ran on | working copy of `f35412c` + the SoD class fix of `47d5894` (the SoD refusal was re-checked in the browser after the fix) |
| Docs-only commits after the code | `960946c` and the commit holding this report — no code change |

Lineage: `4ec632b` → `3f1c9d2` → `1d09d69` → `0f387a5` → `f35412c` → `960946c` → `47d5894`. Runs that are **not** evidence for `47d5894`: the 4eb2801 run (113/115), the aborted 3f1c9d2 run, the invalid run without `dist`, and the 111/115 run on `f35412c` (its two payroll failures were real regressions, fixed in `47d5894`). All are kept under `evidence-regression-2026-10-25/`.

## 2. Regression (Gate 2)

`47d5894`, 115 specs (`regression-specs-all.txt`), isolated cluster 5546 with the guard on:
- Part A: 44 passed, 0 failed (`RG4a-*.log`); the run was cut by a session restart.
- Part B: the remaining 71 specs: 70 passed, 1 failed (`RG4b-*.log`).
- **Total 114 passed / 1 failed.** The failure is `release-migration-registry.real-pg.spec` — **baseline**, needs the 5544 cluster, unrelated to this work.
- No new failure on this commit. The `company-datasource-factory-impact.characterization` teardown error seen once on `f35412c` ("permission denied to terminate process") did not recur and the spec passes alone and in this run: classified as an environment flake, not a regression.
- Ambient (non-isolated) functional specs: **NOT RUN, BLOCKED** (see §7).

## 3. Build and static checks

- Backend `tsc -p tsconfig.build.json` exit 0 and `tsc -p tsconfig.json --noEmit` (includes all specs) exit 0.
- Frontend `tsc -b` exit 0, `oxlint` exit 0 (existing warnings elsewhere, none in changed files).
- Unit suite on `47d5894`: 62 suites, 451 tests, all passed (`unit-47d5894-62suites-451tests.log`).

## 4. Browser results (Gate 3)

Disposable environment, built-in browser, users `bv.admin / rev / sub / appr / pay`. Full table: `evidence-browser-2026-10-25/BROWSER_ACCEPTANCE_2026-10-25.md`.

PASS: period creation; effective-dated compensation; calculate; exceptions (three) with documented acknowledgement; preparer refused; review; submit; submitter-as-approver refused; reject → recalculated → resubmit → approve; unmapped-account payout refused; payout batch and execution; reconciliation; supplementary run; period close (refused with an open supplementary, then accepted); localized refusals (AR and EN, with parameters); actor names; failed payout (partial batch, localized reason) and re-issue; SoD profile screen; HR link picker (Company members only); view-only role (reads allowed, writes denied, buttons hidden); English/LTR and Arabic/RTL on all payroll screens; phone width 375px (drawer opens from the right in RTL and the left in LTR; no horizontal scroll).

NOT VERIFIED in the browser: creating a commission adjustment (needs an approved commission result and sales events not present in the environment; service covered by `payroll-commission-consumption` spec).

Cosmetic residuals: the Phase-1 explanatory sentence on the run page still embeds the English words «posted / Financial Event / Treasury» inside the Arabic text (an existing seeded term, not overwritten by a `DO NOTHING` seed); payout failure reasons are stored as English text (the screen maps the known one).

## 5. Reconciliation (payroll ↔ ledger ↔ payout ↔ treasury)

After the browser journeys (independent SQL + the reconciliation endpoint): 5201 Dr 21,000.00 = 2150 Cr 21,000.00; 2150 Dr 21,000.00 = 1102 Cr 21,000.00; Treasury cash-out 21,000.00. Run 1 (20,000.00) and run 2 supplementary (1,000.00): net = expense = paid, outstanding 0, `consistent: true`. Run 3 (21,000.00, partial then re-issued payout): net = expense = paid 21,000.00, failed item 12,000.00 kept as history, outstanding 0. Specs `payroll-financial-e2e` (7/7) assert the same relations on real PostgreSQL with concurrency, closed fiscal period and discrepancy detection.

## 6. Company isolation, permissions, SoD

- Isolation: `payroll-gap-closure` 10/10, `payroll-commission-consumption` 6/6, `payroll-financial-e2e` 7/7, `hr.company-isolation` 8/8 (A/B leak checks, every new table), and the full isolation regression.
- Permissions: browser + API evidence in the browser record (row 26); denial is a non-disclosing 404.
- SoD: floor (approver ≠ preparer/submitter) and `standard`/`strict` enforced on every path including the generic approvals route; refusals audited; verified by specs and browser. `minimal` profile and waivers do not exist.

## 7. Open gaps and blocking decisions

Blocked or proposed — **none is fixed in code as policy**; see `DECISION_AND_RISK_REGISTER_2026-10-25.md` and `FINANCIAL_DECISIONS_MEMO_2026-10-25.md`: commission-adjustment approval (F-1, proposed); journal basis (F-2, proposed); entry date (F-3, proposed); return of paid money (F-4, blocked); SoD `minimal`/waiver (F-5, blocked); timezone, calendar, deductions (F-6, blocked); mid-period pay change / proration (F-7, blocked); `net_sales`/`customer_group` definitions (F-8, blocked); isolated ambient cluster approval on port 5544 (F-9, CTO).

Other: migration `1790100000000` (drops `UQ_payroll_runs_period`) not rehearsed on a populated Company database (K-8); the seed migration must run on the **platform** database; ADR-070/071/072 formal approval pending; a reviewer must confirm the opt-in `localizable` branch added to the global exception filter.

## 8. Re-verification evidence

Logs and lists in `docs/hr-payroll/evidence-regression-2026-10-25/`; browser record in `evidence-browser-2026-10-25/`; registers `GAP_STATUS_REGISTER_2026-10-25.md`, `DECISION_AND_RISK_REGISTER_2026-10-25.md`, `FINANCIAL_DECISIONS_MEMO_2026-10-25.md`. Recipe: `git archive 47d5894 backend` into a fresh directory, junction the shared `node_modules`, `tsc -p tsconfig.build.json`, then `REGRESSION_NS=biz_tNN_ node tools/testing/biz-run.js --regression tools/testing/regression-specs-all.txt` on cluster 5546.

## 9. Gate verdicts

| Gate | Verdict | Basis |
|---|---|---|
| 1 — Commit and evidence integrity | **PASS** | lineage documented; tested = candidate (`47d5894`); earlier runs not used as proof; logs kept |
| 2 — Regression closure | **PASS with one baseline BLOCKED spec** (114/115) — ambient specs **BLOCKED / NOT RUN** | the one failure is the known 5544 spec; ambient needs CTO approval of the 5544 cluster entry |
| 3 — UI and browser closure | **PASS**, one item **NOT VERIFIED** (commission adjustment creation in the browser) | §4 |
| 4 — Financial and policy closure | **BLOCKED** | decisions F-1…F-9 not approved; none assumed in code |
| 5 — Final acceptance | **NOT VERIFIED / not granted** | Gate 4 blocked, ambient suites not run, migration not rehearsed on populated data, ADR formal approval pending |

**Delivery status: NOT READY.** Merge, release and production deployment stay on HOLD until Gate 4 decisions are made, the ambient specs are run through an approved isolated cluster, the migration is rehearsed on a copy of populated data, and the final diff is reviewed.
