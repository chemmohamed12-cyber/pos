# Treasury program — T6 gate (full regression & qualification) and T7 (release candidate) — 2026-10-21

Branch `feature/treasury-integrity`, head = the commit that adds this file (see `git log`); base `integration/local-2026-10-16` @ `00cd8ee`. **Nothing was merged to `main`, no version number was changed, no package was built or published, nothing was deployed, `daii_dev` / Alpha / Beta / Gamma / Delta / :5173 / :3500 were not touched.**

## T6 — Full regression and qualification

### Results (actual runs, classified)
| Suite | Command / scope | Result | Class |
|---|---|---|---|
| Real-PostgreSQL regression (all 122 specs of `regression-specs-all.txt` + the 4 Treasury specs not in it = **126 specs**), run in 5 chunks on the dedicated cluster 5546, namespaces `biz_t74_`…`biz_t78_` | `node tools/testing/biz-run.js --regression <chunk>` | **125/126 specs PASS — 881 tests passed** (chunks: 25/25 166 · 25/25 159 · 25/25 181 · 25/25 161 · 25/26 214) | **PASS** |
| `release-migration-registry.real-pg.spec.ts` | same | 21 tests, all refuse to start: "only run against the isolated PostgreSQL instance 127.0.0.1:5544 … Never the shared dev server" — **the 5544 instance is not running in this environment** | **BLOCKED** (environment; not a product failure; not re-classifiable without that instance) |
| Database-free unit mode | `npm run test:unit` | **66 suites / 508 tests PASS**, exit 0 | **PASS** |
| Static analysis | `npm run lint` (backend, whole project) | **exit 0, 0 errors**; 5 warnings, **all in pre-existing files** (`company-connection-manager.service.spec`, `biz-harness-smoke`, `biz-support`, `t09`, `t10`) | **PASS** |
| Type-check / build | `tsc --noEmit`, `nest build` (backend); `tsc -b && vite build` (frontend) | clean; frontend built in 2.0 s | **PASS** |
| Full-stack browser E2E on an isolated environment (own Control Plane + Company DB on 5546, real backend :3679 + frontend :5679) | manual browser run, see `TREASURY-T4-FULLSTACK-E2E-REPORT-2026-10-21.md` | collection → approval (different user) → execution → GL/AR/Treasury consistent → statement import/match/reconcile → cash session variance → EN mode all **PASS**; restricted-role, error-state and breakpoint checks on the full stack **PARTIAL** (covered by HTTP specs and the harness) | **PASS (partial coverage recorded)** |
| Combined cross-domain run after Procurement's branch was merged into integration (eabd3fd) and into this branch (bef1c0e): 74 specs (treasury, finance, AR/AP, procurement, accounting, approval, isolation) in 3 chunks, namespaces `biz_t79_`/`biz_t81_`/`biz_t82_` | `biz-run.js --regression` | **74/74 specs PASS — 537 tests** (28/28 188 · 28/28 199 · 18/18 150); logs `70`–`72-combined-chunk*.log` | **PASS** |

Evidence: `evidence-treasury-integrity-2026-10-20/` (`60-T6-regression-chunk1..5.log`, `61-T6-lint.log`, `62-T6-unit.log`, `63-T6-frontend-build.log`, earlier gate logs). One tracked evidence file (`evidence-2026-10-17-inventory-c1-closure/controlled-scenario-results.json`) is rewritten by an existing spec on every run; it was restored with `git checkout` so the branch carries no accidental change.

### What the qualification proves for the Treasury domain (by the specs above)
- **Treasury ↔ GL ↔ AR consistency after execute / reverse / concurrency / closed periods**: integrity, recovery, payment-reversal, documents and bank-reconciliation specs assert, after every scenario, Treasury balance == GL balance, AR subledger == GL AR, every posted journal Dr == Cr, no non-POSTED event; the existing t10 reconciliation and AR/AP reconciliation suites in the regression still pass. **AP ↔ GL** is covered only by the existing supplier-payment / supplier-invoice suites (unchanged by this program, which could not touch Procurement's files).
- **Company isolation**: every new spec runs A/B and asserts B untouched; new HTTP spec asserts a document of Company A is invisible under Company B.
- **Authorization**: each new route has its own node (unit spec), enforced server-side over HTTP with real grants (documents, bank statements, cash sessions, payment reversal), self-approval refused through the API.
- **Concurrency / exactly-once**: concurrent identical requests under one key, concurrent reversals, concurrent executes, concurrent closes, concurrent confirms of one movement — each yields one effect.
- **Atomic failure**: closed period, unmapped account, absent reason, control account as counter, unset clearing — refused before commit with a zero-side-effects fingerprint; injected failure after the leg rolls everything back.
- **Historical records**: all migrations are additive and empty; T0 read-only checks on the real-data snapshot found no unexplained drift (documented, not repaired).

**Gate T6: PASSED for the Treasury domain on the evidence above, with two explicitly recorded non-passes — one BLOCKED (5544 instance), two PENDING (full-stack E2E; combined run with Procurement) — none waived.**

## T7 — Release candidate

### RC contents (7 commits on the branch)
`90a5b30` T0 audit/evidence · `c60a115` T1 integrity (publish-time posting guard, mapping rule, deposit atomicity, exceptions view) · `548255a` T2 customer payment reversal, owned-leg protection, split permissions, generic-cash restrictions · `cdcaad4` T3 Treasury Documents + T4 UI · `24f6b61` T4 verification (HTTP spec, UI harness) · `361d125` T5 bank statements & cash sessions · `e6ac555`/this commit reports and evidence. Diff vs the integration line: ~71 source files (≈6.7 k lines added), **4 new migrations**, no deletion of existing behaviour except the intentional refusals listed below.

### Migration inventory and order (all additive, all idempotent in intent, all reversible by `down`)
| Order | File (backend/src/database/…) | Effect | `down` | Risk |
|---|---|---|---|---|
| 1 | `finance/1790030000000-CreateCustomerPaymentReversals` | new empty table `customer_payment_reversals`, UNIQUE(paymentId), FK to `customer_payments` | drops the table | none to existing data |
| 2 | `finance/1790030100000-CreateTreasuryDocuments` | new empty `treasury_documents`, `treasury_document_allocations` | drops both | none |
| 3 | `core/1790030200000-SeedTreasuryDocumentTerminology` | upserts 8 terminology rows (policy labels, 4 nav labels) | deletes those 8 codes | none (idempotent upsert) |
| 4 | `finance/1790030300000-CreateBankStatementsAndCashSessions` | 4 new empty tables with partial unique indexes | drops them | none |
Timestamps are above every migration on `main`, on the integration line and on Procurement's branch (`17900200…`–`17900205…`), so the order with their migrations is deterministic whichever merges first; neither set depends on the other. The H3 registry spec (BLOCKED) must be re-run when the 5544 instance exists because the migration count per tag changed.
**Upgrade sequence for a company database**: normal release migration run (finance tag, then core terminology) — no backfill, no data change, no downtime requirement beyond the migration itself. **Rollback**: run the four `down` migrations in reverse order **only while the new tables are empty or their content is disposable**; once documents / statements / reversals exist they are accounting evidence and the rollback becomes a *forward-fix* decision (the ledger, journals and balances are never altered by this program, so the old application version keeps working on a database that has the extra tables).

### Behaviour changes (intentional — each is a refusal that previously silently committed a defect)
1. A treasury / payment / deposit / COD movement whose accounting could not be posted (closed period, unmapped or chart-less account, unset clearing account, control account as counter) is **refused before commit** (409, "Nothing was recorded") instead of committed and rejected later.
2. Direct cash-in/out/transfer **require a GL-mapped account**; the generic cash-in/out endpoints refuse a customer / sales-order label (422) and require a reason and a reference.
3. A Treasury-ledger reversal of a leg **owned by a payment, deposit, COD collection, payroll run or Treasury document is refused** — use the owning document.
4. `deposit.verified` is published in the approval's own transaction; an unmapped deposit account refuses the approval.
New capabilities: customer payment reversal; Treasury Documents (collection over several invoices, transfers / deposits / withdrawals, profile-based receipts and disbursements, approval, execution, reversal); bank statements and reconciliation; cash sessions; posting-exceptions view; Treasury workspace UI; per-action permission nodes (all inherit from `finance` — **no existing role gains or loses access**).
**Configuration the owner must provide before the new documents are usable**: the two reason→account profiles (`accounting.treasury_receipt_reason_accounts`, `…disbursement_reason_accounts`, managed in the existing Accounting Policy screen), `CASH_OVER` / `CASH_SHORT` / `BANK_FEE`-type reasons as needed, and — optionally — `finance.treasury_document_auto_approve_limit` (empty = every document needs a separate approver).

### Known limitations and open owner decisions (not hidden)
- **Supplier-payment reversal: built and proven, NOT wired (update 2026-10-21, commit aa09d90)** — Procurement's branch is now merged; the service/controller/handler/migration (`1790030400000`) and a 7/7 real-PG spec exist (see `TREASURY-T2S-SUPPLIER-PAYMENT-REVERSAL-REPORT-2026-10-21.md`), but activation needs two additive edits in Procurement-owned files (three `reopen_*` process transitions; module registration) that were not made without that team's agreement. Until then a supplier payment cannot be reversed in the product. Multi-invoice supplier allocation reuse by Treasury documents is still not delivered.
- Payroll disbursement's cash leg still posts no bank GL (known, by design, owner policy open — reported in the exceptions view as deferred-by-policy).
- Documents execute only on their own business date (back/forward dating needs an owner policy).
- Approval thresholds, auto-approve limit, reconciliation maker-checker, acceptable-difference policy, matching windows (±5 days / score cut-offs are engineering defaults that only rank suggestions), cheque / wallet / external-rail lifecycles, bank file formats (CSV/MT940/CAMT), multi-currency — **owner policies or later items**; none is simulated.
- Payment execution against external bank rails does not exist and is not represented as available.
- **Preview**: the Treasury work is **not yet visible on :5173** (it needs the four migrations applied to the preview databases — explicitly not authorized). The UI was verified in a browser only through the dev harness (real pages, mock API) plus HTTP-level real-PostgreSQL specs.

### RC decision
**Technically ready for the combined review** *for the delivered scope*, on these conditions: (1) an authorized, isolated environment to complete the full-stack E2E (browser against a real backend) and the H3 registry run; (2) the Procurement branch review/merge, then the supplier-side reversal and a combined cross-domain regression; (3) owner decisions listed above. **Release (merge to `main`, version, package, hosting) was not performed and requires explicit final approval.** Recommended next step for the owner: authorize either (a) creation of 5 throw-away clone databases on 5433 for an isolated full-stack check, or (b) applying the four migrations to the preview databases with the `down` scripts as rollback.

## Final consolidated tracker
| Phase | Gate | Evidence |
|---|---|---|
| T0 baseline & read-only data checks | PASSED | `…T0-REPORT…` |
| T1 integrity & atomic posting | PASSED (23/23, 178) | `…T1-GATE-REPORT…` |
| T2 reversals & authorization | PASSED customer side; supplier side **BLOCKED** by Procurement merge | `…T2-GATE-REPORT…` |
| T3 documents & workflows | PASSED (27/29 → 2 classified) | `…T3-T4-GATE-REPORT…` |
| T4 workspace UI | PASSED with recorded limitation (full-stack E2E PENDING) | `…T4-GATE-REPORT…` |
| T5 bank reconciliation & cash sessions | PASSED (30/30, 237) | `…T5-GATE-REPORT…` |
| T6 full regression | PASSED for Treasury; 1 BLOCKED, 2 PENDING | this report |
| T7 release candidate | **Documented; RC not published**; preview on :5173 **not done** (authorization) | this report |
