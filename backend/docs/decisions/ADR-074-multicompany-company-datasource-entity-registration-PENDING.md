# ADR-074 — Multi-Company Company DataSource Factory Entity-Registration Gap

**Status: APPROVED — HYBRID B — IMPLEMENTED — REAL-PG VERIFIED — CLOSED
(2026-09-25).** CTO approved Hybrid B (Domain-Owned Company Entity Sets +
Single Aggregated Company Entity Registry, §8.8/§14 below) on the evidence
in §8. Implemented exactly per the approved scope (Steps 1–5, §14).
Verification Gates A–D (§15) all passed with real Postgres evidence — see
§15 for the full closure record. No consumer was fixed individually; the
shared factory's entity registration is fixed once, correctly, per domain
ownership.

## §1 — Finding

`createCompanyDataSource()` (`foundation/database-registry/company-datasource-factory.ts`)
— the factory behind `CompanyConnectionManagerService.getDataSource(companyId)`,
the single production mechanism every Company-scoped connection in this
codebase is obtained through — constructs its `DataSource` with **no
`entities` array**:

```ts
export function createCompanyDataSource(database: DatabaseConfig): DataSource {
  return new DataSource({
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    synchronize: false,
    logging: false,
  });
}
```

Real-Postgres evidence, both executed this session:
- `company-membership-provisioning.real-pg.spec.ts` — `CompanyMembershipProvisioningService.grantMembership`
  fails with `EntityMetadataNotFoundError: No metadata for "Role" was found`
  against a real, fully-provisioned Company database.
- `company-datasource-factory-impact.characterization.spec.ts` — the exact
  production call shape of `AuthorizationService.getRoleKeysForUser(userId,
  manager)` (fed a real `manager` from the real, unmodified factory) throws
  `No metadata for "UserRole" was found`; the exact production call shape
  of `ClosingSnapshotService`'s repository access throws `No metadata for
  "ClosingSnapshotRun" was found`.

This was never caught before because every unit spec that exercises these
call sites mocks the `DataSource`/`manager` entirely
(`company-membership-provisioning.service.spec.ts`,
`authorization.service.spec.ts`'s `poisonedRepo()` helper), and no real
Postgres connection through this specific factory was possible in this
environment until the `CREATEDB` blocker (ADR-073's own prerequisite) was
lifted this session.

## §2 — Current Factory Contract

`createCompanyDataSource(database: DatabaseConfig): DataSource` takes only
connection coordinates (host/port/credentials/database name) and returns
an uninitialized `DataSource`. It has never declared which entities it
serves — there was no "Company entity set" concept before this
investigation. `CompanyConnectionManagerService.getDataSource()`
(`company-connection-manager.service.ts:46-75`) wraps it with connection
caching (one `DataSource` per `companyId`, invalidated on
`updateConnection`) and the `'ACTIVE'`-status refusal (Area 21's
continuous isolation gate) — neither of those wrapper concerns are
affected by this finding; the defect is entirely in what the underlying
`DataSource` itself was constructed to know about.

## §3 — Complete Consumer Inventory

Direct callers of `CompanyConnectionManagerService` found by searching all
of `src/` (excluding module-registration files and the factory/manager's
own files):

| File | Uses `.getDataSource()`? |
|---|---|
| `domains/accounting/application/closing-snapshot-recovery.scheduler.ts` | Yes |
| `domains/sales-orders/application/preliminary-hold-expiry.scheduler.ts` | Yes |
| `foundation/approval-engine/approval-expiry.scheduler.ts` | Yes |
| `foundation/company/company-context.guard.ts` | Yes |
| `foundation/company/company-membership-provisioning.service.ts` | Yes |
| `foundation/company/membership-reconciliation.scheduler.ts` | Yes |
| `foundation/database-provisioning/database-provisioning.service.ts` | **No** — comment references only; uses its own ephemeral `DataSource`s with explicit `entities` |
| `foundation/database-registry/database-registry.service.ts` | **No** — comment reference only |
| `foundation/release/company-baseline-backup.scheduler.ts` | **No** — calls only `listActiveCompanyIds()` (a control-plane-only query), never `.getDataSource()` |

No other consumer found in Treasury, Inventory, or any other domain beyond
what the six real consumers above already reach downstream (Inventory is
reached through `PreliminaryHoldExpiryScheduler`, not independently).

## §4 — Entity Registration Dependency Map + §5 — Proven Impact + §6 — Potential Impact

### Mandatory Consumer Matrix

| Consumer | Call Chain | Repository/Entities | Real-PG Evidence | Status | Area/Track |
|---|---|---|---|---|---|
| `CompanyMembershipProvisioningService.grantMembership` | `getDataSource` → `provisionUserRoleForMembership` → `.getRepository(Role)`/`.getRepository(UserRole)` | `Role`, `UserRole` | Executed — reproduced (`company-membership-provisioning.real-pg.spec.ts`) | **PROVEN BROKEN** | Track A |
| `CompanyMembershipProvisioningService.changeMembershipRole` | same chain, inside `dataSource.transaction(...)` | `Role`, `UserRole` | Executed — reproduced (same spec) | **PROVEN BROKEN** | Track A |
| `MembershipReconciliationScheduler` — `grant`/`role_change` replay | `getDataSource` → `provisionUserRoleForMembership`/transaction | `Role`, `UserRole` | Executed — scheduler logged the identical `EntityMetadataNotFoundError` internally, operation left `FAILED` (same spec) | **PROVEN BROKEN** | Track A |
| `MembershipReconciliationScheduler` — `revoke` replay | `getDataSource` → `deprovisionUserRoleForMembership` → `.getRepository(Role)` (read, before the `.delete()`) | `Role`, `UserRole` | Not independently executed this session | **POTENTIALLY AFFECTED** — identical code path/mechanism to the proven-broken grant case, not itself run | Track A |
| `CompanyContextGuard` → `PermissionGuard` → `AuthorizationService.getRoleKeysForUser` | `getDataSource` → `manager.getRepository(Role)`/`.getRepository(UserRole)` | `Role`, `UserRole` | Executed — real production call shape, real factory (`company-datasource-factory-impact.characterization.spec.ts`) | **PROVEN BROKEN** | Area 5/6 (Company context/authorization boundary), Area 21 (the isolation gate's own enforcement path), Track D (`CompanyBackupController` uses the identical `CompanyContextGuard`+`PermissionGuard` stack) |
| `ClosingSnapshotRecoveryScheduler` → `ClosingSnapshotService.retryPending`/`detectOverdue` | `getDataSource` → `manager.getRepository(ClosingSnapshotRun)`/`.getRepository(FiscalPeriod)`/`.getRepository(FiscalYear)` | `ClosingSnapshotRun` (executed), `FiscalPeriod`/`FiscalYear` (same mechanism, not independently executed) | Executed for `ClosingSnapshotRun` — real production call shape, real factory | **PROVEN BROKEN** | Area 9 (Closing Snapshot recovery) |
| `PreliminaryHoldExpiryScheduler` → `InventoryService.findExpiredPreliminaryHoldOrderIds` | `getDataSource` → raw `.query()` | none | Source-verified (grep confirms raw SQL, no `getRepository`) | **RAW-SQL ONLY** | Area 9, Sales Orders/Inventory |
| `PreliminaryHoldExpiryScheduler` → `SalesOrdersService.expireHoldForOrder` → `ProcessEngineService.transition` | `getDataSource` → `manager.getRepository(ProcessInstance)`/`.getRepository(ProcessTransitionRecord)` | `ProcessInstance`, `ProcessTransitionRecord` | Source-verified only, not executed | **POTENTIALLY AFFECTED** | Area 9, Sales Orders |
| `ApprovalExpiryScheduler` → `ApprovalEngineService.expire` | `getDataSource` → `dataSource.getRepository(ApprovalRequest)` | `ApprovalRequest` | Source-verified only, not executed | **POTENTIALLY AFFECTED** | Approval Engine |
| `DatabaseProvisioningService.provision` | Own ephemeral `DataSource`s (`adminDataSource`, `healthCheckDataSource`), explicit `entities: [Role, UserRole]` already fixed under ADR-073 | n/a — never touches the shared factory | Executed — 4/4 pass (`database-provisioning.service.spec.ts`) | **NOT AFFECTED** | Area 4 |
| `CompanyBaselineBackupScheduler` | `listActiveCompanyIds()` only (control-plane `DatabaseRegistry` query) | n/a | Source-verified | **NOT AFFECTED** | Track D |

## §7 — Existing Architecture / ADR Precedent

No precedent found for a "generic multi-entity Company DataSource"
concept. The codebase's actual precedent runs the opposite direction:
every OTHER ephemeral/purpose-built Company or migration DataSource in
this codebase declares an explicit, narrow `entities` list for exactly
what it needs — `createMigrationDataSource` (no entities; it only ever
runs raw migration files, a genuinely different concern),
`DatabaseProvisioningService`'s `adminDataSource` (`entities: [Role,
UserRole]`, fixed this session under ADR-073), and this investigation's
own setup helpers (`entities: [Role, UserRole]`, `entities:
[ClosingSnapshotRun]`, etc.). `createCompanyDataSource` is the only
Company-connection constructor in the entire codebase that was never
given any entity list at all, despite being the ONE meant for general,
long-lived, multi-domain repository access (it is cached and reused
across requests — `CompanyConnectionManagerService`'s whole cache
mechanism only makes sense for a connection meant to serve many different
callers over time, unlike the one-off ephemeral DataSources elsewhere).

## §8 — Strategy Evaluation

### §8.1 — Entity Universe (extracted from code + existing Company-DB migrations)

Method: every service in `src/` that accepts an optional Company-routing
parameter (`manager?: EntityManager` or, for `ApprovalEngineService`,
`dataSource?: DataSource` — the same pattern, different name) was found by
grep (28 files), then every `.getRepository(Entity)` call inside each was
extracted. This is a static, code-derived universe — "every entity a
service is already built to let a Company connection reach" — not a
dynamic trace of every call in production today. Cross-checked against
`src/database/migrations/` — every table below is confirmed created by a
migration under some tag directory (`core`, `accounting`, `finance`,
`inventory`, `procurement`, `logistics`, `attendance`, `commission`, `hr`,
`payroll`, `targets`; 13 tags total exist).

| Entity | Owning Service | Domain | Migration Tag | Reachable via a real `CompanyConnectionManagerService.getDataSource()` call TODAY? |
|---|---|---|---|---|
| `Role`, `UserRole` | `AuthorizationService` | Foundation/Authorization | `core` | **PROVEN** (§6) |
| `RolePermission` | `PermissionService` | Foundation/Permission | `core` | **PROVEN** (reached via `AuthorizationService`'s same manager) |
| `ClosingSnapshotRun`, `FiscalPeriod`, `FiscalYear`, `ClosingException`, `FinancialEvent` | `ClosingSnapshotService` | Accounting | `accounting` | `ClosingSnapshotRun` **PROVEN** (§6); the other four reached transitively by `assembleAndFinalize`/`assembleBody` from the same scheduler call — **POTENTIALLY AFFECTED**, not independently executed |
| `JournalEntry`, `JournalLine`, `JournalLineDimension` | `JournalEntryService` | Accounting | `accounting` | **POTENTIALLY AFFECTED** — reachable transitively from `ClosingSnapshotService.assembleAndFinalize`'s posting chain, not independently executed |
| `GLAccount` | `LedgerService` | Accounting | `accounting` | **POTENTIALLY AFFECTED** — same transitive chain |
| `CustomerLedgerEntry` | `CustomerLedgerService`/`InvoicesService` | Customer Finance | `finance` | **POTENTIALLY AFFECTED** — `ClosingSnapshotService`'s injected `FINANCE_CUSTOMER_LEDGER_CONTRACT` |
| `SalesInvoice`, `SalesInvoiceLine` | `InvoicesService`/`PaymentsService` | Customer Finance | `finance` | **NOT YET WIRED** — no scheduler/guard currently reaches these via a Company connection |
| `Payment` | `PaymentsService` | Customer Finance | `finance` | **NOT YET WIRED** |
| `InventoryValuationMovement`, `InventoryValuationState` | `MovingAverageCostEngine` (via `InventoryValuationService`) | Inventory Valuation | `inventory` | **NOT YET WIRED** |
| `StockMovement`, `StockReservation`, `Warehouse` | `InventoryService` | Inventory Warehouse | `inventory` | Partially — `findExpiredPreliminaryHoldOrderIds` is **RAW-SQL ONLY**; other methods on the same service reachable via `PreliminaryHoldExpiryScheduler`'s `releasePreliminaryHoldsForOrder` call are **UNVERIFIED** (not traced this session) |
| `PurchaseOrder`, `PurchaseOrderLine`, `Supplier`, `SupplierInvoice`, `SupplierInvoiceLine`, `SupplierLedgerEntry` | `SupplierInvoiceService`/`SupplierLedgerService` | Procurement | `procurement` | **NOT YET WIRED** |
| `ReturnCredit`, `ReturnDisposition`, `ReturnRequest` | `ReturnsService` | Returns | `logistics` | **NOT YET WIRED** |
| `SalesOrder`, `SalesOrderLine` | `SalesOrdersService` | Sales Orders | `logistics` | **POTENTIALLY AFFECTED** — reached via `PreliminaryHoldExpiryScheduler.expireHoldForOrder`, not independently executed |
| `Shipment`, `ShipmentLine`, `ShippingCompany`, `TrackingEvent`, `Vehicle` | `ShipmentService` | Shipment | `logistics` | **NOT YET WIRED** |
| `TreasuryAccount`, `TreasuryAccountType`, `TreasuryTransaction` | `TreasuryService` | Treasury | `finance` | **POTENTIALLY AFFECTED** — `ClosingSnapshotService`'s injected `FINANCE_TREASURY_CONTRACT` |
| `AuditRecord` | `AuditService` | Foundation/Audit | `core` | **POTENTIALLY AFFECTED** — called with `manager` throughout every chain above |
| `EventOutbox` | `EventBusService` | Foundation/Events | `core` | **UNVERIFIED** — not traced this session |
| `LimitProfile`, `LimitUsageCounter` | `LimitService` | Foundation/Limit Engine | `core` | **UNVERIFIED** |
| `NumberingSequence` | `NumberingService` | Foundation/Numbering | `core` | **UNVERIFIED** |
| `ProcessInstance`, `ProcessTransitionRecord` | `ProcessEngineService` | Foundation/Process Engine | `core` | **POTENTIALLY AFFECTED** (§4) — reached via `SalesOrdersService.expireHoldForOrder`, not independently executed |
| `ApprovalRequest` | `ApprovalEngineService` | Foundation/Approval Engine | `core` | **POTENTIALLY AFFECTED** (§4) — source-verified, not independently executed |

**39 entities across every business domain plus 8 foundation cross-cutting
services**, all structurally Company-connection-capable by design (the
`manager?`/`dataSource?` convention is universal across this codebase, not
specific to any one domain). Of these, exactly **3 entities are PROVEN
broken today** (`Role`, `UserRole`, `ClosingSnapshotRun`), roughly a dozen
more are **POTENTIALLY AFFECTED** via a traced but unexecuted call chain,
and the remainder are either genuinely **NOT YET WIRED** to any real
Company connection in production, or **UNVERIFIED** (not traced this
session). This gap between "39 entities structurally capable" and "3
entities actually proven" is itself evidence: the `manager?` convention
was adopted codebase-wide well ahead of any consumer actually needing it
for real, which is exactly why this factory's missing entity list went
unnoticed — almost nothing has exercised it against a real Postgres
connection until this session.

### §8.2 — Strategy Comparison

| Criterion | Strategy A — single hardcoded universal list | Strategy B — domain-specific factories/entity sets | Strategy C — tag/discovery-driven registration |
|---|---|---|---|
| **Model B** | No impact — entity registration is orthogonal to where `User`/`Role`/`UserRole` live | No impact | No impact |
| **Isolation (Area 21)** | No impact — cache key (`companyId`) and `'ACTIVE'`-status refusal unchanged | No impact | No impact |
| **Entity completeness** | **Weakest** — a human must remember to add every new entity from every new domain; §8.1's own 39-entity universe (and it will keep growing) is exactly the shape of list that drifts | **Strong** — each domain's own entity list lives with that domain's own code, reviewed in that domain's own PRs | **Strongest in principle** — automatic if the discovery mechanism is trustworthy; weakest in practice today because that mechanism doesn't exist yet for entities (unlike `discoverMigrationTags`, which walks real files on disk) |
| **Consumers** | Simplest — nothing changes for any of the 6 current or 33 potential future consumers | More per-consumer setup — each new Company-scoped service must register its own entities somewhere | Simplest once built — transparent to consumers, same as A |
| **Migrations** | No migration/schema change | No migration/schema change | No migration/schema change |
| **Runtime** | One cached `DataSource` per Company (matches `CompanyConnectionManagerService`'s existing cache exactly) | Risk of multiple connections/pools per Company if not carefully merged back into one cache — would need the cache keyed differently, a real restructuring | Same as A — one cached `DataSource`, entities resolved once at connection-creation time |
| **Performance** | **Best** — single pooled connection reused by every caller | Potentially worse unless engineered to still share one physical connection | Same as A |
| **Maintainability** | **Worst long-term** — this exact failure mode (hand-maintained list silently drifting) already happened once in this codebase, for migration tags, and was explicitly fixed by moving to discovery (`migration-datasource.ts`'s own 2026-09-15 incident comment) | Better locality, but restructures a shared foundation piece (`CompanyConnectionManagerService`'s cache contract) that Area 9/Track A/Authorization all already depend on | Best long-term IF the discovery mechanism itself is reliable; introduces a new piece of infrastructure that has to be built and trusted |
| **Area 21** | No impact | No impact | No impact |
| **Track D** | No impact (Track D's backup path doesn't use this factory — §10) | No impact | No impact |
| **Portability** | No impact | No impact | No impact |
| **Rollback** | Trivial — purely additive to one file | Moderate — touches the shared cache contract other Areas depend on | Moderate — new mechanism, but additive; nothing existing is removed |

### §8.3 — What the evidence does and does not decide

The evidence clearly rules out one thing: a purely hand-maintained,
never-revisited entity list is the same failure shape this codebase has
already been burned by once, for the structurally identical
problem (migration tags), with an explicit CTO-directed fix on record
(`migration-datasource.ts`'s 2026-09-15 incident comment — "no future
migration/tag drift may pass silently"). A pure Strategy A, implemented
exactly as "hardcode all 39 (and counting) entities today," repeats that
exact incident shape for entities instead of migrations.

The evidence does **not** decide between B and C, or against a hybrid: a
pure Strategy C (file-system discovery, matching `discoverMigrationTags`
mechanically) has no ready mechanism to build from today — TypeORM entity
classes are not walkable from disk by table name the way compiled
migration `.js` files are; some new mapping (tag → entity classes, either
a build-time-generated manifest or an enforced/lint-checked registry)
would have to be designed and built, which this investigation was not
authorized to do. Strategy B's per-domain locality is real but costs a
restructuring of the shared connection cache that Area 9, Track A, and
Authorization all currently depend on working exactly as it does today.

## §8.4 — Impact Map (consolidated)

Already detailed in full in §4 (Mandatory Consumer Matrix) and §9/§10
below (Area 21, Track D). Summary: 3 entities/consumers PROVEN BROKEN
today (Authorization's `Role`/`UserRole`, Closing Snapshot's
`ClosingSnapshotRun`), reaching Area 5/6 (Company context boundary), Area
9 (Closing Snapshot recovery), Area 21 (the isolation gate's own
permission-check mechanism), Track A (membership grant/role-change), and
Track D (the HTTP guard in front of `CompanyBackupController`, not the
backup/restore mechanics themselves). None of the 39-entity universe's
remaining members are proven broken; roughly a dozen are traced-but-
unexecuted (POTENTIALLY AFFECTED), and most are not yet wired to any real
Company connection at all.

## §8.5 — Migration Impact

None, under any of the three strategies. This is exclusively a
TypeScript-level `DataSource` construction concern — which entity classes
an in-process object is told about — not a database schema change. No
migration file needs to change under A, B, or C.

## §8.6 — Test Plan (once a strategy is chosen)

1. Re-run `company-datasource-factory-impact.characterization.spec.ts` —
   both currently-THREW cases must flip to a real result.
2. Re-run `company-membership-provisioning.real-pg.spec.ts` — all 5 tests,
   unblocking Track A's targeted re-verification.
3. For every row marked POTENTIALLY AFFECTED in §8.1/§4: a dedicated
   minimal real-Postgres proof (same shape as the two already executed),
   promoted to PROVEN WORKING or PROVEN BROKEN with its own evidence
   before being called closed — not inferred from the mechanism being
   "the same."
4. Regression: the existing mocked unit specs for every touched consumer
   (`authorization.service.spec.ts`, `permission.service.spec.ts`,
   `closing-snapshot.service.spec.ts`, etc.) must still pass unchanged —
   none of them should need to change, since none of them exercise this
   factory directly.
5. A real `AppModule` boot (the same technique already used for Track D)
   to confirm no circular-dependency or DI-wiring regression from whatever
   the chosen strategy adds to `CompanyConnectionManagerService`/
   `company-datasource-factory.ts` or wherever the fix lands.

## §8.7 — Rollback Plan

Under A or C: revert the entity-list change in
`company-datasource-factory.ts` (or remove the discovery mechanism) — the
factory returns to today's exact behavior (broken for repository access,
working for raw SQL), a clean one-file revert. Under B: reverting is
larger in proportion to how much of `CompanyConnectionManagerService`'s
cache contract was restructured — this is the strategy with the highest
rollback cost, consistent with its higher implementation cost in §8.2.

## §8.8 — Recommended Architecture

Offered only because §8.3 supports a specific, narrow conclusion, not a
full strategy pick: whatever is chosen should **not** be "a list, typed
once, never re-verified" — that specific shape is what this codebase's
own incident history says will drift silently again. Beyond ruling that
out, the evidence does not conclusively favor B over C or a hybrid of the
two; both remain legitimate, both require new engineering work not yet
done, and the choice between them is an architectural judgment call about
how much of `CompanyConnectionManagerService`'s current single-cache
design should change — squarely a CTO decision, not one this evidence
resolves on its own.

## §9 — Area 21 / Isolation Impact

Area 21's continuous isolation gate is about WHICH Company's database a
request reaches — never-ambient-fallback, `'ACTIVE'`-status enforcement,
client-`companyId` never trusted directly. None of that is affected;
`CompanyConnectionManagerService`'s isolation guarantees (cache-keyed by
validated `companyId`, refusal of a non-`'ACTIVE'` registry) are fully
intact and unrelated to this finding. What IS now proven affected: once a
request correctly reaches the right Company's connection, the
authorization CHECK itself (`PermissionGuard`/`AuthorizationService`) that
Area 21's own inventory work depends on functioning cannot currently
resolve entity metadata on that connection. This is a "the gate opens
correctly but what's behind it cannot answer a permission question"
finding, not an isolation-boundary breach.

## §10 — Track D / Portability / Backup Impact

`CompanyBackupController` (Track D, Step 10 self-service path) is gated
by the identical `@UseGuards(JwtAuthGuard, CompanyContextGuard,
PermissionGuard)` + `@RequirePermission(COMPANY_BACKUP_MANAGE_NODE,
'editable')` stack proven broken in §6. `BackupManagerService`/
`RestoreManagerService` themselves never call
`CompanyConnectionManagerService.getDataSource()` — they resolve their
own connection via `DatabaseRegistryService.getConnectionConfigForCompany`
(ADR the Backup/DR track's own Step 5 decision) — so the backup/restore
MECHANICS are not directly affected. The HTTP GATE in front of the
self-service Company backup endpoints is.

## §11 — CTO Decision (2026-09-25)

**APPROVED: Hybrid B — Domain-Owned Entity Sets + Single Aggregated
Company Entity Registry.** Not Strategy A as a hand-typed 39-entity list
(ruled out, §8.3). Not Strategy C as filesystem/runtime discovery (no
mechanism exists for TypeORM entities the way `discoverMigrationTags`
walks real migration files). Each domain owns and reviews its own
`*-company-entities.ts` manifest, alongside its own code; a single
aggregator (`company-entity-registry.ts`) assembles them; exactly one
cached `DataSource` per Company, unchanged from
`CompanyConnectionManagerService`'s existing contract — no per-domain
DataSources, no cache restructuring.

## §12 — Implementation Scope (as approved, Steps 1–5)

1. Domain-owned Company entity manifests — one file per domain that has a
   Company-connection-capable service.
2. Aggregated `COMPANY_ENTITY_REGISTRY`.
3. `createCompanyDataSource()` — minimal change, `entities: COMPANY_ENTITY_REGISTRY`.
4. Untouched, exactly as directed: `CompanyConnectionManagerService`'s
   cache contract, `companyId` routing, Membership model, Model B,
   migrations, Area 16, Area 21 isolation semantics, Track D backup
   mechanics.
5. A guard test proving the registry cannot silently fall behind a
   Company-scoped entity a service starts using.

## §13 — Implementation (files)

- `domains/accounting/accounting-company-entities.ts` — `ClosingSnapshotRun`, `FiscalPeriod`, `FiscalYear`, `ClosingException`, `FinancialEvent`, `JournalEntry`, `JournalLine`, `JournalLineDimension`, `GLAccount`
- `domains/customer-finance/customer-finance-company-entities.ts` — `CustomerLedgerEntry`, `SalesInvoice`, `SalesInvoiceLine`, `Payment`
- `domains/treasury/treasury-company-entities.ts` — `TreasuryAccount`, `TreasuryAccountType`, `TreasuryTransaction`
- `domains/inventory-valuation/inventory-valuation-company-entities.ts` — `InventoryValuationMovement`, `InventoryValuationState`
- `domains/inventory-warehouse/inventory-warehouse-company-entities.ts` — `StockMovement`, `StockReservation`, `Warehouse`
- `domains/procurement/procurement-company-entities.ts` — `PurchaseOrder`, `PurchaseOrderLine`, `Supplier`, `SupplierInvoice`, `SupplierInvoiceLine`, `SupplierLedgerEntry`
- `domains/sales-orders/sales-orders-company-entities.ts` — `SalesOrder`, `SalesOrderLine`
- `domains/shipment/shipment-company-entities.ts` — `Shipment`, `ShipmentLine`, `ShippingCompany`, `TrackingEvent`, `Vehicle`
- `domains/returns/returns-company-entities.ts` — `ReturnCredit`, `ReturnDisposition`, `ReturnRequest`
- `foundation/company/core-company-entities.ts` — `Role`, `UserRole`, `RolePermission`, `AuditRecord`, `EventOutbox`, `LimitProfile`, `LimitUsageCounter`, `NumberingSequence`, `ProcessInstance`, `ProcessTransitionRecord`, `ApprovalRequest`, `ApprovalRequestType`, `ApprovalMatrixRule`, `ApprovalDecision` — the last three found ONLY by the completeness guard test (§14), missed by the original manual §8.1 audit, proving the guard's own value immediately
- `foundation/database-registry/company-entity-registry.ts` — the aggregator
- `foundation/database-registry/company-datasource-factory.ts` — `entities: COMPANY_ENTITY_REGISTRY` added, nothing else changed

## §14 — Completeness Guard (Step 5)

`company-entity-registry.completeness.spec.ts` — not a second
hand-maintained list. Walks the real `src/` tree at test time, finds every
file matching this codebase's own established Company-routing convention
(`manager?: EntityManager` / `dataSource?: DataSource`), extracts every
`.getRepository(Entity)` call inside, and asserts each entity is present
in `COMPANY_ENTITY_REGISTRY`. On first run it caught `ApprovalRequestType`,
`ApprovalMatrixRule`, `ApprovalDecision` — three entities the manual §8.1
audit missed. Added to `core-company-entities.ts`; guard now passes. Also
asserts no entity is registered by two domains.

## §15 — Verification Gates A–D (all real Postgres, all independently executed)

**Gate A — existing proven failures, now fixed:**
- `company-datasource-factory-impact.characterization.spec.ts` — Authorization chain: `RETURNED: ["admin"]` (was `THREW`). Closing Snapshot chain: `RAN OK` (was `THREW`).
- `company-membership-provisioning.real-pg.spec.ts` — 5/5 pass: `grantMembership`, negative-integrity proof, `changeMembershipRole`, reconciliation `grant` replay, reconciliation `role_change` replay.

**Gate B — every POTENTIALLY AFFECTED row, independently proven, none promoted by inference:** 9 grouped proofs added to the same characterization spec (`it.each`), each opening the real production factory and calling `.getRepository()` for that row's own entities — Closing Snapshot deep chain (`FiscalPeriod`/`FiscalYear`/`ClosingException`/`FinancialEvent`), Journal, Ledger, Customer Finance, Treasury, Audit, Sales Orders, Process Engine, Approval Engine. **11/11 tests pass** (2 Gate A + 9 Gate B) in that file.

**Gate C — app integrity:**
- Full regression across `database-registry`, `company`, `release`, `database-provisioning`, `release-orchestration`, `authorization`, `permission`, `approval-engine`: **51/51 suites, 347/347 tests pass.**
- Real `AppModule` boot against Postgres (`closing-snapshot-recovery.spec.ts`): **4/4 pass** — no circular-dependency or DI-wiring regression from the new registry/manifest files.
- One genuine regression found and fixed during this gate: `database-provisioning.service.unit.spec.ts`'s shared mocked `DataSource` had no `.query()`, which ADR-073's `applyCompanyAuthorizationSchemaAdjustment` needs — added `dsQueryMock`. Not related to ADR-074's own change; a latent gap from ADR-073 that Gate C's regression pass caught as intended.

**Gate D — Area 21, unaffected:**
`company-datasource-registry-isolation.spec.ts` — two real, separately-provisioned Company databases, each with a distinct grant. **3/3 pass**: Company A's connection resolves Company A's grant and returns `[]` for a user that only exists in Company B (and vice versa); `CompanyConnectionManagerService` returns genuinely distinct `DataSource` objects per Company, with the cache contract unchanged (re-requesting the same Company returns the identical cached instance).

All four gates: zero residual test databases after every run, verified directly against `pg_database` each time.

## §16 — Closure

Area 4/ADR-073: unchanged, VERIFIED. Area 16: unchanged, CLOSED. Track A:
`grantMembership`/`changeMembershipRole`/reconciliation `grant`/`role_change`
Real-PG verification is now UNBLOCKED and PASSING (Gate A) — Track A's
targeted re-verification is complete. Area 21: Gate D confirms no
isolation-model change. Track D: backup/restore mechanics untouched (§10);
the HTTP guard proven broken in §6 is now proven fixed (Gate A's
Authorization chain result feeds the identical `PermissionGuard` path
`CompanyBackupController` uses).

**ADR-074 = APPROVED — IMPLEMENTED — REAL-PG VERIFIED — CLOSED.**
