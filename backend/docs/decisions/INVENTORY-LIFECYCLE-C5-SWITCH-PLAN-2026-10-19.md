# Inventory Lifecycle - C5 switch plan (per installation) - FOR REVIEW, NOTHING CHANGED

Date: 2026-10-19 - Stage C of the CTO decision of 2026-10-19.
Status: **PLAN ONLY.** No default was changed, no flag was set, no Company configuration was touched. Every flag below ships at its staged default and stays there until the owner approves a switch for a named installation after reading this plan.

## 1. The five settings (all staged, all reversible by one configuration change, none touches existing data)

| Key | Allowed | Shipped default | What `on / enforce` changes | Data written when switched |
|---|---|---|---|---|
| `inventory.document_sod_enforced` | off / warn / on | **warn** | `on`: the user who CREATED a warehouse document with a financial effect cannot submit-approve / post it (service boundary, refused before any write). `warn`: allowed, audited as `warehouse_transaction.sod_violation`. | none |
| `inventory.receipt_approval_required` | off / on | **off** | `on`: a manual receipt (receipt document with a reason) waits for the approval engine; the direct `POST /inventory/movements` receipt is refused (409, zero writes) - Stage B. | none |
| `inventory.opening_batch_required` | bool | **false** | `true`: opening stock enters only through an approved Opening Balance Batch; the legacy direct import / reason `opening_balance` is refused. | none |
| `inventory.reference_enforcement` (Stage B) | off / warn / enforce | **warn** | `enforce`: a warehouse document with no catalog reason / wrong reference / short note is refused BEFORE any write (create and submit). `warn`: allowed + audited `warehouse_transaction.reference_warning`. | none |
| `accounting.inventory_physical_count_variance` (C6) | allowed / warn / refused | **allowed** | `refused`: a count-variance posting is refused. | none |
| `accounting.inventory_f07_updates_valuation` (C6) | bool | **false** | `true`: an approved F07 revaluation also writes a valuation `revaluation` row (value-only, quantity unchanged). | valuation rows on later approvals only |

Scope of every key: `platform`, `edition`, `installation` (never per-user). The unit of switching is therefore the **installation**; a Company-level difference is only possible by the approver being absent in that Company (see 4).

## 2. Current state - facts read (SELECT only) from the experimental dev server `daii_dev` + its 4 Company databases on 2026-10-19

| Item | Alpha | Beta | Gamma | Delta |
|---|---|---|---|---|
| Overrides in `config_values` for `inventory.%` / `accounting.inventory%` (platform DB) | none (all keys at shipped defaults) | same installation | same | same |
| Role assignments (user_roles) | admin x2, sales_manager x1 | admin x2, finance x1 | admin x1 | admin x1 |
| Warehouse documents (any type / state) | 0 | 0 | 0 | 0 |
| Documents without a reason code | 0 | 0 | 0 | 0 |
| `warehouse_transaction.sod_violation` audit rows (warn-mode count) | 0 | 0 | 0 | 0 |
| Same-actor posted documents | 0 | 0 | 0 | 0 |
| Opening batches table / rows | exists after C4 migration (not yet applied here) | - | - | - |

Reading: the dev data set contains no warehouse documents, so there is **no warn-mode evidence at all** to support switching anything; the counts above are zero because nothing has happened, not because nothing would be flagged. The same query must be run by the owner on any installation that has real activity (4.6).

**Hosted / production installations: NOT ASSESSED.** The team has no host access and this plan does not claim their values. Section 4.6 gives the owner the read-only query that produces the same table for them.

## 3. Preconditions common to every switch

1. The release containing C2-C6 + reversal + ADR-INV-04 is applied and the Company migrations (inventory `1790018000000`, `1790018200000`, `1790018300000`; core terminology `1790018100000`, `1790018400000`) have fanned out to every READY Company (Stage D dry-run plan).
2. The warn-mode window has run on real activity for at least one full period close (suggested: one month) and the audit counts in 4.x are reviewed by the owner.
3. The approver population described per switch exists in **every** Company of the installation (not only the largest).
4. A named owner decision per switch is recorded in the decisions register (date, installation, key, new value, rollback owner).
5. Verification checks of 6 pass in a staging copy first when a staging host exists; on the experimental dev server they run directly.

## 4. Per-switch plan

### 4.1 `inventory.document_sod_enforced` warn -> on
- **Warn-mode evidence needed**: count of `warehouse_transaction.sod_violation` per Company over the window, split by user. Each violation is a document the same person created and pushed through. Decision rule: switch only when the violations can be explained by a person who can be replaced by a second person.
- **Actor readiness**: per Company at least TWO active users that can both (a) create documents and (b) hold the document-approval authority - a creator and a distinct approver. Today Gamma and Delta have a single `admin` each: under `on` every financial document in those two Companies would be **permanently un-postable** (the only admin is always the creator). **Do NOT switch `on` while any Company in the installation lacks a second approver, unless the owner approves an alternative** - candidates for that approval: (i) add a second authorised user; (ii) keep the installation at `warn` and monitor; (iii) a documented single-operator exception through a separate flag (this needs a new decision; not built).
- **Operational impact**: creators can no longer finish their own documents; one extra step (hand-over to an approver) per financial document; approver backlog becomes a bottleneck at period end; opening-batch / reversal documents are exempt where the code already exempts them.
- **Rollback**: set the key back to `warn` (immediate; the effective value is read on every call; no restart). Documents already blocked simply become postable again; nothing was written by the switch.
- **Verification**: creator submits -> refused with the SoD message and zero writes (snapshot test `inventory-lifecycle-c3` cases 1-3 is the automated proof); a different user posts the same document; audit row count unchanged by refusals.

### 4.2 `inventory.receipt_approval_required` off -> on
- **Evidence needed**: number of manual receipts per month and their value (documents with `reasonCode` of type `receipt`), who creates them, how many arrive through the **direct endpoint** (`stock_movements.referenceType = 'manual_receipt'` with no document) - those users lose that path (409) and must use the receipt document.
- **Actor readiness**: an approver per Company, distinct from the person who receives stock (same constraint as 4.1 if SoD is `on`).
- **Operational impact**: manual receipts post after approval, not at once; the warehouse count and valuation lag until approval; approvals pending > N days should be reported; reversal documents never wait.
- **Rollback**: set `off`; receipts pending approval stay pending and can still be approved/rejected; direct endpoint works again.
- **Verification**: the Stage B spec case 7 (both modes, zero writes on refusal) plus a real receipt document walked submit -> approve -> posted with the journal matching.

### 4.3 `inventory.opening_batch_required` false -> true
- **Evidence needed**: the installation's opening stock is already loaded (or a batch has been prepared and approved); no legacy direct import is planned.
- **Actor readiness**: users holding `inventory.opening_batch.create` and `inventory.opening_batch.approve` (distinct people), and an account configured in `accounting.inventory_opening_correction_account_code` if corrections are expected.
- **Impact**: the old Excel/direct opening path stops working; every opening goes through a batch with approval.
- **Rollback**: set `false` (a batch in progress is unaffected).
- **Verification**: legacy import refused with a message naming the Opening Balance Batch; a batch posts and reconciles (C4 specs).

### 4.4 `inventory.reference_enforcement` warn -> enforce
- **Evidence needed**: `warehouse_transaction.reference_warning` audit rows grouped by the problem text; every recurring problem needs either a user training or a catalog change (`inventory.movement_reason_catalog`) **before** enforcing - otherwise users are blocked by their own legacy habits.
- **Impact**: documents without a catalog reason, a count-variance without a posted count document, an issue with a note shorter than 20 characters are refused at create and at submit.
- **Rollback**: set `warn` or `off`.
- **Verification**: Stage B spec cases 3-6.

### 4.5 `accounting.inventory_physical_count_variance` / `accounting.inventory_f07_updates_valuation`
Left at `allowed` / `false`. Switching either changes accounting behaviour and requires the owner to confirm the ADR-INV-05/06 semantics for the installation first; no warn-mode evidence exists for `f07_updates_valuation` because the feature is new.

### 4.6 Owner-run read-only query (SELECT only) for a real installation
Run once per Company database (and once on the platform database for the overrides):
```sql
-- platform DB
SELECT "key", "value", "scopeType", "scopeId" FROM config_values
 WHERE "archivedAt" IS NULL AND ("key" LIKE 'inventory.%' OR "key" LIKE 'accounting.inventory%');
-- each Company DB
SELECT action, count(*) FROM audit_records WHERE action IN ('warehouse_transaction.sod_violation','warehouse_transaction.reference_warning') GROUP BY 1;
SELECT ro."key", count(*) FROM user_roles ur JOIN roles ro ON ro.id = ur."roleId" GROUP BY 1;
SELECT t.type, count(*) FROM warehouse_transactions t GROUP BY 1;
```

## 5. Proposed order if the owner decides to switch (each separately, never together)
1. `inventory.reference_enforcement` -> enforce (lowest risk, evidence from the new audit rows).
2. `inventory.receipt_approval_required` -> on.
3. `inventory.document_sod_enforced` -> on, only where 4.1 actor readiness is met for every Company.
4. `inventory.opening_batch_required` -> true after the opening load is finished.

## 6. Verification checks after any switch (installation level)
- `GET /inventory/reports/...` valuation report vs trial-balance difference unchanged (C1 report).
- No document stuck: count of documents in `submitted` / pending approval and their age.
- Audit: refusals leave zero rows other than the warning audits; `sod_violation` / `reference_warning` stop growing under `on` / `enforce` (they become refusals).
- Smoke: create -> submit -> approve -> posted receipt and issue in the Company with the fewest users.

## 7. What this plan does NOT do
It changes nothing, activates nothing, and says nothing about hosted installations. It asks the owner to (a) approve or amend the order above, (b) decide the operational alternative for Companies that have a single admin (Gamma, Delta on the dev server; unknown elsewhere), and (c) supply the 4.6 results for any real installation before a switch is scheduled.
