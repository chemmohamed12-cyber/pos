# ERP functional-integrity audit — Closure Report (2026-10-06)

**Final state: Audit / Decision Closure = CLOSED · Implementation Verification = VERIFIED · Browser Verification = PERFORMED / VERIFIED · UAT = READY / PENDING EXECUTION · Production = HOLD.**

## 1. Closed
| Item | Status |
|---|---|
| D1 item↔warehouse (default/origin, transferable) | VERIFIED / CLOSED |
| D2 treasury bank-leg · D3 inventory posting (+D3-B manual receipt) · D4 returns accounting · D5 PPV + Input VAT | VERIFIED / CLOSED (earlier in the program) |
| D6 RFQ award visibility | VERIFIED / CLOSED |
| D7 New Item Request + lifecycle gate | VERIFIED / CLOSED |
| D8 fixed-asset acquisition link (manual JE + link) and the Acquisition-Journal Helper (Option C, Acquisition Clearing) | VERIFIED / CLOSED (helper: VERIFIED — UAT READY) |
| D9 supplier edit + auto-numbered code | VERIFIED / CLOSED |
| D10 Event Engine per-Company dispatch · T0 clean-company baseline | VERIFIED / CLOSED |
| PRC-01 stock visibility · COA-01 · SHR-01 · CUS-01 on-account payments | VERIFIED / CLOSED |
| FA-02 disposal gain/loss accounts | VERIFIED / UAT READY |
| **INV-03** warehouse "Account Code" | **VERIFIED / CLOSED** — closed on the CTO's statement (2026-10-06) that the operator's screenshot confirmed the finding. **No code change, no migration, no warehouse GL account; the approved model stays one central Inventory Control account (1120).** *Evidence note: the screenshot file itself was not received by the engineering session and is therefore NOT attached here — attach it to this record when it is supplied.* |
| Journal Company Numbering (defect found by Browser Verification #1) | VERIFIED / CLOSED — fresh Company, no SQL, sequence created on the Company DB, A/B isolation, concurrent first posts, event-driven posting, Platform is not a numbering source. No data repair needed (test data only). |
| Browser Verification #1 (D1/D6/D7/D8/D9/PRC-01/CUS-01/COA-01/SHR-01) | PERFORMED / VERIFIED |

## 2. Tested
Every stage has a real-PostgreSQL spec with Company A/B isolation (Platform DB untouched) and a recorded blast-radius regression (decision records + Matrix §54–§67). Browser Verification #1 exercised the nine UI stages in the real backend + frontend on an isolated, disposable environment (own PostgreSQL 5656, backend 3601, frontend 5601; two users for maker-checker). The journal-numbering fix and the D8 helper were additionally verified live in Companies provisioned through the real API with no SQL.

## 3. Fixes made during verification
1. **D1 (UI):** zero-stock unassigned items were labelled "has stock" in the All-items scope → fixed, re-verified.
2. **D6 (terminology):** Approvals screen showed the raw key `action.award_rfq` → label added (core migration 1789993000000), re-verified.
3. **Journal numbering (Foundation / Area 21 defect surfaced by the browser run):** the JV sequence was registered only on the ambient DB, so the first post in a fresh Company failed (manual and event-driven) → registered per Company, lazily, on the drawing manager; spec 5/5 (4/5 fail without the fix).
4. Earlier in the program: a >255-character terminology text that broke the shared migration for every harness spec (fixed the same day).

## 4. Remaining limitations (documented as-is)
- Regression is NOT a full-repository run. **Manufacturing/WIP failures are pre-existing test-environment/schema issues (the isolated DB lacks other sessions' newer manufacturing migrations, e.g. the routings table) and were not caused by the changes in this stage.** Four HR/provisioning characterization suites are guarded to run only on the HR instance and were not run.
- Browser verification is developer-level: no screenshots (pane hidden), DOM/network/console evidence only, some fixtures raw-seeded; not a UAT.
- FA-02: a Company B disposal approval was not executed end-to-end (the harness has no B approver) — a UAT item. Six other approval request types in other modules lack a title terminology row (reported, not changed).
- The Acquisition Clearing account is not settled by anything yet — settlement against AP/Bank belongs to those future workflows; no settlement logic may be added to the helper.

## 5. Out of scope (not started)
D4/D5/D6/CUS-01 deferred follow-ups; Manufacturing/WIP and HR work and their stale suites (other owners); H3 deployment safety (a different work stream — note: in THIS working tree `MIGRATION_TAGS` in `backend/src/database/enabled-modules.ts` still lists 6 tags and is unmodified since the baseline commit, so the H3 registry fix is not present here); any new feature.

## 6. UAT
READY / PENDING EXECUTION. Items to execute in UAT: all nine browser-verified stages with real operators, FA-02 including a Company B approver, the Acquisition Clearing helper with a configured clearing account, an on-account payment → application cycle, and visual / RTL review.

## 7. Production
**HOLD.**
