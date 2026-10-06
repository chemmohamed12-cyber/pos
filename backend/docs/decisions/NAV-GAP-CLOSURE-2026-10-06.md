# Navigation & Operational Workflow Gap Closure — running record (2026-10-06)

Baseline: `FRONTEND-NAVIGATION-AND-OPERATIONAL-FLOW-AUDIT-2026-10-06.md` (NAV-01 … NAV-14). Rule per gap: VERIFY → IMPLEMENT → TEST → CONFIRM → DOCUMENT → NEXT. Closure vocabulary: IMPLEMENTED → INTEGRATED → VERIFIED → UAT READY (never "DONE"). **Production = HOLD. Nothing pushed.**

| Gap | Status |
|---|---|
| NAV-02 Accounting policy configuration | IMPLEMENTED / INTEGRATED / VERIFIED — UAT READY (open escalations ESC-1, ESC-2) |
| NAV-03 Approval visibility | IMPLEMENTED / INTEGRATED — **browser verification pending (needs the bv test login)** |
| NAV-04 Approval governance (PR maker/checker, payments, treasury) | ESCALATED (ESC-3) — no ratified policy; not decided here |
| NAV-01 / NAV-09 Setup & process guidance | IMPLEMENTED / INTEGRATED — browser verification pending |
| NAV-05 Entry points to buried transactions | IMPLEMENTED / INTEGRATED — browser verification pending |
| NAV-07 Accounting traceability on documents | IMPLEMENTED / INTEGRATED — browser verification pending |
| NAV-06 Canonical Customers / BOM / returns grouping | IMPLEMENTED / INTEGRATED — browser verification pending |
| NAV-08 Reports hub | IMPLEMENTED / INTEGRATED — browser verification pending |
| NAV-10 Settings / Dimensions discoverable | IMPLEMENTED / INTEGRATED — browser verification pending |
| NAV-11 Navigation gating consolidation | verified finding, no change (ESC-4) |
| NAV-12 Fulfilment vs Manufacturing naming | IMPLEMENTED / INTEGRATED — browser verification pending |
| NAV-13 Dashboard discovery | IMPLEMENTED / INTEGRATED — browser verification pending |
| NAV-14 Missing terminology keys | IMPLEMENTED / INTEGRATED — browser verification pending |

## NAV-02 — Accounting Policy configuration (IMPLEMENTED / INTEGRATED / VERIFIED — UAT READY)

**Verify (source, before building).** All 17 `accounting.*` account-related keys were checked against the code that reads them. **12 are consumed by posting and fail closed**: inventory opening balance / adjustment gain / adjustment loss / COGS / manual-receipt reason map (D3), sales returns (D4), purchase price variance (D5), cash-bank opening balance / cash movement clearing, fixed-asset disposal gain / loss (FA-02) and acquisition clearing (D8 helper). **5 are declared in the manifest but read by no code** (`ap_expense`, `ap_opening_balance`, `ap_write_off_income`, `ar_opening_balance`, `ar_write_off_expense`): AR/AP adjustment handlers take accounts from the request payload and a hard-coded default. They are deliberately **not offered** in the UI (configuring them would mislead) — this corrects the earlier audit count ("17 mandatory") to **12 effective + 5 unconsumed**. The unconsumed five need an accounting decision (the known D5 follow-up: hard-coded 5299), **escalated, not decided here**.

**Implement.** A thin management surface over the EXISTING Configuration Engine — no new config architecture, no change to any accounting rule:
- `AccountingPolicyConfigService` (12 managed keys; anything else is refused): list with status per key, validated save, clear. Validation = the SAME rule posting applies (account must exist in the requesting Company's chart, be active, postable, carry no control function); **account-type suitability is advisory (a warning)** because choosing the account family is an accounting decision. Values are stored through `ConfigurationEngineService.set` at the engine's installation scope (where posting reads them); each change is audited in the Company.
- Routes `GET /accounting/policy-config`, `POST /accounting/policy-config/:key`, `DELETE …/:key` — Company-scoped, `accounting.account.view/edit` (no new permission node).
- UI `/accounting/policy` (Accounting group, right after Chart of Accounts; also on the Accounting cover): five groups (Inventory, Sales returns, Procurement, Cash & bank, Fixed assets), account picker limited to accounts posting could use, status badge, advisory warning, reason-map editor for the manual receipt reasons, clear (back to fail-closed). Terminology migration `1789995000000` (38 texts, all ≤ 255 chars).

**Test.** Real-PG spec `accounting-policy-config.company-isolation.spec.ts` **8/8** (first run): 12 keys listed unset; valid save stored at installation scope + audited; unknown / header / inactive / control accounts rejected with the previous value and audit trail untouched; advisory type warning; reason map (valid, one bad entry rejects the whole map, invalid reason code, clear); unmanaged keys refused; **Company A/B isolation** (the same value is OK in A and INVALID in B whose chart lacks the code; B cannot save A-only codes; audit only in the acting Company; B's DataSource never requested for A; the Platform DB has no chart); **posting verification** (the D8 acquisition helper rejects before any write while unset, then posts Dr cost / Cr the account saved through the service). Navigation spec 20/20 re-run. **Affected-area regression: 68/68 first run (8 suites: policy-config, D8 helper, inventory posting, manual receipt, accounting isolation, GRNI, navigation, module registry), 0 skipped, 0 failures.** Not a full-repository regression.
**Confirm (real app, isolated environment).** `/accounting/policy` renders the five groups with Arabic labels; saving an account → "Configured"; an unusual type → warning shown (and cleared on a typical choice); clear → "Not set"; a control account → HTTP 409 "is a control account (inventory)"; unknown code → 409; an unmanaged key → 404; the reason-map editor saves DONATION→4900; with the clearing account unset the helper returns the fail-closed 409, after saving it in the UI the helper posts and the asset becomes active; the nav registry lists the new item second in the Accounting group.

**Escalated (not blocking, no decision taken):**
- **ESC-1 (architecture):** the Configuration Engine has no Company scope level — a saved value is installation-wide while the chart is per Company. Validation here is against the CALLER's Company chart and the screen says so. *Option A (current, adequate while every Company uses the same chart template):* keep installation scope; the same code must exist in every Company. *Option B:* add a Company scope level to the engine so each Company stores its own policy accounts (touches the engine and every reader). **Recommendation: A now, B before onboarding Companies with different charts.**
- **ESC-2 (accounting):** the five unconsumed AR/AP hint keys and the hard-coded 5299 default in the AP adjustment handler (see above).

## NAV-03 — Approval visibility (IMPLEMENTED / INTEGRATED; browser verification pending)

**Verify (source).** Two mechanisms, confirmed: (1) Approval Engine — `GET /approvals/requests` (node `core.approval.view`), pending = `decidedAt === null`, central screen `/approvals` (last item of Administration) plus inline `ApprovalsPanel` on accounting screens; (2) Process-Engine transitions with their own list endpoints and a `state`/`status` field: purchase requests and purchase orders (`submitted`), warehouse transactions (`overview.pendingApprovalsCount`), sales orders (`supervisor_review` / `manager_approval` / `deposit_verification`), returns (`requested`), new-item requests (`pending`). Nothing was found that lists them together; the Dashboard had no approvals widget.

**Implement (frontend only, no backend/authorization change, engines NOT merged).** `frontend/src/lib/pendingWork.ts` reads the existing list endpoints and counts what waits; each source is fetched through its own existing permission — a 403/404 hides that source for that user. New page `/pending-work` ("بانتظار القرار / Pending work", second item of the top-level Dashboard group, no sidebar reorder) shows count, oldest waiting item and an Open link to the screen where the decision is actually taken; a Dashboard card shows the total and links to it. Terminology migration `1789996000000` (15 texts, ≤ 255 chars).

**Test so far.** Frontend and backend (build config) typecheck clean; navigation spec 20/20 and the policy real-PG spec 8/8 (which applies all migrations incl. the new one) on the isolated PG 5656; `dist` rebuilt and the bv backend restarted on 3601.
**Not yet done:** browser verification (login to the bv environment is needed; the credentials of the throw-away users were not at hand and were not guessed).

**ESC-3 (governance — NAV-04, escalated, not decided).** No ratified maker/checker policy exists for PR, payments or treasury. Process-Engine PR/PO approval has no requester≠approver rule (D7 spec shows a requester approving their own PR); payment/treasury services have no approval step. *Option A:* keep permission-only approval for PR/PO and no approval on payments/treasury (current behaviour). *Option B:* enforce requester≠approver on PR/PO now; payments/treasury approval only after the CTO sets thresholds. **Recommendation: B for PR/PO; payments/treasury stay as is until thresholds are decided.** Work on the other gaps is not blocked.

## NAV-01 … NAV-14 (remaining) — see `NAV-GAP-CLOSURE-REPORT-2026-10-06.md` (the single Closure Report): what changed, tests, limitations, escalations ESC-1…ESC-4, UAT readiness.
