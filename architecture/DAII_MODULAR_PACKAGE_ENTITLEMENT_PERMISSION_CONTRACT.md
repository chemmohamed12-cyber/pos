# CTO Directive — DAII Modular, Package, Entitlement & Permission Master Architecture Contract

**Status:** ACCEPTED — binding reference for every subsequent phase, ranked above per-module ADRs.
**Date:** 2026-09-18
**Referenced by:** `release-new/backend/docs/decisions/ADR-055-modular-package-entitlement-permission-contract.md`
**Parent:** `DAII_ERP_LONG_TERM_COMPLETION_CHARTER.md` (ADR-053)

## Purpose

GRNI (`ADR-054`) is an accounting-policy decision scoped to Procurement. This
contract governs something that outranks it in scope and durability: **how
DAII is packaged, sold, entitled, and permissioned as it grows toward HR,
Payroll, Manufacturing, and beyond.**

If this is ratified only after those modules are built, the team will most
likely have to re-audit every one of them for compliance. Ratifying it now,
before that build-out continues, is the entire point.

## Position in the Governance Hierarchy

```
DAII ERP Long-Term Charter  (ADR-053)
          │
          ▼
Platform Architecture Governance   (this contract, ADR-055)
          │
 ┌────────┼─────────┐
 ▼        ▼         ▼
Modules  Packages  Permissions
 │        │         │
 ▼        ▼         ▼
Features Entitlements Roles/Users
          │
          ▼
      Runtime Control
          │
          ▼
      Audit / Security
```

Every per-module ADR (accounting policy, HR design, Payroll design,
Manufacturing design, and so on) must comply with this contract. Where a
conflict is found between an existing ADR and this contract, it is escalated
per §10 below — never resolved silently in either direction.

## The Golden Rule

> Everything built in DAII from now until the ERP is complete must be
> **modular, entitlement-aware, permission-aware, dependency-aware**, and
> **capable of being activated or deactivated without breaking the Core or
> destroying historical data.**

---

## 1. DAII Is Composed of Small Bounded Modules

No new capability is built as "a large part of the system." Every capability
is its own **Module** with an explicit surface:

- Backend capability
- Frontend screens/routes
- Database/migrations
- Permissions
- Configuration
- Audit
- Dependencies
- Entitlements
- Tests

**A module must never be wired in such a way that removing it from a given
edition breaks the Core or another module.** This is the same discipline the
existing module manifests (`sales`, `inventory`, `logistics`, `finance`,
`reporting`, `hr`, `accounting`, `procurement`) already establish — this
contract makes it explicit and binding for every module still to come.

---

## 2. Module Entitlement Is Independent of User Permission

These are two different questions and must never collapse into one:

- **Does the customer own this module?** → **Entitlement** (Package/Edition
  level).
- **Is this specific user allowed to use it?** → **Permission** (Role/User
  level).

Example: a company licenses Accounting, Inventory, Procurement, and HR — but
its CFO only sees Accounting, its warehouse staff only see Inventory, its
buyers only see Procurement. Entitlement determines *what exists* for that
installation; permission determines *who, among the people at an
entitled installation, may use what exists.*

Neither substitutes for the other. An entitled-but-unpermitted user sees
nothing; a permitted-but-unentitled installation has nothing to grant
permission to in the first place.

---

## 3. The Package Builds the Customer's Edition

This is the direct architectural expression of the Package Builder concept.
Before a sale, the module tree for that customer's edition is composed, for
example:

```
DAII Package
│
├── Accounting
│   ├── GL
│   ├── AR
│   ├── AP
│   ├── Treasury
│   └── Month-End
│
├── Inventory
│   ├── Warehouse
│   ├── Stock
│   └── Valuation
│
├── Procurement
│   ├── Suppliers
│   ├── Purchasing
│   ├── GRNI
│   └── Supplier Finance
│
└── HR
    ├── Employees
    ├── Departments
    └── ...
```

The Package Builder decides what is *in* an edition. **Hiding a menu item is
not entitlement.** An edition without Procurement must have no Procurement
surface at any layer, not merely no Procurement link in the sidebar.

---

## 4. Entitlement Is Enforced at Backend AND Frontend — Non-Negotiable

If a customer does not own Procurement:

- The UI does not show it.
- The routes do not exist for them.
- The API cannot be called directly to reach it.
- The data cannot be reached.
- No command relating to the module can execute.

**UI visibility is not a security boundary. The backend is the final
authority.** This is the same architectural principle `RequireModuleGuard`
already implements for the modules that exist today (checked *before*
`PermissionGuard`, returning a 404 rather than a 403 — anti-enumeration, not
just access denial) — this contract makes explicit that every future module
must be gated the same way, with no exceptions carved out for convenience.

---

## 5. Every Module Must Be Controllable at Runtime

Every module must have a clear state, for example:

- `AVAILABLE`
- `ENABLED`
- `DISABLED`

The long-term target is a **Module / Capability Registry** that knows, per
installation:

- Module ID
- Version
- Dependencies
- Entitlement key
- Permissions
- Configuration
- Migration requirements
- Status

So the platform can answer questions like: *this edition has Procurement but
GRNI is not enabled*, or *this edition has Accounting without Manufacturing*,
or *this edition has HR without Payroll* — as data, not as something
inferred from which routes happen to 404.

---

## 6. Permissions Must Be Fine-Grained From the Start

Not:

```
can_view_procurement
```

But:

```
procurement.supplier.view
procurement.supplier.create
procurement.supplier.edit
procurement.supplier.approve
purchase_order.view
purchase_order.create
purchase_order.approve
purchase_order.cancel
goods_receipt.view
goods_receipt.create
goods_receipt.post
goods_receipt.reverse
supplier_invoice.view
supplier_invoice.create
supplier_invoice.post
supplier_payment.view
supplier_payment.create
supplier_payment.approve
```

Then: `Role → Permissions`, and `User → Roles / Overrides`, with the
existing Maker/Checker discipline preserved on every sensitive operation —
exactly the pattern the current permission-node hierarchy (`accounting.*`,
`hr.*`, and now `procurement.*`) already follows. This contract requires that
every future module (Payroll, Manufacturing, and beyond) is designed this
way from its first permission node, not retrofitted later.

---

## 7. No Module May Depend on an Optional Module Without a Declared Contract

If Procurement needs Inventory, that dependency must be declared:

```
Procurement → Inventory → Accounting
```

But code inside Accounting must never assume Manufacturing exists. Instead:

```
Module A
   ↓
Contract
   ↓
Module B
```

This is precisely the discipline `accounting.manifest.ts`'s own
`depends_on: ['finance']` entry already documents as an *entitlement*
dependency, not a code-import dependency — this contract generalizes that
distinction to every module boundary going forward. It must remain possible
to sell `Accounting + Inventory` without `Manufacturing` and have the system
run correctly, not degrade.

---

## 8. Adding and Removing Modules Must Have a Formal Lifecycle

**Adding a module:**

```
Package/Entitlement
→ Dependency Check
→ Migration
→ Enable
→ Permissions
→ Configuration
→ Verification
```

**Removing/disabling a module does not mean deleting its historical data.**
If a customer disables Procurement:

```
Procurement = Disabled
```

But its Purchase Orders, Goods Receipts, Supplier Invoices, GRNI history,
audit trail, and posted accounting entries are **not deleted** — that data is
now part of the installation's permanent accounting and operational history,
and must remain queryable (at minimum for audit/reporting/historical
reconciliation) even while the module surface that created it is switched
off.

---

## 9. No New Screen, API, or Feature Ships Without an Entitlement + Permission Design

From this contract forward, the Definition of Done for any new capability is
never:

> "The screen works."

It is:

> **Module + Entitlement + Permission + Dependency + Audit + Configuration +
> Integration + Tests.**

This applies to every future wave without exception: HR → Payroll →
Manufacturing → MRP → Advanced Tax → Multi-Company → Consolidation → BI —
not only Procurement. It composes directly with `ADR-053 §18`'s three-proof
bar for "module complete": a module cannot be ERP-integrated (proof 2) if its
entitlement and permission design is missing, since entitlement/permission
boundaries are themselves part of the Core it must integrate with.

---

## 10. Escalation

This contract's own escalation rule mirrors `ADR-053 §16`: the team resolves
ordinary implementation decisions within this contract without pausing for
sign-off. Escalation to the CTO is required only when:

- a proposed module's dependency structure cannot be expressed as a declared
  contract without a hard code-level coupling to another optional module;
- an entitlement/permission design conflicts with an existing ratified ADR;
- a security or data-retention question arises that this contract does not
  already answer (e.g. a jurisdiction-specific data-deletion requirement that
  would conflict with §8's "disabled ≠ deleted" rule);
- a module cannot be given a clean `AVAILABLE/ENABLED/DISABLED` lifecycle
  without a breaking change to the Core.

When no such conflict exists: **resolve → implement → test → PASS →
continue.**

## Consequences

- Every future module's implementation contract must include an explicit
  Entitlement section and a Permission-node table before implementation
  begins — not added retroactively.
- The Module/Capability Registry described in §5 does not yet exist as a
  concrete system component; its design and build is a required, near-term
  follow-up, not a someday aspiration — it is what makes §2, §4, §5, and §8
  independently verifiable rather than merely policy.
- Existing modules (`sales`, `inventory`, `logistics`, `finance`,
  `reporting`, `hr`, `accounting`, `procurement`) are not required to be
  retrofitted immediately, but any of them touched by future work must be
  brought into compliance with this contract as part of that work, not left
  as a permanent exception.
- HR, Payroll, and Manufacturing design work must not proceed past its
  architecture-contract stage (`ADR-053 §9`/§13) without demonstrating
  compliance with this contract's §1–§9.
