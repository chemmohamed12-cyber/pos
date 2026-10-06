# D9 — Supplier master: edit capability, auto-numbered code, no per-supplier GL account (2026-10-05)

**Status: CLOSED (2026-10-05) — IMPLEMENTED / INTEGRATED / REAL-PG VERIFIED.**
Execution rule in force (CTO): started immediately after D8 closed; no accounting/architectural decision point was hit.

## 1. Approved scope (CTO preliminary D9)
Supplier edit: yes. Code auto-numbering. **No per-supplier GL account** — Supplier → supplier sub-ledger → single `ap` control account stays as designed.
Open points in the register (which fields are editable once history exists; numbering format/prefix) are resolved in §2 as the narrowest safe reading; they are reversible configuration-level choices, not accounting policy.

## 2. Policy
| Topic | Decision |
|---|---|
| Code | Issued by the numbering engine per Company: `SUP-000001`, **no year segment** (a supplier is not a yearly document). Immutable after creation. |
| Explicit code | Still accepted on create (data migration / legacy) and must be unique. Auto-numbering skips a code already taken (bounded retry), never reuses or duplicates. |
| Editable | legal name, trading name, type, tax / VAT / commercial registration numbers, payment terms, credit limit. Allowed at any time — documents keep their own ids/snapshots and the ledger keys on `supplierId`, never on the name. |
| Not editable here | `code` (immutable); `status` (own transition route); bank accounts (maker-checker, 2 approvers — unchanged). |
| VAT registration number | Read live by the D5 rule (VAT > 0 on a supplier invoice requires it) — editing takes effect on the next posting. |
| Audit | `supplier.updated` with before/after of only the changed fields; a no-op edit writes nothing. |
| GL account | A supplier carries **no** GL account column (asserted in the spec). Unchanged AP architecture. |

## 3. Implementation
| Piece | Where |
|---|---|
| `SupplierService`: `NumberingService` injected; `create` with optional `code`; `updateSupplier`; `SUPPLIER_DOCUMENT_TYPE` | `procurement/application/supplier.service.ts` |
| `POST procurement/suppliers/:id/update` (permission `procurement.supplier.edit`; POST because the shared frontend `api` has no PATCH); `code` optional on create | `procurement/interface/supplier.controller.ts` |
| UI: one form for add / edit with all master fields (SUP-01), no manual code, edit action on the detail panel (SUP-02/03) | `frontend/.../procurement/Suppliers.tsx` |
| Terminology (ar/en) | core migration `1789970000000-SeedSupplierEditTerminology` |

## 4. Verification (real PostgreSQL)
**Spec** `procurement/interface/supplier-master.company-isolation.spec.ts` — **6/6**, Company A with B as witness: (1) codes `SUP-000001/2` in A, B has its own `SUP-000001`; (2) explicit code accepted, duplicate rejected, auto-number skips a colliding legacy code; (3) edit changes every master field, code/status untouched even if `code` is smuggled in, audited before/after; (4) no-op edit = no audit row, nullable fields clearable, empty legal name rejected; (5) no GL-account column on `suppliers`; (6) B cannot edit A's supplier (404), B's edit never touches A, B's DataSource never requested for A's calls.
**Blast radius:** all 10 procurement suites serially on the isolated seeded PG — 10/10 suites, 68/68 tests (rfq-supplier, supplier-invoice, supplier-invoice-ppv-vat, supplier-payment, purchase-order, goods-receipt, purchase-request, rfq-award-visibility, grni-posting). Backend `tsc` (build config) and frontend `tsc` clean; backend D9 files eslint clean; `Suppliers.tsx` only has the pre-existing `set-state-in-effect` warning on the initial `load()` effect. **Not browser-verified.**

## 5. Known limits / follow-ups (not part of D9)
- Existing suppliers keep their current (manually typed) codes; no renumbering.
- Contacts / addresses have add-only routes (no edit/remove) — not requested.
- No uniqueness constraint on tax/VAT/commercial numbers (duplicate-supplier detection) — a future policy choice.

## Status
**D9 = CLOSED (2026-10-05).** Next in the CTO order: D7 (New Item Request), then COA / remaining P1/P2.
