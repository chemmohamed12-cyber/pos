# ADR-049 — Month-End Closing / Period Closing Engine (Deferred)

**Status:** Deferred — approved future capability, not scheduled. Recorded so it is not
lost, not to be implemented until the Roadmap sequence reaches it (CTO directive, 2026-09-18).

## Context

Once the ERP financial chain (Sales/Procurement → Inventory → Subledgers → GL) is fully
audited and closed end-to-end, the next advanced ERP capability — explicitly agreed but
deliberately out of scope until its turn in the Roadmap — is a Period Closing Engine. This
ADR exists only to hold that agreement durably; it authorizes no implementation work now.

## Scope (when its turn comes)

- Closing Audit — a pre-close sweep across the chain.
- Operations ↔ Inventory ↔ Subledgers ↔ GL reconciliation.
- Detection of unposted / unmatched / open transactions blocking a clean close.
- Closing Exceptions + blockers surfaced explicitly, not silently skipped.
- Hard block on closing a period while critical discrepancies remain open.
- Final reconciliation step once exceptions are cleared.
- Period Lock (no further posting into a closed period without explicit reopening).
- Controlled reopening / adjustment-period mechanism (never a silent unlock).
- Full audit trail for every close, exception, override, and reopening.

## Consequences

- No code, schema, or module-registry change is authorized by this ADR alone.
- The next session/phase that reaches this item in the Roadmap sequence should treat this
  document as its starting context, then follow the same audit-first discipline used
  throughout this project (read existing ADRs/blueprints for GL, Fiscal Year/Period,
  Financial Events, and Subledger reconciliation before designing anything new).
