# Daii Maturity Target Policy

Status: **ACCEPTED (ADR-016).** Stage 1.1 Final Closure item A.

---

## 1. The Rule

| | Target | V1 Acceptable Bar |
|---|---|---|
| **Platform Architecture / Contracts** (the shape of every Foundation/Shared Engine — its API contract, data contract, extension points) | **L3 — designed at Platform-grade scope from the beginning** | N/A — contracts are not allowed to be "V1-scoped," only implementations are |
| **V1 Implementation** (what actually ships and runs for Daii V1) | L3 where feasible | **L2 acceptable, only with an explicit, written justification per capability** |

L2 is not the long-term architecture target for any capability. It is a permitted *implementation coverage* gap against an L3 *contract* — never a permitted *contract* gap.

## 2. What "Strict Subset, Not Divergent Shortcut" Means Concretely

- **Allowed:** Media abstraction's port is defined to support both S3 and local-filesystem adapters (L3 contract); V1 ships only the S3 adapter (L2 coverage). Adding the local-filesystem adapter later is additive — no existing consumer's contract changes.
- **Not allowed:** Media abstraction's V1 API directly returns an S3 URL as its contract (instead of an opaque reference resolved by whichever adapter is active) — this would require every consumer to change when a second adapter is added later. This is the exact shape of "temporary architecture requiring future breaking redesign" the CTO directive prohibits.
- **Allowed:** Scope Engine ships V1 with only the Sales-Rep-to-Customer and Warehouse-Worker-to-Warehouse assignment types implemented (L2 coverage of a smaller policy set); the contract (`ScopeCheck(actor, resourceType, resourceId) → allow/deny`) is generic enough to add new assignment types without changing the contract shape.
- **Not allowed:** Scope Engine hardcodes "sales rep" as a parameter type in its function signature instead of a generic actor/role reference — this bakes a V1-only assumption into the contract itself.

## 3. Application to Every Capability

Every row in `architecture/extraction/DAII_PLATFORM_GRADE_MATURITY_SCORECARD.md` is re-read under this policy at Stage 2 implementation time: **the per-dimension target column already states L3 in every case** (this was true even before ADR-016 formalized it as policy — the scorecard's "Target for Shared Engine" column never listed L2 as a final target, only as the Stage 1/1.1 planning-time current state). ADR-016 makes explicit what the scorecard already implied: L2 is where most capabilities currently stand, not where they are meant to stay.

## 4. Enforcement

- Code review checklist item: "Does this contract change if we add [the next planned adapter/consumer/deployment target]? If yes, the contract is wrong, not just incomplete."
- No ADR may propose an L2-shaped *contract* as final — an ADR proposing an L2 *implementation* against an L3 *contract* is the only acceptable form (see ADR-017 through ADR-019 below, each following this shape).
