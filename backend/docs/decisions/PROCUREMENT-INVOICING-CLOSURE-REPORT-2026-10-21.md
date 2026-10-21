# Procurement invoicing A-E - consolidated closure report (DRAFT for review, 2026-10-21)

**Recommendation: NOT YET READY FOR RELEASE.** Code and database verification for A-E is complete on the feature branch; the preview verification on `:5173`, the browser acceptance, the owner's review and the release authorization are still open (section 8). Nothing was merged to `main`, pushed, deployed or version-bumped; no shared or hosted database was touched.

## 1. Scope and implementation summary
| Phase | What it delivers |
|---|---|
| A | invoice lines allocated to goods-receipt lines (FIFO or a named receipt line, race-safe); safe historical backfill marked `backfill_fifo` that STOPS on inconsistent history; per-line ordered / received / returned / invoiced / remaining view; reconciliation endpoint |
| B | one supplier payment over several invoices (one cash-out, one event, one ledger debit per invoice); never above the payment or an invoice's balance; single-invoice API unchanged |
| C-1 | Draft -> Submitted -> Approved -> Posted with On Hold / Rejected; per-Company price tolerance (percentage and/or amount, zero by default); audited exception approval with its own permission; independent approver; new Companies default ON, existing OFF |
| C-2 | discount, freight (capitalised or expensed) and other charges; on-hand share revalues inventory, sold/consumed share goes to a separate account; expensed charges to a third account; exact void mirror |
| D-1 | purchase return of uninvoiced goods: stock out at book cost, GRNI at receipt cost, difference to a separate account |
| D-2 | supplier credit note linked to invoice lines, cumulative cap (shared with returns), proportional VAT, valid after partial / full payment |
| D-3 | return of invoiced goods credited through the invoice line (ledger debit linked to the invoice, Dr AP / Cr Inventory / Cr Input VAT / difference) |
| E | one invoice over several orders of the same supplier |

## 2. Changed files, migrations, branch, commits
Branch `feature/procurement-invoicing-allocations` (from `3528dd5`, worktree `.claude/worktrees/procurement-allocations`): commits `9713ad7` (A+B+addendum), `7baf2f2` (C-1), `6044748` (E + preflight), `dc02b73` (C-2, default, D-1). **D-2 / D-3 and this report are uncommitted at the time of writing.** Whole branch so far: 64 files, +5516 / -89 (before D-2/D-3).
Migrations (all additive, each with a tested `down`): procurement `1790020000000` receipt allocations (+backfill), `1790020100000` payment allocations, `1790020200000` approval columns + policy table, `1790020400000` invoice charges, `1790020500000` purchase returns, `1790020600000` credit notes; core `1790020300000` terminology. Manifests: accounting 1.20.0 (+3 config keys), procurement 1.7.0 (+permission nodes). `package.json` stays 1.1.10.
One existing-spec change: the invoice isolation fixture gained a real goods-receipt line (phase A needs one); one existing spec count updated (policy keys 13 -> 16). One existing foundation file changed: `database-provisioning.service.ts` (new-Company default stage, insert-only).

## 3. D1-D7 as implemented
D1 over-invoicing blocked at receipt-line and order-line level; price override only through the audited exception; **not implemented: quantity override / invoice-before-receipt exception (it would need an allocation to a receipt that does not exist - left blocked by design, documented).** D2 Company-level percentage / amount limits, both must pass, direction both / over-only; per-supplier and per-item overrides not implemented (settings store has no safe scope). D3 discount, capitalised freight, expensed charges, VAT separate; allocation basis = line value only (weight / quantity bases not implemented). D4 same supplier only; currency is trivially compatible (single base currency today). D5 lifecycle, independent approver, state re-checked under the row lock. D6 credit note linked to invoice lines; generic AP adjustment kept. D7 return documents for uninvoiced and invoiced goods.
Owner decisions E1 / E3 / third account / approval default: implemented as ruled (see the addendum, section 4).

## 4. Test results (real PostgreSQL, disposable databases on the dedicated cluster; coordinated with the Treasury session, never overlapping)
- New specs: allocations (12) + migrations (2: backfill/STOP/preflight/rerun and the C-1 up-down-up), C-1 approval + new-Company default (11), multi-order (9), charges (12), purchase returns (8), credit notes + invoiced returns (12): all passing.
- Full regression of the repository list (127 specs, run in 5 chunks on this branch): all pass except (a) the H3 release-migration-registry spec, which needs the isolated 5544 instance that is not authorised here - **not executed**; (b) known environmental teardown error "permission denied to terminate process" on two specs (all their tests passed; each passes when re-run alone); (c) `release-upload.http` hit `ECONNRESET` once under load and passed on three further runs alone. No spec in `foundation/release` was changed by this branch.
- 63 unit suites (455 tests) pass; backend `tsc` and ESLint clean on the touched areas; frontend `tsc` clean.
- Not run: the four provisioning characterization specs (need 5544) - the provisioning stage is covered by the mocked unit spec and by running the seeding function on a real Company database.

## 5. Historical-data reconciliation and migration rehearsal
Legacy-shaped data (live, void, draft invoices; a payment) migrated in a disposable database: FIFO rows tagged `backfill_fifo`, void invoices skipped, a second run inserts nothing, a fingerprint of every invoice / line / order line / payment / process row / ledger / journal / stock count is unchanged, up -> down -> up gives the same rows, the STOP case (15 invoiced vs 10 received) writes nothing. The read-only preflight SQL flags exactly that case and is asserted to contain no write statement. Shared development databases: Alpha has 2 orders, 2 receipts, 0 invoices, 0 payments; others empty (read-only look, 2026-10-20) - nothing to backfill. Hosted data: not assessed.

## 6. Proof of no duplicate entries
Per scenario the specs assert counts before / after for journals, ledger entries, outbox events, payments, treasury transactions, stock movements and invoiced totals; retries and second posts are refused with unchanged counts; re-driving an event is a no-op (deduped); races (two invoices, two approvals, two posts, invoice vs return, two credit notes, two payments) leave exactly one winner and no partial write. A real bug found by this testing and fixed: services that used the caller's manager without opening a transaction (approval, policy, return) - now always transactional.

## 7. GL / sub-ledger reconciliation
Final assertions in the new specs: GL inventory = valuation of every product; GL AP = supplier sub-ledger balances; GRNI sub-ledger = GL GRNI; GL trial balance = 0; allocation / aggregate / payment / ledger reconciliation endpoint clean. Tax: Input VAT credited back proportionally and never above the invoice VAT. Noted semantic (pre-existing): the GRNI sub-ledger counts a DRAFT invoice as invoiced while the GL clears GRNI only at posting.

## 8. Known limitations, open items, risks
1. **Preview not updated:** `:5173` runs the integration build on `daii_dev`; showing A-E needs the migration in `PROCUREMENT-INVOICING-DAII-DEV-MIGRATION-PLAN-2026-10-21.md`, which is NOT authorised. No browser acceptance of the new screens (purchase returns, credit notes, policy panel, multi-order, charges) has been done; they are type-checked only.
2. Accounts: three GL accounts must be assigned per Company by the finance owner; until then documents needing them are refused with the missing account named.
3. Moving-average assumption for the on-hand / sold split (invoiced units are assumed to be on hand first) - disclosed; no lot tracking exists.
4. Return of invoiced goods credits AP at the invoice unit cost at return time (not waiting for the supplier's credit note); a later credit note covers price / tax differences within the shared cap. Review requested.
5. Not implemented: quantity-tolerance, quantity override, per-supplier tolerance, weight-based allocation, credit note for freight / discount lines (credits attach to invoice lines), void of a posted return / credit note (by design - a new document corrects).
6. Provisioning stage end-to-end and the H3 registry spec need the 5544 instance (not authorised).
7. Merge needs: one agreed edit of `supplier-invoice-process.ts` / payment code with the Treasury session's payment-reversal work (it will build after this merge, in its own file).
8. Version: `package.json` is 1.1.10; the next version is to be set by the repository release policy at merge time, not here.

## 9. Preview verification and release recommendation
Preview verification: not done (item 1). Recommendation: **do not release yet.** Next gates in order: owner review of this report and the E1 / E3 / return-credit points -> authorization of the `daii_dev` migration -> browser acceptance on `:5173` (Arabic and English, permissions, Company context) -> separate release authorization -> merge, post-merge checks, version, deployment workflow.
