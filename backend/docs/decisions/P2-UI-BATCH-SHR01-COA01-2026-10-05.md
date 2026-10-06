# P2 UI batch — SHR-01 + COA-01 (2026-10-05)

**Status: CLOSED for the two items below. Frontend-only; no backend, schema or posting change. Controller count unchanged: 27/43.**
Started immediately after D9 (CTO standing rule); D7 is parked at its policy gate (`D7-NEW-ITEM-REQUEST-2026-10-05.md`).

## SHR-01 — Shipment Return form shows no customer (BUG, UI label)
- Evidence: `GET /shipments` rows already carry `customerName` (`shipment.service.ts`); the Shipment Return create-form picker label ignored it.
- Fix: `frontend/src/pages/ShipmentReturns.tsx` — `ShipmentSummary.customerName` + the option label is now `RSH/waybill — SO number — customer`.

## COA-01 — Chart of Accounts: no UI to edit an existing account (INTEGRATION GAP)
- Evidence: `POST /accounting/accounts/:id` (`accounting.account.edit`) already updates name / nameAr / description (audited, Company-scoped; real-PG proof in `accounting.company-isolation.spec.ts` — update on A, unknown to B). The UI exposed only create / active toggle / control function / reparent / import / dimension rules.
- Fix: `frontend/src/pages/accounting/ChartOfAccounts.tsx` — an **Edit** action on the selected account (name, Arabic name, description) calling the existing route. **Code and type stay immutable by design.**
- Deliberately NOT exposed: `isContra` and currency mode. Changing them alters the account's normal-balance / currency semantics; once an account has postings that is an accounting decision, not a form field. Recorded as a follow-up decision if the operator needs it.

## Verification
Frontend `tsc` clean; `oxlint` clean on both pages; `accounting.company-isolation.spec.ts` 5/5 re-run on the isolated seeded PostgreSQL (covers the backend route the UI now uses). **Not browser-verified.**

## Still open from the P1/P2 list (need input, not code)
| ID | Why it is not actionable now |
|---|---|
| INV-03 warehouse "Account Code" | No such column/label exists in code; **needs the operator's screenshot**. Per-warehouse GL would be new capability (D3: single central Inventory control account). |
| FA-02 rejected depreciation/disposal | Depreciation rejections = test-artifact currency "F14"; disposals need the **gain-on-disposal account configuration** (a configuration value the CTO/accounting owner must choose — no invented codes). |
| CUS-01 on-account / advance customer payment | Business-rule note (payment requires `invoiceId`); needs a policy decision. |
| COA-01 operator's exact failure | The reported failure text is unknown; only the missing edit UI was found. |
