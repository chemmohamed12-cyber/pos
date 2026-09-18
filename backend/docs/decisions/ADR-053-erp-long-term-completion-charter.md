# ADR-053 — DAII ERP Long-Term Completion Charter

**Status:** ACCEPTED
**Date:** 2026-09-18
**Full detail:** `architecture/DAII_ERP_LONG_TERM_COMPLETION_CHARTER.md`

## Context

The program has reached the point where multiple modules (Sales, Inventory/Warehouse, Shipping/Logistics, Customer Finance, Treasury, Accounting F01–F14, HR P9, and now Procurement — ADR-048) are live or in active build, by more than one team/session working in parallel on the same codebase. Without an explicit, binding statement of intent, the risk is that a future module gets built to work correctly in isolation while diverging from the ratified architecture at points that matter — exactly the class of gap `ADR-052-grni-policy-impact-analysis-PENDING.md` caught live in Procurement. Framing remaining work as "we're at ~55–60%, get to 100%" invites exactly this failure mode: teams building disconnected features to move the number, rather than integrated ERP capability.

## Decision

**DAII is developed as one progressively-complete, integrated ERP system, never as a set of independent modules.** Every future module (starting with the already-sequenced Wave 1 Financial Control → Wave 2 HR → Wave 3 Payroll → Wave 4 Manufacturing → Wave 5 Enterprise Expansion) must:

1. Extend the existing ERP Core (Auth/RBAC, Approval Engine, Audit, Process Engine, Financial Event mechanism, Numbering, Configuration) — never duplicate or bypass it.
2. Document its ERP Integration Contract (business documents, inventory effects, financial effects, control integration) before implementation begins.
3. Preserve the platform's permanent server-based multi-user architecture requirement — concurrent-user correctness is a completion criterion, not a future enhancement, and must be verified per module where materially relevant.
4. Be accepted as "complete" only against three proofs: it works, it is ERP-integrated, and it does not block or complicate the modules that follow it.

"100%" is redefined precisely: 100% of the approved DAII ERP capability scope tracked in a living Capability Coverage Matrix — never an undefined universe of ERP features. The full charter (`architecture/DAII_ERP_LONG_TERM_COMPLETION_CHARTER.md`) is the canonical, binding reference for every subsequent phase; this ADR records that it has been adopted.

## Consequences

- Every future "Module X is done" report must state the three proofs from the charter's §18, not just that the UI/API works.
- A living DAII ERP Capability Coverage Matrix must be started and updated after every major completed phase (charter §4) — not yet created as of this ADR; its creation is the first concrete follow-up.
- Escalation to the CTO is required only for the specific categories in charter §16 (accounting-policy conflict, ADR conflict, uncovered security/control decision, business-invariant change, new architectural boundary, roadmap-changing requirement, or a decision that forces rebuilding an existing core component) — all other implementation decisions proceed without waiting for sign-off.
- Production remains on HOLD pending separate release authorization, independent of how much of the roadmap is complete.
