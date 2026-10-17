# CTO decisions on the Gate B package (recorded 2026-10-17)

Source: the CTO's written decision after reviewing `00-GATE-B-ARCHITECTURE-PACKAGE.md` and the 12 ADRs. This file is the authoritative record of what is approved, what is deferred, and the boundary of slice C1. Where an ADR text and this record differ, **this record wins**.

| Item | Decision | Effect on the ADRs |
|---|---|---|
| **O-1** opening-balance correction after stock moved | Approved in principle: configuration key `accounting.inventory_opening_correction_account_code`, per Company, validated as an eligible **equity-side** account. A correction after later movements must be an approved, traceable adjustment that references the original opening batch. **No silent routing through ordinary P&L gain/loss accounts.** The separate reversal-batch path for untouched stock is kept. | ADR-INV-01 section 2.3 confirmed (implemented in C4, not C1) |
| **G-ISS-1** warehouse issue accounting | **No change to issue posting in this phase.** Capture and validate reason codes and references in the staged roll-out; keep the existing COGS posting. Any expense-account mapping needs a separate explicit accounting approval. | ADR-INV-04: the issue-reason accounting rows (`accounting.inventory_issue_reason_accounts`) are **deferred / not approved**; the capture-only part stays |
| **ADR-INV-05** F07 vs D3 | Approved: quantity changes -> D3 documents; value-only write-downs -> F07 updating valuation and the financial effect **atomically**, idempotent, fail-closed on account/period. Stop accepting new `physical_count_variance` **only after compatibility and regression tests prove the replacement path safe**. Preserve all historical F07 entries; no rewrite, no automatic correction. | Implemented in C6 (not C1); the retirement is gated by tests |
| **ADR-INV-06** rounding | **Phase 1 approved only:** itemise and explain rounding residuals in reconciliation; **no change to valuation amounts and no tolerance** that could hide discrepancies. **Phase 2 not approved** until Phase 1 results are reviewed and its effects on valuation, transfers, currencies and historical balances are demonstrated. | Phase 1 is in C1 (inside reconciliation v2); phase 2 not scheduled |
| **C1-C6** | Sequence approved as the plan, **with a separate authorisation per slice. Only C1 is authorised now.** | see below |

## Boundary of slice C1 (authorised)
C1 is **observational and backward-compatible**: valuation reporting and as-of support; cost-versus-selling-price KPI clarification; read-only reconciliation improvements (including phase-1 rounding attribution); posting-status visibility; continuous screen refresh; additive GL/TB read models.
**Not in C1:** opening-balance enforcement, reason-based accounting changes, phase-2 rounding, business-date propagation (C2), receipt approval / SoD / reason-reference validation (C3), the opening batch (C4), F07 changes (C6).
C1 may change code and add **reversible schema on isolated test databases only**. No production migration, production configuration change or production data change.
Scoping note made by the engineer (recorded for review): ADR-INV-10 section 2.1 item 1 (calling `dispatchAfterCommit` from inventory entry points) changes **when** a journal posts, not how, but it is not in the CTO's C1 list; it is therefore **moved to C2** behind a flag. C1 delivers posting-status visibility and refresh on top of the existing 30 s sweep.

## C1 acceptance gate (the CTO's list)
Real PostgreSQL tests; Company A/B isolation; permissions and F6 scope; migration up/down/up and idempotent backfill; no duplicate journals on retries; **no writes from reconciliation**; backward-compatible existing API and TB contracts; the full existing regression suite; browser verification of refresh and posting-status behaviour. "The design being approved does not mean the implementation is correct": C1 is successful only with evidence, not with a build. **Stop after C1 with the evidence report; do not start C2 or any later slice without explicit approval.**

## Implementation deviations recorded during C1 (for review)
1. **ADR-INV-09 status vocabulary.** The ADR proposed a new `explained` run *status*. Implemented instead as a separate additive column `classification` (`matched` / `explained` / `unexplained`); the run `status` values and their CHECK constraint (`matched` / `drift_found` / ...) are untouched, so every existing consumer and screen keeps working. `drift_found` is still raised for ANY non-zero difference - it is never hidden by an explanation.
2. **No tolerance anywhere.** Rounding is attributed exactly per posted line (transaction minus base amount); a difference of 0.0001 stays visible.
3. **Valuation `businessDate`.** Stamped by a database default (UTC date) for every writer; legacy rows are backfilled from the UTC date of `createdAt` (a processing date, documented). Explicit caller-supplied business dates arrive in C2.
