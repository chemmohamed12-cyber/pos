`# Browser Verification #1 — D1 / D6 / D7 / D8 / D9 / PRC-01 / CUS-01 / COA-01 / SHR-01 (2026-10-06)
`
`**Status: PERFORMED for all nine stages against the REAL backend and frontend in an ISOLATED environment. Two defects found and fixed; one pre-existing accounting finding raised for a CTO decision (§4). UAT verification remains PENDING (this is developer browser verification, not UAT).**
`
`## 1. Environment (nothing shared was touched)
`- Throw-away PostgreSQL cluster on `127.0.0.1:5656` (never `daii_dev`, never the HR instance on 5544): control-plane DB `bv_cp` + Company DB `bv_co` (every module's migrations, role templates, admin role), built by `backend/tools/testing/bv-bootstrap.ts`, `bv-migrate-all.ts`, `bv-seed.ts`, `bv-add-user.ts` (disposable; re-create from scratch at any time).
`- Real backend (`node dist/main.js`, port **3601**) and real Vite frontend (port **5601**) started through two new `.claude/launch.json` entries (`bv-backend`, `bv-frontend`); ports 3500/5173 belong to other sessions and were not used.
`- Two test users (maker / checker) created for this environment only — maker ≠ checker needs two real users. Test credentials live only in the bootstrap scripts of the throw-away environment.
`- Method: Claude Browser pane, the app driven through its own screens (forms filled and buttons clicked, results read from the rendered DOM and the network/console). The pane was not on screen, so **no screenshots**; evidence is DOM text, network status and console. Where a stage needs a prerequisite that has no simple screen (a posted manual journal, raw-seeded customer/invoice/shipment rows), it was created by API/SQL and only the stage's own screens are claimed as verified.
`
`## 2. Results
`| Stage | Screen(s) | Verified in the browser | Result |
`|---|---|---|---|
`| D9 | Suppliers | Add-supplier form has the 8 master fields and **no code field** (+ "code is generated automatically" note); create → table shows **SUP-000001**; row click → detail with Edit; edit form pre-filled; save → table and header updated | PASS |
`| D7 | Purchase Requests, Approvals | "Request a new item" card → notice with **NEW-000001**, request listed "pending"; a PR carrying the draft item shows the **"item pending approval"** badge; **approving the PR is refused** with the lifecycle-gate message (server error rendered); a **second user** approves the item request on the Approvals screen (type title shown, rule `sales.catalog.edit` ×1) → request "approved", item active; the PR then approves | PASS |
`| PRC-01 | PR create form, PR detail, RFQ detail, PO detail | on-hand / reserved / available cells: **40 / 0 / 40** for the stocked item and **0 / 0 / 0** for the new item, on all four screens | PASS |
`| D6 | RFQ, Approvals | PR → RFQ → send → record quotation (87.50) → award → **"Award awaiting approval"** banner with request id, supplier, total 87.50, the node a *different* user must hold (0/1), "Open approvals"; checker approves → RFQ "awarded" and **"Award approved — PO: PO-2026-000001"** | PASS (after the title fix, §3) |
`| D1 | Inventory, Products | scope selector (this warehouse's items / all items); assign an item as default via the combobox → row "default ×"; unassign (×) always works; "all items" scope lists the whole catalogue; Products create form has the **initial/default warehouse** field | PASS (after the label fix, §3) |
`| COA-01 | Chart of Accounts | select account → Edit → pre-filled name / Arabic name / description → save → header and tree row update (Arabic name) | PASS |
`| SHR-01 | Shipment Returns | shipment picker option reads "WB-BV-1 — BV Customer Co" (waybill — customer) | PASS |
`| D8 | Fixed Assets | new asset shows status "pending acquisition" and the **Link acquisition journal** action; panel shows the 3-step guidance and, with no match, "no matching POSTED journal" + "Open journal entries"; after a posted exact-cost journal exists the picker lists it ("JV-… · date · 12000.0000 · description"); link → status **Active**, link action gone, Dispose offered | PASS |
`| CUS-01 | Customer Account, Payments, receipt print | "Customer advance / unapplied receipt" card; record on-account payment (500, mapped bank) → **PAY-… unapplied 500.00 / 500.00**; apply 200 to INV-BV-1 → **unapplied 300.00 / 500.00**, invoice remaining 700.00 "partially paid"; applying 900 → server message "only 300.00 … is unapplied", nothing changed; Payments list labels the row as a customer advance; the receipt print renders with no invoice | PASS |
`
`## 3. Defects found by the browser run — fixed
`1. **D1 (UI):** in the "All items" scope every unassigned row, including items with **zero stock**, was labelled "has stock (not default)". Fixed in `frontend/src/pages/Inventory.tsx` (label only when on-hand ≠ 0, otherwise "—"); re-verified in the browser.
`2. **D6 (terminology):** the Approvals screen showed the raw key `action.award_rfq` for an RFQ-award request (the title code is registered by `RfqService` but had no terminology row). Fixed with core migration `1789993000000-SeedRfqAwardApprovalTitleTerminology`; re-verified. Six other request types in other modules have the same gap (`attendance.correction`, `attendance.approval_batch`, `commission.batch_approval`, `payroll.run_approval`, `targets.target_approval`, `accounting.fiscal_period.reclose`) — **not changed (not my stages); owners needed.**
`
`## 4. Finding for the CTO — NOT fixed (accounting / Area 21, closed area)
`**Posting any journal in a Company database fails in the real app with "No numbering sequence registered for document type accounting_journal_entry".** `JournalEntryService.onModuleInit` registers the `accounting_journal_entry` sequence only on the AMBIENT database; `createEntry`/`postEntry` then draw the number from the Company manager without registering it there, and nothing in Company provisioning seeds it. Every real-PG spec masks this by registering the sequence by hand in its setup. Impact: manual journals and every event-driven GL posting in a freshly provisioned Company. Likely fix (small): register the sequence with the supplied manager before drawing the number, the way the other services do — **needs your authorization** because it touches the closed journal engine. For this verification the sequence was inserted into the throw-away Company DB by SQL.
`
`## 5. Limits / notes
`- Not UAT: single developer, fixtures partly raw-seeded; the Dashboard logged process-instance 404s for the raw-seeded sales order (fixture, not a product defect, fixed by seeding the instance rows).
`- No screenshots (pane hidden); no visual/layout/RTL review beyond DOM text; no cross-browser check.
`- Earlier console 502s were from the first backend start (missing module tables in the control-plane DB of this environment); none after the second start.
`- The throw-away servers (3601 / 5601) and the 5656 cluster are left running for follow-up checks.
