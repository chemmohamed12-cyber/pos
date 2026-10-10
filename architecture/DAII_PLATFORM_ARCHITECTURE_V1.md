# Daii Platform Architecture V1

Status: **DRAFT — Stage 1 Planning.** Not yet formally accepted. No implementation depends on this document until it is.
Evidence base: `Daii/_source-audits/` (baseline, RMS Step 30, XNEXUS Website / QR Platform — all COMPLETED, do not re-audit).
Related: [`DAII_PLATFORM_FOUNDATION_CONTRACT.md`](DAII_PLATFORM_FOUNDATION_CONTRACT.md) · [`DAII_DOMAIN_BOUNDARIES.md`](DAII_DOMAIN_BOUNDARIES.md) · [`extraction/DAII_SOURCE_EXTRACTION_MATRIX.md`](extraction/DAII_SOURCE_EXTRACTION_MATRIX.md) · [`decisions/`](decisions/)

---

## 1. Core Architecture Principle

Daii is **not** based directly on any one of the three source repositories. Each contributes selectively:

| Source | Contributes |
|---|---|
| `baseline/` (XNEXUS Wireless Hospitality Calling System) | Selected business-engine **concepts**: generic approval workflow (Process Engine), movement-based inventory ledger, organization hierarchy, numbering, notification dispatch, generic task/execution lifecycle. |
| `30/` (XNEXUS RMS Step 30) | Architecture/governance **patterns** and selected kernel concepts: hash-chain audit log, event-bus interface shape, generator/structure-validator tooling, mechanically-enforced module boundaries, "disclose don't silently resolve" documentation discipline. Confirmed NOT a source of business logic (Business Modules are empty, POS-domain-shaped) or of production auth (self-labeled stub). |
| `xnexus-website/` (QR Platform) | Selected **Delivery/Fulfillment**, **Geography**, **Permission/Limit**, **i18n**, and **mobile architecture** patterns — the highest-value source overall, and the most production-hardened. |

Daii then rebuilds the platform around **its own** domain model, security model, and persistence model. No source's authentication, authorization, or JSON-file persistence approach is carried forward as-is — all three were found materially insufficient for Daii's requirements (see [`DAII_SECURITY_ARCHITECTURE.md`](DAII_SECURITY_ARCHITECTURE.md) §1 and [`DAII_DATA_ARCHITECTURE.md`](DAII_DATA_ARCHITECTURE.md) §1).

## 2. Target Architecture — Validated

```
                    DAII PLATFORM
                         |
              +----------+----------+
              |   PLATFORM CORE     |   <- see DAII_PLATFORM_FOUNDATION_CONTRACT.md
              |                     |
              | Identity            |
              | Authentication      |
              | Authorization       |
              | Permission          |
              | Scope               |
              | Limit               |
              | Organization        |
              | Configuration       |
              | Audit               |
              | Events              |
              | Notifications       |
              | Numbering           |
              | Terminology         |
              | Localization        |
              +----------+----------+
                         |
        +----------------+----------------+
        |                |                |
    Commerce           CRM              Sales
        |                |                |
    Products         Customers        Sales Reps
    Catalog          Addresses        Teams
    SKU              Assignment       Territories
        |                |                |
        +----------------+----------------+
                         |
                    SALES ORDERS
                         |
             +-----------+-----------+
             |                       |
        Approval Flow          Deposit Control
             |                       |
             +-----------+-----------+
                         |
                      INVENTORY
                         |
          +--------------+--------------+
          |              |              |
      Warehouses      Reserve        Transfer
          |              |              |
          +--------------+--------------+
                         |
                    FULFILLMENT
                         |
                      Pick / Pack
                         |
                     SHIPMENT
                         |
                  Waybill / Tracking
                         |
                      DELIVERY
                         |
                Delivered / Returned
```

This diagram from the CTO directive is treated as a **target concept**, validated below component-by-component against Stage 0 evidence — not assumed pre-approved.

## 3. Component Validation

| Component | Verdict | Basis |
|---|---|---|
| Identity / Authentication | **Refined, not adopted from any source.** No source has production-grade auth (see ADR-004). Daii builds one centralized service. | All 3 audits |
| Authorization / Permission | **Refined.** QR Platform's Permission Engine pattern is validated as the structural reference (hierarchical, deny-by-default, ancestor-walk) but must add a per-user-role dimension it currently lacks (tenant-only today). | QR Platform audit §2, §3.1 |
| Scope | **Validated as a distinct concept, no direct source.** Confirmed as a real gap across all three sources — must be built fresh, informed by `baseline`'s scattered manager-scope-resolution logic and QR Platform's permission-node ancestry pattern. | All 3 audits |
| Limit | **Validated, near-direct reuse of pattern.** QR Platform's Limit Engine (fail-open numeric quota, cleanly separated from Permission's fail-closed) is a strong match. | QR Platform audit §2 (limit-engine.js) |
| Organization | **Validated, reuse+harden.** `baseline`'s Company→Branch→Department→Team→Warehouse hierarchy matches directly; single-company hardcode must be relaxed. | Baseline audit §3 candidate 6 |
| Configuration | **Validated, direct reuse of pattern.** `baseline`'s generic value-list store is a clean fit. | Baseline audit table |
| Audit | **Validated, reuse+harden.** RMS's SHA-256 hash-chain is the strongest audit primitive found; needs real persistence. | RMS audit §3 |
| Events | **Validated as interface, rebuild implementation.** RMS's event-bus interface contract is sound; its in-memory implementation is an explicit placeholder. | RMS audit §3 |
| Notifications | **Validated, reuse+harden.** `baseline`'s multi-channel dispatcher is production-proven. | Baseline audit §3 candidate 5 |
| Numbering | **Validated concept, hardening mandatory.** `baseline`'s numbering engine has a confirmed production defect (TD-29, silent desync after restore) — must be redesigned as DB-transactional, not ported verbatim. | Baseline audit §3 candidate 7, §5.5 |
| Terminology / Localization | **Validated principle, no direct source.** QR Platform proves the RTL/default-Arabic mechanics work end-to-end, but explicitly does *not* have a canonical-code Terminology Registry — must be built new. | QR Platform audit §6 |
| Commerce / Catalog | **Refined.** Only a pluggable-configuration abstraction pattern is reusable (QR Platform's product-engine); the plugins themselves are restaurant/store-specific and rejected. | QR Platform audit §2 |
| CRM / Customers | **Rebuild.** No source's customer record is rich enough (assignment history, territory, classification, pricing profile). | QR Platform audit §2 (business-customer-repository) |
| Sales / Sales Reps | **Refined.** Mobile-as-thin-client pattern validated from two independent sources converging on the same shape; auth and hierarchy logic rebuilt. | Baseline + QR Platform audits |
| Sales Orders — Approval Flow | **Validated, strong reuse of pattern.** `baseline`'s Process Engine is the single best asset found across all audits — generic, stateless, near-zero coupling. | Baseline audit §3 candidate 1 |
| Sales Orders — Deposit Control | **Rebuild.** No direct analog in any source; QR Platform's payment-permission-node pattern is a partial reference only. | QR Platform audit §2 (payment-engine.js) |
| Inventory — Ledger | **Validated, strong reuse of pattern.** `baseline`'s movement-based ledger matches blueprint §17–18 almost exactly; needs a warehouse/location dimension added. | Baseline audit §3 candidate 2 |
| Inventory — Reserve/Transfer | **Refined.** Concept only from `baseline`'s asset-engine (wrong granularity — per-serial, not per-SKU); rebuild against quantity-based stock. | Baseline audit table (asset-engine.js) |
| Fulfillment — Pick/Pack | **Validated, reuse+harden.** `baseline`'s work-engine/execution-engine generic task lifecycle fits directly. | Baseline audit §3 candidate 3 |
| Fulfillment — Dispatch/Offer/Assignment | **Validated, strongest single reuse target in the entire discovery.** QR Platform's Delivery Dispatch domain is a near-direct structural match. | QR Platform audit §3.2 |
| Shipment / Waybill / Tracking | **Validated, strong reuse of pattern.** QR Platform's delivery-execution-engine state machine and driver-location engine map almost directly. | QR Platform audit §2, §3.2 |
| Delivery / Returns | **Delivery refined (reuse pattern); Returns rebuilt (no analog found anywhere).** | QR Platform + Discovery synthesis |

## 4. What Is Explicitly Rejected From All Sources

- JSON-file persistence as a production model (see [`DAII_DATA_ARCHITECTURE.md`](DAII_DATA_ARCHITECTURE.md))
- Any source's authentication implementation, as-is (see [`DAII_SECURITY_ARCHITECTURE.md`](DAII_SECURITY_ARCHITECTURE.md))
- Per-engine hardcoded role-array authorization (`baseline` pattern)
- Duplicated per-actor-type auth engines (`xnexus-website` pattern — CMS/Driver/Consumer/Business Customer each reimplement HMAC auth)
- Hardcoded development-secret fallbacks (found in both `baseline` and `xnexus-website`)
- Manufacturing/BOM/Assembly/QC/serialized-asset domain content (`baseline` — explicitly out of scope per blueprint §49)
- Marketing-site CMS/Discovery/Studio content (`xnexus-website` — no B2B operational analog)
- Offline-desktop-terminal kernel modules (`30/` — hardware, device-identity, local-database, sync-queue, update-framework; no analog in a hosted web/mobile platform)
- Per-installation software licensing (`30/license-context`, `platform-protection`'s license logic)

## 5. Document Map

| Document | Covers |
|---|---|
| [`DAII_PLATFORM_FOUNDATION_CONTRACT.md`](DAII_PLATFORM_FOUNDATION_CONTRACT.md) | The 20 Platform Core capabilities, contract-by-contract |
| [`DAII_DOMAIN_BOUNDARIES.md`](DAII_DOMAIN_BOUNDARIES.md) | The 12 Business Domains, ownership and non-leakage rules |
| [`DAII_SECURITY_ARCHITECTURE.md`](DAII_SECURITY_ARCHITECTURE.md) | Identity/Auth/Permission/Scope model in full |
| [`DAII_DATA_ARCHITECTURE.md`](DAII_DATA_ARCHITECTURE.md) | Persistence, transactions, concurrency |
| [`DAII_API_ARCHITECTURE.md`](DAII_API_ARCHITECTURE.md) | API conventions, contract ownership, versioning |
| [`DAII_EVENT_ARCHITECTURE.md`](DAII_EVENT_ARCHITECTURE.md) | Events, audit, outbox, background processing |
| [`DAII_I18N_TERMINOLOGY_ARCHITECTURE.md`](DAII_I18N_TERMINOLOGY_ARCHITECTURE.md) | Terminology Registry, RTL/LTR |
| [`DAII_MOBILE_ARCHITECTURE.md`](DAII_MOBILE_ARCHITECTURE.md) | Sales Rep Mobile App architecture |
| [`extraction/DAII_SOURCE_EXTRACTION_MATRIX.md`](extraction/DAII_SOURCE_EXTRACTION_MATRIX.md) | Full engine-by-engine extraction matrix |
| [`decisions/`](decisions/) | ADR-001 through ADR-014 |
| `../planning/stage-1/` | Stack decision, risk register, implementation readiness |
