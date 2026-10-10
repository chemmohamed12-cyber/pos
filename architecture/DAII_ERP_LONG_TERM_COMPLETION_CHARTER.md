# CTO Directive — DAII ERP Long-Term Completion Charter

**Status:** ACCEPTED — binding reference for every subsequent phase.
**Date:** 2026-09-18
**Referenced by:** `release-new/backend/docs/decisions/ADR-053-erp-long-term-completion-charter.md`

## Purpose

DAII is not being developed as a collection of independent modules.

The current and future development program has one long-term objective:

> Gradually evolve DAII into a complete, integrated, enterprise-grade ERP platform, approaching 100% coverage of the defined DAII ERP scope through controlled incremental development.

The current system already contains a substantial ERP foundation and multiple operational and financial domains. The remaining modules are therefore not separate projects. They are successive layers that must integrate into the same ERP architecture.

---

## 1. The Long-Term Objective

The team must treat the current DAII architecture as the foundation of a progressively complete ERP system.

The target is **not** a set of isolated applications (Module A, Module B, Module C, Module D). The target is one connected system:

```
                         DAII ERP
                            │
              ┌─────────────┼─────────────┐
              │             │             │
          Operations     Financial      People
              │             │             │
          Sales          Accounting       HR
          CRM            AR/AP            Payroll
          Inventory      Treasury
          Warehouse      Tax
          Procurement    Assets
          Logistics      Closing
              │             │             │
              └─────────────┼─────────────┘
                            │
                    Shared ERP Foundation
                            │
          Auth / RBAC / Approval / Audit / Events
          Process Engine / Configuration / Documents
          Numbering / Organizations / Reporting
                            │
                            ▼
                       DAII ERP Core
```

Every future module must become part of this connected system.

---

## 2. The Current State Must Be Preserved

The current `release-new` implementation is the canonical development baseline. The team must preserve the architectural and financial work already completed.

Future development must **not**:

- bypass existing domain boundaries;
- create parallel accounting mechanisms;
- create isolated inventory balances;
- bypass the Approval Engine;
- bypass the Audit system;
- bypass Process Engine lifecycle controls;
- write directly to stock when the Inventory Service is required;
- create independent customer/supplier balances when ledgers already exist;
- create duplicate Treasury mechanisms;
- introduce a second Financial Event mechanism;
- duplicate existing Foundation capabilities.

**Principle:** extend the existing ERP architecture; do not build a second architecture beside it.

---

## 3. Every New Module Must Be ERP-Integrated

Before a future module is considered complete, the team must answer:

**Business Integration**
- What business documents does it create?
- What existing modules consume those documents?
- What modules can originate transactions affecting it?

**Inventory Integration** (where applicable)
- Does it create inventory movements?
- What document is the source?
- Is quantity traceable?
- Is valuation affected?
- Does it affect Inventory Accounting?

**Financial Integration** (where applicable)
- Does it create a Financial Event?
- Does it affect GL?
- Does it affect AR/AP?
- Does it affect Treasury?
- Does it affect dimensions?
- Does it affect tax?

**Control Integration** — every applicable module must use:
- Process Engine
- Approval Engine
- RBAC
- Audit Trail
- Transaction boundaries
- Idempotency
- Concurrency controls
- Outbox/event mechanisms, where applicable

A module that works by itself but breaks these integrations is **not** considered complete.

---

## 4. The ERP Must Be Built Toward Progressive 100% Coverage

The current estimated coverage is approximately 55–60% of a broad medium/large ERP scope, with substantially higher coverage in the existing Financial, Sales, Inventory and operational foundations.

This percentage is a **planning indicator, not a software quality score**. It must not be used to justify rushing development.

Instead, the team must maintain a living **DAII ERP Capability Coverage Matrix**, containing:

| Field |
|---|
| Capability |
| Domain |
| Current Status (Implemented / Partially Implemented / Not Implemented) |
| Dependencies |
| Accounting Impact |
| Inventory Impact |
| Integration Requirements |
| Acceptance Criteria |
| Target Phase |

The matrix must be updated after every major completed phase.

---

## 5. The Remaining ERP Areas

The long-term roadmap should progressively address the remaining capability areas.

**Wave 1 — Financial Control**
```
Procurement conflict resolution
        ↓
Month-End Closing
        ↓
Period Lock
        ↓
Immutable Monthly Black Box
```

**Wave 2 — Human Resources**
```
Employee / Department / Organization / Contracts / Documents / Attendance / Leave / HR Operations
```

**Wave 3 — Payroll**
```
Attendance → Payroll Calculation → Allowances / Deductions → Approval → Payment → GL → Month-End
```

**Wave 4 — Manufacturing**
```
BOM → Production Order → Material Consumption → WIP → Finished Goods → Production Cost → Inventory → GL
```

**Wave 5 — Enterprise Expansion** (progressively, per actual business scope — roadmap capabilities, not authorization to implement all of them immediately)
- Advanced Tax
- Multi-Currency
- Multi-Company
- Consolidation
- Advanced Planning / MRP
- Enterprise BI / Forecasting / Advanced reporting
- External integrations

---

## 6. The Multi-User Requirement Is a Permanent Architecture Requirement

DAII is intended to operate as a **server-based multi-user ERP system**. The fact that multiple users can access the system simultaneously is not a future enhancement — it is an architectural requirement that must remain valid throughout development.

Future modules must be designed for concurrent users operating on the same system and database. The team must preserve:

**Database Integrity**
- transactional consistency
- foreign-key integrity
- unique constraints
- proper isolation where required
- row locking where required
- optimistic concurrency where applicable

**Business Concurrency** — deterministic, defined behavior for cases such as:
- User A edits Supplier / User B edits the same Supplier
- User A approves a document / User B attempts to modify it
- User A posts inventory / User B posts another movement
- User A closes a period / User B attempts to post

---

## 7. No Module Is Complete Until Multi-User Behavior Is Verified

Future acceptance tests should include concurrent scenarios where materially relevant, for example:

- Concurrent document creation
- Concurrent stock movement
- Concurrent payment
- Concurrent approval
- Concurrent document modification
- Concurrent period closing
- Concurrent retry
- Concurrent event delivery

The expected result must be defined **before** PASS. The team must not rely on "it works with one user" — single-user correctness is insufficient for an ERP.

---

## 8. ERP Integration Is More Important Than Feature Count

A smaller number of deeply integrated capabilities is preferable to a larger number of disconnected CRUD modules.

**Not acceptable:**
```
Goods Receipt → Stock +20
```
(if the ERP architecture requires additional financial treatment)

**Target architecture:**
```
Purchase Order → Goods Receipt → Inventory Movement → Financial Consequence
→ Supplier / AP → GL → Closing / Reconciliation
```

The exact accounting treatment must follow the approved accounting policy for that domain. This principle applies to every future module.

---

## 9. Every New Module Must Identify Its Place in the ERP Graph

Before implementation, the team must document:

```
INPUTS → Business Process → Documents → Operational Transactions
→ Inventory / Financial Effects → Approvals → Audit → Reporting → Closing
```

This becomes the module's **ERP Integration Contract**. The team must not start implementation of a major module until this contract is understood.

---

## 10. Reuse Before Creating New Infrastructure

Before creating any new permission mechanism, approval mechanism, audit mechanism, event mechanism, configuration mechanism, numbering mechanism, document mechanism, reconciliation mechanism, or concurrency mechanism — the team must search the existing Foundation and determine whether an existing capability can be reused.

**New infrastructure requires justification.**

---

## 11. Accounting Is the ERP's Control Spine

For financially relevant operations, the team must preserve the principle:

```
Business Document → Operational Effect → Financial Event → Journal
→ Subledger → Reconciliation → Closing
```

No future module should introduce an alternative accounting path without explicit architectural approval. This is particularly important for: Procurement, Inventory, Sales, Returns, Payroll, Fixed Assets, Manufacturing, Tax, Treasury.

---

## 12. The System Must Remain Extensible

The goal is not to hard-code today's ~60% and then discover the remaining ~40% requires rebuilding the foundation. Every new capability should preserve: bounded contexts, modularity, domain contracts, event-driven integration where appropriate, organization boundaries, permission hierarchy, auditability, configuration separation, and future multi-entity extensibility where already required by architecture.

Do not implement future modules now merely to "prepare for them." Instead: **build today's module correctly without closing the door to tomorrow's module.**

---

## 13. Development Execution Rule

Every future wave must follow:

```
Architecture Contract → Implementation Plan → Phase N → Code → Unit Tests
→ Integration Tests → E2E → Accounting Verification → Multi-User Verification
→ Regression → Architecture Compliance Review → PASS → Phase N+1
```

No phase is considered complete merely because the UI works.

---

## 14. Definition of ERP Completion

"100%" does **not** mean "every conceivable ERP feature in the world." It means:

> 100% of the approved DAII ERP capability scope defined by the DAII roadmap and Capability Coverage Matrix.

This distinction is mandatory. The team must continuously expand the Capability Matrix as the product strategy evolves, but must never claim completion against an undefined universe of ERP features.

---

## 15. Long-Term Development Principle

Every implementation decision contributes to the future ERP. Before implementing a new feature, ask:

> Will this decision make the next ERP module easier to integrate, or will it create technical debt that forces us to rebuild something later?

Prefer:
```
Current Module → Existing ERP Core → Next Module → Next Financial/Operational Integration → Next Module
```
over building modules independently and "attempting to integrate everything later." The second approach is explicitly not the DAII strategy.

---

## 16. CTO / Team Authority Model

The team is authorized to make ordinary implementation decisions within the approved architecture and should not stop development for routine implementation choices.

**Escalation is required only when encountering:**
- an accounting-policy conflict;
- conflict between approved ADRs;
- a security/control decision not covered by the architecture;
- a material change to an approved business invariant;
- a new architectural boundary;
- a requirement that materially changes the roadmap;
- a decision that would force rebuilding an existing core component.

When no such conflict exists: **resolve → implement → test → PASS → continue.**

---

## 17. Final Direction

DAII development is a multi-stage ERP completion program, not a sequence of disconnected feature requests. The immediate objective remains:

```
P0 Procurement Resolution → Month-End Closing → Immutable Black Box
→ HR → Payroll → Manufacturing → Enterprise Expansion
```

Each stage must integrate with the same ERP Core and must preserve: **Accounting Integrity + Inventory Integrity + Auditability + Security + Multi-User Concurrency + Extensibility.**

The team should continuously move the platform toward the defined 100% DAII ERP capability scope, without attempting to implement everything simultaneously.

**Production remains HOLD until a separate release authorization.**

---

## 18. Proof of Completion for Any "Module X Is Done" Claim

From this charter forward, a claim that a module is complete must be accompanied by proof of three things, not one:

1. **The functionality works** (verified, not assumed).
2. **It is integrated with the ERP Core** (accounting, inventory, approvals, audit — as applicable per §3).
3. **It does not block or complicate the modules that come after it.**

This exists specifically to prevent a failure mode already observed once in this program: a module built to work correctly in isolation, but diverging from the ratified blueprint at points that matter (see `ADR-052-grni-policy-impact-analysis-PENDING.md` for a live example of exactly this class of gap, caught before it became a silent divergence). Reaching 100% of the DAII scope means reaching it as one coherent ERP system, not as a large number of screens that do not agree with each other.
