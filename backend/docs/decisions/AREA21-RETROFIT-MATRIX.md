# Area 21 — Retrofit Matrix (2026-09-25)

**Status: MATRIX COMPLETE — RETROFIT NOT YET IMPLEMENTED.** Per CTO
authorization: "ليس كودًا جديدًا... يحتاج CTO authorization صريحًا للـ
Area 21 Retrofit" — this document is the required Matrix + scope
confirmation before any code. No controller, service, or entity has been
modified. All 60 controllers re-enumerated directly from source (not
assumed from memory) — count matches the CTO's own characterization
exactly (46 / 9 / 5), confirming this is the same universe, independently
re-derived.

## §0 — Full 60-Controller Classification (VERIFIED — re-derived from source)

**9 Platform-scoped (no retrofit — legitimately Installation/global-wide):**
`auth.controller.ts`, `configuration.controller.ts`, `entitlement.controller.ts`,
`limit.controller.ts`, `organization.controller.ts`, `release.controller.ts`
(its Company-specific routes already use the approved Installation-Admin
dual-path pattern), `navigation.controller.ts`, `terminology.controller.ts`,
`health.controller.ts`.

**3 already-resolved Company-scoped (2 compliant + 1 exception):**
- Compliant: `company-membership.controller.ts` (Track A), `company-backup.controller.ts` (Track D)
- Exception (by design, not a gap): `installation-membership.controller.ts` — trusts a route-supplied `companyId` only because platform-`admin`-role gating (`RolesGuard`) makes that legitimate, the same pattern this Matrix's own retrofit will reuse for each domain's Installation-Admin path.
- *(Area 14's `company-audit.controller.ts`, built after the original characterization, is now a 4th compliant surface — noted for completeness, not part of the original 46 count.)*

**5 Mixed/Special (individual resolution required — §2):**
`integration-order-intake.controller.ts`, `approval.controller.ts`,
`admin.controller.ts` (specifically `GET /admin/sales-reps` only — the
rest of that controller is legitimately Platform-scoped), `integrations.controller.ts`,
`media.controller.ts`.

**43 Company-scoped, retrofit required (§1):** every remaining domain
business controller — full list in §1's table.

## §1 — The 43: Uniform Finding + Two-Tier Retrofit Cost

### §1.1 — What is true for ALL 43 (VERIFIED, not assumed)

- **Zero of 119 domain entity files anywhere in `src/domains/` have a
  `companyId` column** (`grep -rl companyId src/domains/*/infrastructure/*.entity.ts` →
  no matches). Company isolation for these 43 must come from **connection
  routing** (Model B — a Company's own database), never a `WHERE companyId = ?`
  discriminator on a shared table. This directly matches the CTO's own
  point 4: retrofit is not `where: { companyId }`.
- All 43 currently use only `JwtAuthGuard` + `PermissionGuard` (a few also
  `RolesGuard` for specific routes) — **no `CompanyContextGuard` anywhere**,
  confirmed by grep across every file.
- All 43 inject services that use the standard NestJS `@InjectRepository`
  pattern bound to the ambient/Platform `DataSource` — there is no
  "Company DB access" today; every read/write for these 43 controllers
  currently executes against the Platform database, regardless of which
  Company the data conceptually belongs to.
- Current authorization = authentication + role/permission only.
  `req.user.companyId` (present on the JWT since Area 5) is never read by
  any of these 43 controllers or their services.

### §1.2 — Retrofit cost tiering (VERIFIED per-service, not estimated)

Every service injected by all 43 controllers was checked directly for the
established `manager?: EntityManager` / `dataSource?: DataSource`
Company-routing convention (the same one ADR-074 audited and proved works
end-to-end). Two tiers result:

**Tier 1 — underlying service(s) already manager-capable (13 controllers).**
Lower retrofit cost: add `CompanyContextGuard`, thread
`req.companyContext.dataSource.manager` into the existing service calls.
No service-layer surgery needed for the manager-capable service(s) listed;
any co-injected NOT-yet-capable service in the same controller still
needs Tier-2-style work.

| Controller | Route | Services (✓ = already `manager?`-capable) |
|---|---|---|
| `general-ledger.controller.ts` | `accounting` | `JournalEntryService`✓, `LedgerService`✓, `ExcelService`✗, `FinancialEventService`✗, `FinancialReportingService`✗ |
| `customer-ledger.controller.ts` | `customer-finance` | `CustomerLedgerService`✓ (fully capable) |
| `invoices.controller.ts` | (per-method, no class prefix) | `InvoiceService`✓ (fully capable) |
| `payments.controller.ts` | (per-method, no class prefix) | `PaymentsService`✓, `EventBusService`✓, `IdempotencyService`✗ |
| `inventory-valuation.controller.ts` | `inventory/valuation` | `InventoryValuationService`✓ (fully capable) |
| `inventory.controller.ts` | `inventory` | `InventoryService`✓, `ExcelService`✗ |
| `supplier-invoice.controller.ts` | `procurement/supplier-invoices` | `SupplierInvoiceService`✓ (fully capable) |
| `supplier.controller.ts` | `procurement/suppliers` | `SupplierLedgerService`✓, `SupplierService`✗ |
| `returns.controller.ts` | `returns` | `ReturnsService`✓ (fully capable) |
| `sales-orders.controller.ts` | `sales-orders` | `SalesOrdersService`✓ (fully capable) |
| `shipment.controller.ts` | `shipments` | `ShipmentService`✓ (fully capable) |
| `treasury.controller.ts` | `treasury` | `TreasuryService`✓, `IdempotencyService`✗ |
| `accounting.controller.ts` | `accounting` | `ClosingSnapshotService`✓ (per ADR-074), `PermissionService`✓, `ClosingExceptionService`✗, `CurrencyService`✗, `FinancialDimensionService`✗, `FiscalPeriodService`✗, `GLAccountService`✗, `TaxCodeService`✗, `TaxPeriodService`✗ |

**Tier 2 — zero manager-capable services, full service-layer work needed first (30 controllers).**

| Controller | Route | Service(s), none yet manager-capable |
|---|---|---|
| `ap.controller.ts` | `accounting/ap` | `ApAdjustmentService`, `ApReconciliationService` |
| `ar.controller.ts` | `accounting/ar` | `ArAdjustmentService`, `ArReconciliationService` |
| `cash-bank.controller.ts` | `accounting/cash-bank` | `CashBankAdjustmentService`, `CashBankReconciliationService` |
| `fixed-asset.controller.ts` | `accounting` | `FixedAssetService`, `DepreciationService`, `FixedAssetDisposalService`, `FixedAssetReconciliationService` |
| `grni.controller.ts` | `accounting/grni` | `GrniReconciliationService` |
| `inventory-accounting.controller.ts` | `accounting/inventory` | `InventoryAdjustmentService`, `InventoryReconciliationService` |
| `wip.controller.ts` | `accounting/wip` | `WipReconciliationService` |
| `attendance.controller.ts` | `attendance` | `AttendanceService` |
| `bom.controller.ts` | `bom` | `BomService` |
| `price-lists.controller.ts` | `price-lists` | `PriceListsService`, `ExcelService` |
| `products.controller.ts` | `products` | `ProductsService`, `ExcelService` |
| `commission.controller.ts` | `commission` | `CommissionService` |
| `customers.controller.ts` | `customers` | `CustomersService`, `ExcelService` |
| `delivery.controller.ts` | `delivery` | `DeliveryService` |
| `deposits.controller.ts` | `deposits` | `DepositsService` |
| `fulfillment.controller.ts` | `fulfillment` | `FulfillmentService` |
| `hr.controller.ts` | `hr` | `HrService` |
| `warehouse-transactions.controller.ts` | `warehouse-transactions` | `WarehouseTransactionsService` |
| `work-order.controller.ts` | `manufacturing/work-orders` | `WorkOrderService` |
| `payroll.controller.ts` | `payroll` | `PayrollService` |
| `goods-receipt.controller.ts` | `procurement/goods-receipts` | `GoodsReceiptService` |
| `purchase-order.controller.ts` | `procurement/purchase-orders` | `PurchaseOrderService` |
| `purchase-request.controller.ts` | `procurement/purchase-requests` | `PurchaseRequestService` |
| `rfq.controller.ts` | `procurement/rfqs` | `RfqService` |
| `supplier-payment.controller.ts` | `procurement/supplier-payments` | `SupplierPaymentService` |
| `reports.controller.ts` | `reports` | `CustomerAccountsService`, `ExcelService`, `ReportsService` |
| `sales-returns.controller.ts` | `sales-returns` | `SalesReturnsService` |
| `shipment-returns.controller.ts` | `shipment-returns` | `ShipmentReturnsService` |
| `sales.controller.ts` | `sales/reps` | `SalesService` |
| `target.controller.ts` | `targets` | `TargetService` |

### §1.3 — Required change (uniform shape, applies to every one of the 43)

1. Add `CompanyContextGuard` to the controller's `@UseGuards(...)` (alongside existing `JwtAuthGuard`/`PermissionGuard`).
2. For each service call the controller makes, thread `req.companyContext.dataSource.manager` through — for Tier 1 services, the parameter already exists; for Tier 2, add `manager?: EntityManager` to the service method(s) actually reachable from HTTP (not necessarily the whole service file), defaulting to today's ambient behavior when omitted, exactly the established pattern (`(manager ?? this.dataSource).getRepository(...)`) — never a new pattern invented per service.
3. No entity gains a `companyId` column (§1.1) — isolation is connection-level, not row-level.
4. A parallel Installation-Admin path is **not assumed required** for every one of the 43 — add only where a genuine platform-admin cross-Company need is evidenced (none found so far for this set; flagged as an open question if it surfaces during implementation, not invented now).

### §1.4 — Isolation proof + regression test (one methodology, applies to all 43)

Exactly the methodology already proven twice this program (ADR-074 Gate D,
Area 14 §8 items 1-4): two real, separately-provisioned Company databases,
one user with a real grant in each.

- **Test A (positive):** Company A user → Company A resource → ALLOW, data returned is genuinely Company A's.
- **Test B (cross-company):** Company A user → Company B resource ID → DENY, **and** assert the Company B `DataSource` was never even requested (`CompanyConnectionManagerService.getDataSource` not called with Company B's id) — not just "the row wasn't returned."
- **Test C (no company context):** request without a resolvable Company → DENY.
- **Test D (revoked membership):** a user whose `Membership` was revoked between login and request → DENY.
- **Test E (wrong-company resource id):** a syntactically valid resource id that belongs to a different Company → DENY, same DB-never-selected proof as Test B.
- **Test F (DB routing):** explicit assertion, via a spy/poisoned-ambient technique, that the Platform DataSource is never touched for a Company-scoped read once `CompanyContextGuard` resolves a Company.

## §2 — The 5 Mixed/Special: Full Resolution Packages (updated 2026-09-26 — corrected findings, see §2.0)

Per your structure: Current architecture → Problem → Why the §1 template can't apply blindly → Required resolution → Security implication → Data-model implication → Authorization implication → Test strategy → Open decision. None implemented; each ends in an explicit open decision, not a default.

### §2.0 — Decision Package Summary (for fast CTO sign-off) + corrected-finding notice

| # | Surface | Open decision (one line) | Severity | Depends on |
|---|---|---|---|---|
| 2.1 | `integration-order-intake.controller.ts` | How is an `IntegrationConnector` bound to exactly one Company? | Highest — zero Company enforcement today | independent |
| 2.2 | `approval.controller.ts` | Is Approval Company-scoped or Installation-wide by design? | High if scoped | independent |
| 2.3 | `admin.controller.ts` (`GET /admin/sales-reps`) | Does `sales_rep` become a Company-local role, or stay platform-wide? | Lower — caller already platform-privileged | independent |
| 2.4 | `integrations.controller.ts` | Same as 2.1 | High | **tied to 2.1** |
| 2.5 | `media.controller.ts` | Corrected 2026-09-26: no ADR-031 document exists — see below. Real decision: does `MediaAsset` join Model B (per-Company DB + `COMPANY_ENTITY_REGISTRY`), stay Platform-wide, or split? | Medium — cross-domain FK implication (see below) | independent, but touches 2 Tier domains' FKs |

**Corrected-finding notice (2026-09-26, STOP CHANGE → RECORD EVIDENCE → CLASSIFY → ESCALATE):** while gathering evidence for this package, re-verification found **no `ADR-031-*.md` file exists anywhere under `docs/decisions/`** (confirmed: `docs/decisions/ADR-*` listing has no ADR-031; full-repo grep for "ADR-031" outside this Matrix hits only source-code comments referencing it prospectively — "once ADR-031 ships," `media.controller.ts` lines 63/74 — and one unrelated study document). The earlier characterization of §2.5 ("tied to ADR-031's shared MediaAsset concept," "classify... per ADR-031") **cites a decision document that was never authored** — a genuine correction, not a rephrasing; the real evidence and corrected package are in §2.5 below. Nothing was implemented or changed based on the incorrect citation, so this correction has zero code impact — it only corrects this Matrix's own prior text. No unilateral resolution was substituted; §2.5's open decision is restated below strictly from source evidence.

### 2.1 `integration-order-intake.controller.ts`

- **Current architecture:** gated by a **separate** guard entirely — `IntegrationAuthGuard` (confirmed by source, not `JwtAuthGuard`). External-facing order intake (partner/customer submission), not a normal authenticated-user session route. `ReceiveOrderDto` carries `externalOrderId`, customer name/phone, line items — no Company identifier anywhere in the payload. **New evidence (2026-09-26):** a real `IntegrationConnector` entity already exists ([`integration-connector.entity.ts`](src/foundation/integrations/infrastructure/integration-connector.entity.ts)) — columns: `id`, `connectorType`, `name`, `status`, `config` (jsonb, non-secret settings only), `lastConnectedAt`, `createdAt`, `updatedAt`. **Confirmed: zero Company-binding column of any kind** — this is concrete, not inferred: the connector-identity-to-Company binding this package calls for does not exist on the one entity that would naturally hold it.
- **Problem:** there is no authenticated platform User, no `Membership`, and no JWT at all on this path — the entire `CompanyContextGuard` mechanism assumes exactly those three things exist.
- **Why §1's template cannot apply blindly:** `CompanyContextGuard` re-validates a `Membership` row for `req.user.id` — there is no `req.user` here. Bolting the guard on would simply 401 every legitimate external caller.
- **Required resolution (not decided here):** the integration **connector** itself (the caller's own registered identity — `IntegrationAuthGuard` already authenticates *something*, presumably against `IntegrationConnector`) must carry its own fixed Company binding, resolved server-side from the connector's own record, never from the request body. Concretely this looks like a new `companyId` (or equivalent) column on `IntegrationConnector` plus the corresponding provisioning/admin flow to set it — not examined further here, since which shape is correct is the actual open decision.
- **Security implication:** today, a compromised or misconfigured `IntegrationAuthGuard` credential has no Company boundary to breach in the first place — worse than "gets the wrong Company," it gets **no Company enforcement of any kind**. This is the most severe of the 5, now confirmed (not just suspected) by the entity's actual column list.
- **Data-model implication:** a new column on `IntegrationConnector` — the entity to change is now identified precisely; the column's shape/semantics is the open decision.
- **Authorization implication:** orthogonal to Model B entirely; this needs its own connector-identity-to-Company binding on `IntegrationConnector` (not designed here).
- **Test strategy:** cannot reuse the standard Company A/B user-membership harness (§7) as-is — needs a connector-identity fixture instead of a user fixture.
- **Open decision:** how is `IntegrationConnector` bound to exactly one Company, and where/how is that binding set (admin-provisioned at connector-creation time? per-credential?)? **Escalate as an architecture decision, not an implementation default.**

### 2.2 `approval.controller.ts` (Approval Engine)

- **Current architecture:** `JwtAuthGuard` + `PermissionGuard` + `RolesGuard` (mixed). `ApprovalRequest` (confirmed by re-reading the entity today) has `requestTypeCode`, `resourceType`, `resourceId`, `makerUserId` — **no Company field of any kind, direct or indirect**. Company ownership of an approval, if it exists at all, is only inferable by looking up `resourceType`+`resourceId` in whatever table that resource actually lives in.
- **Problem:** an approval is about a resource that may itself be Platform-scoped or Company-scoped depending on `resourceType` — the same controller could plausibly need to handle both, or Company-ownership may need to be derived per-`resourceType`, not asserted once at the controller level.
- **Why §1's template cannot apply blindly:** `CompanyContextGuard` validates the *caller's* Company membership — it says nothing about whether the *resource being approved* belongs to that Company. Adding the guard here would authenticate the actor's Company without ever checking the resource's.
- **Required resolution (not decided here):** either (a) approvals become Company-scoped and `resourceType`/`resourceId` must be validated against the caller's Company on every read/decide, requiring a per-`resourceType` ownership lookup — non-trivial, or (b) approvals stay a deliberate Installation-wide cross-Company workflow primitive by design, in which case no retrofit applies here at all and this is a documented exception, not a gap.
- **Security implication:** if (a) is correct and unresolved, a Company A approver could currently decide on a Company B resource's approval request with zero rejection — genuinely the highest-severity open question among the 5 if approvals are meant to be Company-private.
- **Data-model implication:** option (a) likely needs a derived/joined Company lookup per `resourceType`, not a new column on `ApprovalRequest` itself (a generic polymorphic table gaining a `companyId` that's only sometimes meaningful would be its own design smell).
- **Authorization implication:** would need a new resource-ownership check layered on top of the existing `PermissionGuard`/`RolesGuard` pair, not a replacement of either.
- **Test strategy:** needs a resource-ownership matrix (which `resourceType`s exist today, which are Company-scoped) before any test can be written meaningfully.
- **Open decision:** **is Approval Company-scoped or Installation-wide by design?** This is the load-bearing question every other part of this package depends on. Escalate.

### 2.3 `admin.controller.ts` — `GET /admin/sales-reps` only

- **Current architecture (re-verified today, deeper than the first pass):** `@RequireRole('admin', 'sales_manager')` — a platform-role override on this one route (the rest of the controller is class-level admin-only). The handler is exactly: `this.authorization.getUserIdsForRole('sales_rep')` then `this.users.findByIds(ids)`.
- **Problem, now precisely identified:** `AuthorizationService.getUserIdsForRole` is the **Platform-level** role mechanism — the same one used for the bootstrap admin grant (`assignRole`/`revokeRole`/`getUserIdsForRole`, explicitly documented elsewhere in this codebase as "platform-level role grants... deliberately untouched, not part of the Company boundary"). This means `sales_rep` is currently a **Platform-wide role**, structurally unrelated to Model B's Company-local `Role`/`UserRole` system entirely — two separate role mechanisms coexist in this codebase today, and this route uses the platform one.
- **Why §1's template cannot apply blindly:** there is no Company-scoped data here to guard — the gap isn't "missing `CompanyContextGuard`," it's that "sales rep" as a concept has never been Company-bound at all. Adding `CompanyContextGuard` to this route would validate a Company context that the underlying query then completely ignores.
- **Required resolution (not decided here):** does "sales rep" become a genuine Company-local Model B role (moving this whole concept into each Company's own `Role`/`UserRole` catalog, `seedCompanyRoleTemplates`-style), or does it stay a Platform-wide designation with Company-scoping applied some other way (e.g., filtering the returned Users by Membership afterward)? These are materially different architectures.
- **Security implication:** today, any platform `admin`/`sales_manager` sees **every** sales rep across **every** Company in one list — likely working as intended for a platform-admin operational tool, but confirms this is NOT a per-Company data leak in the usual sense (the caller is already platform-privileged) — lower severity than 2.1/2.2.
- **Data-model implication:** if resolved as "make sales_rep Company-local," this touches the Model B role-catalog seeding mechanism — real, but bounded, scope.
- **Authorization implication:** would fork this one route's authorization model away from the rest of `admin.controller.ts`.
- **Test strategy:** depends entirely on which resolution is chosen.
- **Open decision:** **is `sales_rep` becoming a Company-local role, or does this stay platform-wide with a different scoping mechanism?** Escalate.

### 2.4 `integrations.controller.ts`

- **Current architecture:** `JwtAuthGuard` + `RolesGuard` (platform-admin surface, `/integrations/connectors`). `POST /integrations/connectors/:id/publish/order-status` accepts `dto.salesOrderId` (confirmed at the exact call site: `this.integrations.publishOrderStatus(id, dto.salesOrderId, dto.externalOrderId, req.user.id, dto.status)`), no visible Company-context check before that value is used. Same `IntegrationConnector` entity as 2.1 backs this controller's `:id` param — confirmed zero Company-binding column (§2.1).
- **Problem:** a client-supplied `salesOrderId` reaching a service call with no Company-boundary check is exactly the confused-deputy pattern this entire program has otherwise eliminated (Track A/D/Area 14 all deliberately derive Company identity from validated context, never a client-suppliable field).
- **Why §1's template cannot apply blindly:** this route is legitimately **platform-admin** (a connector operation, not a Company user's own action) — bolting on `CompanyContextGuard` would be wrong; the caller here IS a platform admin by design (same as `InstallationMembershipController`'s pattern), but the `salesOrderId` it's handed still needs to be proven to belong to the connector's own bound Company (§2.1's binding) before use.
- **Required resolution (not decided here):** once 2.1's connector-Company binding exists, this route validates `salesOrderId` belongs to that Company before calling `publishOrderStatus` — the same dual-path pattern (platform-admin-gated route, still not trusting a client-supplied identifier directly) Track A/D already established. This is genuinely dependent on 2.1's resolution, not independent.
- **Security implication:** confirmed real — a malicious or buggy connector integration could reference an arbitrary `salesOrderId` outside its own Company today.
- **Data-model implication:** none new beyond 2.1's.
- **Authorization implication:** needs the ownership check described above layered onto existing `RolesGuard` gating.
- **Test strategy:** depends on 2.1.
- **Open decision:** **tied to 2.1's connector-Company binding decision** — not independently resolvable.

### 2.5 `media.controller.ts` (corrected 2026-09-26 — see §2.0 notice)

- **Current architecture:** `JwtAuthGuard` only — no `PermissionGuard`, no `CompanyContextGuard`, no `RolesGuard`. `MediaAsset` entity ([`media-asset.entity.ts`](src/foundation/media/media-asset.entity.ts)): `id`, `storageKey`, `originalFilename`, `contentType`, `sizeBytes`, `uploadedByUserId` (nullable), `createdAt` — **no companyId, no orgUnitId, no ownership/visibility field beyond the uploading user**. `MediaService` ([`media.service.ts`](src/foundation/media/media.service.ts)) uses `@InjectRepository(MediaAsset)` — the standard NestJS DI-repository pattern bound at module-load time to the app's single root/ambient `DataSource` — **not** the `manager?:`/`dataSource?:` parameter-threading convention every one of the 43's services either already has (Tier 1) or can mechanically gain (Tier 2). `MediaAsset` is confirmed **absent from `COMPANY_ENTITY_REGISTRY`** (`core-company-entities.ts` — zero matches for "media"), so even though its migration (`CreateMediaAssets`) lives under the `core/` tag folder, `createCompanyDataSource()` does not include it in any Company DataSource's entity list today — Media has **no Company-DataSource path at all**, not merely an unguarded one. The controller's own code comments (lines 62-64, 74-76) reference a **future, not-yet-built** "ADR-031 scope-derivation layer" — re-verified this is about `foundation/scope/`'s org-unit-level Scope system (branch/department visibility *within* one Company, ADR-005's authorization axis), an axis **orthogonal to** Area 21's Company/multi-tenant-DB axis, not a synonym for it. **The earlier §2.5 text conflated these two axes; this is now corrected.**
- **Problem (corrected):** the real problem is not "which sharing model does Media have" (there is no evidence of an intentional sharing design at all — it looks like Media simply predates Model B and was never migrated) — it is that **`MediaAsset` is structurally incapable of Company-routing today without both an entity-registry change (ADR-074-style) and a service refactor away from `@InjectRepository`** (a strictly larger lift than any Tier 2 controller, all of which already use the mechanically-fixable `this.dataSource.getRepository()` pattern). Additionally, two Tier domains hold FK-style references into `MediaAsset` by id — `Deposit.evidenceMediaAssetId` (`deposit-control`, Tier 2) and `Shipment.waybillImageMediaAssetId` (`shipment`, Tier 1) — confirmed via grep, both currently plain UUID columns with no DB-level FK constraint found. Once those two domains' own data moves into per-Company databases, a `MediaAsset` row referenced by id would need to live in the *same* physical database as the referencing row, or the reference breaks across the Company boundary — this is a cross-cutting migration concern unique to Media among the 5.
- **Why §1's template cannot apply blindly:** §1's template assumes "add `CompanyContextGuard`, thread `manager` through an already-`@InjectRepository`-adjacent-or-better service." Media fails that assumption at the entity-registry level, not just the guard level — a materially different, larger retrofit shape.
- **Required resolution (not decided here):** (a) if Media should be Company-private (the FK evidence above suggests this is the more consistent choice — every current consumer of `MediaAsset` is itself a Company-scoped business record), it needs: `MediaAsset` added to `COMPANY_ENTITY_REGISTRY`, `MediaService` refactored to `manager?:`/`dataSource?:`, `CompanyContextGuard` added to `MediaController`, and an explicit decision on existing rows already sitting in the single ambient database (backfill into a specific Company's DB, or accept them as orphaned/legacy); or (b) Media stays Platform-wide by deliberate design, in which case the SEC-12 uploader-or-admin-only interim fix already in place (lines 81-87) is arguably sufficient as-is and no retrofit applies here — but this should be an explicit decision, not silence.
- **Security implication:** under (a) unresolved, a Company A user with a raw `MediaAsset` id belonging to Company B's uploaded evidence could theoretically download it today if they are that id's `uploadedByUserId` or an admin — today's SEC-12 fix is user-ownership-based, not Company-based, so it does not by itself prevent cross-Company access by a different uploader in the same ambient table; genuinely open, not yet exploited-and-confirmed in this pass.
- **Data-model implication:** real and now specific — `COMPANY_ENTITY_REGISTRY` addition + existing-row backfill/migration decision, not just a hypothetical "if mixed" column as previously written.
- **Authorization implication:** depends on which resolution is chosen; the existing SEC-12 uploader/admin check is orthogonal and would very likely stay unchanged either way.
- **Test strategy:** the two-company harness (§7) applies directly once (a) is chosen; needs an additional fixture for "existing ambient-DB row" if backfill semantics are tested.
- **Open decision:** **does `MediaAsset` join Model B (per-Company DB, full retrofit), stay Platform-wide by explicit decision, or split by some other rule?** This determines whether Media enters the standard 43-style pipeline (now a credible fourth Tier given the FK evidence above) or is closed as "not applicable, by design." Escalate — **not** an ADR-031 reading (§2.0 notice), a direct decision from the evidence above.

**None of these 5 are implemented, decided, or retrofitted in this document.** 2.1 and 2.4 are linked (2.4 depends on 2.1's resolution). 2.2 and 2.3 are each independently load-bearing architecture questions. 2.5's decision no longer depends on any external document — the evidence needed to decide it is now fully in this package.

### §2.6 — Out-of-scope discovery surfaced while gathering this evidence (recorded, not acted on)

While confirming `@RequireModule` module codes for the per-controller test specifications ([AREA21-CONTROLLER-TEST-SPECS.md](AREA21-CONTROLLER-TEST-SPECS.md)), three of the 43 were found to have **no `@RequireModule` decorator at all**: [`customer-ledger.controller.ts`](src/domains/customer-finance/interface/customer-ledger.controller.ts), [`sales-orders.controller.ts`](src/domains/sales-orders/interface/sales-orders.controller.ts), [`fulfillment.controller.ts`](src/domains/fulfillment/interface/fulfillment.controller.ts) — every other one of the 43 has it. This is an **entitlement/module-gating** question (whether a module is licensed/enabled), a different axis entirely from Area 21's Company-boundary question, and out of this Matrix's scope to resolve. Per the new discovery protocol: **recorded here as evidence, classified UNVERIFIED (whether this is intentional — e.g., these 3 may be always-on core routes — or a genuine gap is not determined by this pass), and escalated for routing** — not silently fixed, not assumed broken, not treated as blocking Area 21 preparation (all 3 already appear correctly in §1's Tier 1/Tier 2 tables regardless of this separate finding).

## §3 — Background Jobs / Scheduler Review (COMPLETE, 2026-09-25 — was "not yet audited," now closed)

All 6 schedulers in the entire codebase enumerated (`find src -iname "*.scheduler.ts"` — exhaustive, not a sample):

| Scheduler | Track | Company-connection mechanism | Status |
|---|---|---|---|
| `closing-snapshot-recovery.scheduler.ts` | Area 9 | `CompanyConnectionManagerService.getDataSource` | **VERIFIED** — ADR-074 Gate A/B proved `ClosingSnapshotRun` |
| `preliminary-hold-expiry.scheduler.ts` | Area 9 | `CompanyConnectionManagerService.getDataSource` | **VERIFIED** — `findExpiredPreliminaryHoldOrderIds` is RAW-SQL ONLY (no entity dependency); its `expireHoldForOrder`→`SalesOrdersService`/`ProcessEngineService` path was independently real-PG proven in ADR-074 Gate B (`SalesOrder`/`SalesOrderLine`/`ProcessInstance`/`ProcessTransitionRecord` all passed) — **upgraded from ADR-074's own "POTENTIALLY AFFECTED" to VERIFIED here, with the specific passing evidence cited, not asserted** |
| `approval-expiry.scheduler.ts` | Area 9 | `CompanyConnectionManagerService.getDataSource` (via `ApprovalEngineService.expire(dataSource)`) | **VERIFIED** — ADR-074 Gate B proved `ApprovalRequest`+3 related entities |
| `membership-reconciliation.scheduler.ts` | Track A | `CompanyConnectionManagerService.getDataSource` | **VERIFIED** — Area 14 real-PG spec covers grant/role_change/revoke replay directly |
| `backup-reconciliation.scheduler.ts` | Track D | `DatabaseRegistryService.getConnectionConfigForCompany` (via `BackupManagerService.retryBackup`) — a **separate, deliberate** mechanism from `CompanyConnectionManagerService`, per Track D's own Step 5 decision | **VERIFIED** — Track D's own real-PG tests |
| `company-baseline-backup.scheduler.ts` | Track D | `CompanyConnectionManagerService.listActiveCompanyIds()` only (a control-plane query, never `.getDataSource()`) + `BackupManagerService.createBackup` (same Step-5 mechanism as above) | **VERIFIED / NOT AFFECTED** — never touches the entity-registry path at all |

**Finding: zero background jobs require retrofit.** All 6 already use explicit `companyId` + validated Company connection routing, never an ambient/default connection — matching your own required shape exactly. No new scheduler exists outside these 6 anywhere in the codebase (exhaustive `find`, not sampled). This closes CTO point 7/9 in full — not partially, not "looks clean."

## §4 — Backup/Restore/Audit/Membership regression boundary (per CTO points 8-9)

Track D, Area 14, Track A, ADR-073, ADR-074, Area 4, Area 5/6, Area 9 stay
CLOSED and are **not reopened** by this Matrix. `CompanyBackupController`
already uses the exact `CompanyContextGuard`+`PermissionGuard` pattern this
retrofit will extend to the 43 — Area 21 retrofit work must only add
regression coverage confirming those don't break, never modify them.

## §6 — Data Access Map (2026-09-25, CTO point 8, complete — read-only sweep, zero code changed)

Swept all 22 domain directories underlying the 43 controllers for: `getRepository`, `getDataSource`, raw `.query(`, `companyId`, ambient/default-connection usage.

- **`companyId` as an identifier/column:** appears in exactly 2 files in the entire codebase outside `foundation/` — both already-verified Area 9 scheduler-adjacent files (`closing-snapshot-recovery.scheduler.ts`, `preliminary-hold-expiry.scheduler.ts`), both already covered in §3. **Zero occurrences anywhere in the 43's own domain services, controllers, or entities.** This independently confirms §1.1's "zero companyId columns" finding from the opposite direction (grep by identifier, not by entity-file inspection).
- **`getRepository`/`getDataSource` calls in the 43's domains:** all resolve to either `this.dataSource.getRepository(...)` (the ambient, ungoverned connection — the exact pattern §1.3 requires converting to `(manager ?? this.dataSource).getRepository(...)`) or, in the 13 Tier 1 services, already accept an optional `manager`/`dataSource` parameter per §1.2. No third pattern found — no repository-injection style (`@InjectRepository`) survives in any of these services' Company-data methods (would be structurally incapable of Company-routing, and none was found, so this is not a hidden extra risk category).
- **Raw `.query()` usage:** 34 files within the 43's domains call `.query()` directly (mostly reporting/aggregation services — Reports, Commission, Targets, Inventory Valuation). Class-level nuance, not a new risk tier: raw SQL has no entity-metadata dependency, so these call sites need **only** `manager?:`/`dataSource?:` parameter threading — they never need a `COMPANY_ENTITY_REGISTRY` entry, narrowing (not widening) their retrofit surface relative to entity-repository call sites.
- **Platform-repository usage inside the 43's domains:** none found — no Tier 1 or Tier 2 service reaches into a Platform-only entity (`User`, `Membership`, `Company`, `DatabaseRegistry`) directly; all Platform-context needs are confirmed to flow through the controller layer only (`req.user.id`), consistent with §1.3's required-change shape.
- **Ambient/default-connection fallback in background paths:** none found beyond the 6 schedulers already fully accounted for in §3.

**Conclusion: the Data Access Map surfaces no new risk category beyond what §1 (the 43) and §2 (the 5) already describe.** It narrows the raw-SQL subset's retrofit cost and independently corroborates the "zero companyId columns" finding.

## §7 — Test Harness (2026-09-25, CTO point 6, built and self-verified — safe-to-build-now item)

New reusable module: [`two-company-real-pg-harness.ts`](src/foundation/testing/two-company-real-pg-harness.ts) — extracts the two-real-Company setup sequence this program has hand-written independently at least six times already (ADR-074 Gate D, Area 14 items, `memberships-mine.real-pg.spec.ts`) into one reusable, disposable-database module. Provides real Company A / Company B DataSources, `UsersService`/`MembershipService`/`CompanyService` bound to a real control-plane DataSource, and `createUserWithAdminRoleIn(fullName, companyId)` for fast real-Postgres fixture setup — covering every combination the CTO's harness spec required (A user, B user, Membership A, Membership B, revoked membership, missing company context) except the invalid-resource case, which is controller-specific and deferred to each per-controller test plan.

Self-test: [`two-company-real-pg-harness.spec.ts`](src/foundation/testing/two-company-real-pg-harness.spec.ts), **9/9 passing** against real Postgres — A→A, A→B (cross-company denial), B→B, revoked membership, missing company context, the two-distinct-cached-DataSources isolation contract, plus 3 new tests below. Zero residual test databases after run. Lint clean (`npx eslint`, 0 problems), `npm run build` clean.

**2026-09-26 extension:** added two reusable isolation-assertion helpers — `assertDataSourceNeverRequestedFor(connections, forbiddenCompanyId, fn)` (spies on `CompanyConnectionManagerService.getDataSource` for the duration of `fn`, asserts the forbidden Company id was never requested, always restores the original method even if `fn` throws — implements Tests B/E's "DB never even selected" bar precisely) and `assertDistinctCachedDataSources(harness)` (generalizes the existing isolation-contract check into a reusable call). Both self-tested against real Postgres (3 new passing cases, including a deliberate-failure case proving the assertion actually fails when it should, and a restoration check proving the spy unwraps cleanly after both success and failure).

Per-controller test plans for all 43 are now specified (not yet implemented as runnable `.spec.ts` files) in the companion document [AREA21-CONTROLLER-TEST-SPECS.md](AREA21-CONTROLLER-TEST-SPECS.md) — migration tags, Tier, and representative resource fixed per controller, built on this harness and its two new helpers, so the flow becomes `Implement → run prebuilt proof → analyze → fix → re-run`, not `Implement → figure out what to test`.

## §8 — Dependency Queue

| Task | Status | Dependency | Authorized? | Next Action |
|---|---|---|---|---|
| Retrofit Matrix (§0-§2, §6) | DONE | None | YES | Maintain as findings evolve |
| Scheduler/Background Review (§3) | DONE | None | YES | Closed — no further action |
| Data Access Map (§6) | DONE | None | YES | Closed — no further action |
| Test Harness (§7) | DONE | None | YES | Extend further only as new per-controller needs surface during Retrofit |
| Mixed/Special Resolution Packages (§2) | PREPARED, decisions OPEN | Architecture decisions (5 separate questions, §2.0) | NO (decisions) | Present open decisions to CTO (§2.0 table) |
| Per-Controller Real-PG Test Specs (43) | DONE (specs) | Test Harness (§7, done) | YES | [AREA21-CONTROLLER-TEST-SPECS.md](AREA21-CONTROLLER-TEST-SPECS.md) — turn into runnable `.spec.ts` files per controller once Retrofit starts on that controller |
| Area 21 Controller Retrofit Code (43 + 5) | BLOCKED | CTO Retrofit Authorization | NO | WAIT |
| Full Regression Re-run (post-retrofit) | WAIT | Retrofit code implemented | NO | RUN AFTER IMPLEMENTATION, compare to §9 baseline |

## §9 — Pre-Retrofit Regression Baseline (FROZEN, 2026-09-25)

**"PRE-AREA-21-RETROFIT BASELINE": 82 suites passed / 82 total, 513 tests passed / 513 total, exit code 0, zero residual test databases.** Full sequential (`--runInBand`) run, not a parallel batch (parallel batches showed 2 intermittent `DROP DATABASE ... WITH (FORCE)` "permission denied to terminate process" artifacts, diagnosed as a parallel-worker Postgres connection-state artifact, not a code regression — confirmed via isolated re-run of the 2 affected suites, 8/8 clean, then this full sequential run as definitive proof).

All future post-retrofit regression runs are compared against this exact baseline. Any suite/test count below 82/82 or 513/513, or any new failure, is treated as a retrofit-caused regression requiring investigation before proceeding — not waved through.

## §10 — Lint Baseline (FROZEN, 2026-09-25)

**9 errors + 1 warning = pre-existing / untouched**, all in files never modified this session. Not cleaned up now — only re-evaluated for a specific file if Retrofit later actually touches that file. Recorded here so any future lint-count change is attributable to Retrofit work, not silently absorbed into "the project's baseline."

## §11 — AREA 21 RETROFIT READY PACKAGE (status, updated 2026-09-26)

All CTO-authorized "safe now" preparation items are complete:

- ✅ Retrofit Matrix (§0-§1) — 60-controller classification, 43's Tier 1/Tier 2 split
- ✅ Impact/Dependency shape documented per-controller in §1
- ✅ Finding classification discipline applied throughout (no POTENTIALLY AFFECTED silently promoted) — including a live application of the discipline on 2026-09-26: the "ADR-031" citation error was caught, recorded, classified, and corrected (§2.0), not silently fixed
- ✅ Mixed/Special Resolution Packages (§2) — 5 of 5, each with an explicit open decision backed by direct source evidence (§2.0 summary table for fast sign-off); none defaulted
- ✅ Test Harness (§7) — built, self-tested (9/9), reusable, now with 2 isolation-assertion helpers
- ✅ Per-controller Real-PG test specifications for all 43 — [AREA21-CONTROLLER-TEST-SPECS.md](AREA21-CONTROLLER-TEST-SPECS.md), migration tags sourced from verified `@RequireModule` grep, not guessed
- ✅ Data Access Map (§6) — complete, no new risk category found
- ✅ Scheduler/Background Review (§3) — complete, all 6 VERIFIED SAFE
- ✅ Regression Baseline frozen (§9) — 82/82, 513/513
- ✅ Lint Baseline frozen (§10) — 9 errors + 1 warning, pre-existing; this session's own harness additions independently confirmed lint-clean and build-clean, not just assumed
- ✅ Evidence Index (§12) — every cited finding traceable to a file/line
- 🔴 5 Mixed/Special open decisions — require CTO input, listed individually in §2.0, not defaulted
- 🟡 One out-of-scope discovery flagged, not resolved (§2.6: 3 of the 43 have no `@RequireModule` — an entitlement-gating question, not a Company-boundary one)
- 🔴 Controller Retrofit Code (43 + 5) — remains BLOCKED on explicit Retrofit Authorization, per Gate Rule §8

**No further safe-authorized preparation work remains that is not either (a) done, (b) waiting on a specific open architecture decision, or (c) the Retrofit code itself.** Ready for review and the explicit execution decision.

## §12 — Evidence Index

Every substantive claim in this Matrix traces to one of these sources — listed here so nothing above rests on an unverified assertion. Not a repeat of the findings, a pointer to where each was established.

| Claim | Evidence source |
|---|---|
| 60-controller classification (§0) | Direct enumeration of every `*.controller.ts` under `src/domains`+`src/foundation` (excluding `_deploy`/`storage` snapshot copies) |
| Zero `companyId` columns in the 43's entities (§1.1) | `grep -rl companyId src/domains/*/infrastructure/*.entity.ts` — no matches |
| Tier 1/Tier 2 split (§1.2) | Direct read of each of the 13/30 controllers' injected services for the `manager?:`/`dataSource?:` parameter |
| `admin.controller.ts` `sales_rep` platform-role finding (§2.3) | Direct read of `admin.controller.ts`'s `listSalesReps()` handler and `AuthorizationService.getUserIdsForRole` |
| `ApprovalRequest` has no Company field (§2.2) | Direct read of `approval-request.entity.ts` |
| `IntegrationConnector` has no Company-binding column (§2.1/§2.4) | Direct read of `integration-connector.entity.ts` |
| No `ADR-031-*.md` exists (§2.0/§2.5) | `Glob docs/decisions/ADR-*` (49 files, none numbered 031) + repo-wide grep for "ADR-031" (hits only prospective source comments and one unrelated study doc) |
| `MediaAsset` absent from `COMPANY_ENTITY_REGISTRY` (§2.5) | Direct read of `core-company-entities.ts` — no "media" match |
| `MediaService` uses `@InjectRepository`, not `manager?:` (§2.5) | Direct read of `media.service.ts` |
| `Deposit`/`Shipment` hold `MediaAsset`-id FK-style columns (§2.5) | `grep -rn MediaAsset src` → `deposit.entity.ts:evidenceMediaAssetId`, `shipment.entity.ts:waybillImageMediaAssetId` |
| 3 of the 43 lack `@RequireModule` (§2.6) | `grep -rn "@RequireModule\(" src/domains` cross-referenced against the full 43 list — `customer-ledger`, `sales-orders`, `fulfillment` controllers absent |
| Module codes for the other 40 (test specs doc) | Same grep, direct hits per controller |
| 6 schedulers, all VERIFIED SAFE (§3) | Exhaustive `find`/glob for `*.scheduler.ts` (6 results) + per-file connection-mechanism read |
| `PreliminaryHoldExpiryScheduler` upgrade to VERIFIED (§3) | Cross-reference to ADR-074 Gate B's own passing real-PG test results (already-existing evidence, re-cited not re-run) |
| Data Access Map findings (§6) | `grep -rl companyId`/`.query(` sweep across the 22 domain directories |
| Test Harness 9/9 passing (§7) | This session's own `npx jest src/foundation/testing/two-company-real-pg-harness.spec.ts --runInBand` run, real Postgres, zero residual databases |
| Harness helpers lint-clean / build-clean (§7) | This session's own `npx eslint` (0 problems) and `npm run build` (exit 0) runs |
| Pre-Retrofit Regression Baseline 82/82, 513/513 (§9) | This session's own full sequential `--runInBand` run (background task `b32b54q4k`), analyzed and cross-checked line-by-line against the frozen figure |
| Lint Baseline 9 errors + 1 warning (§10) | Prior session's `npx eslint` full-repo run, re-confirmed unaffected by this session's own lint-clean additions |

## §14 — Operational Company Scoping Retrofit — Inventory & Design (2026-09-27 update)

**This is the same retrofit** the CTO's "AREA 21 — Operational Company
Scoping / DB Routing Retrofit" directive (2026-09-27, following Frontend's
live P1.7 discovery that a new Company's Dashboard/Sales still read
legacy data) is asking for. **Nothing below is new work restarting from
zero** — §0-§13 above already are the inventory, tiering, per-controller
test specs, background-job audit, and test harness this directive asks
for as its "first step." This section closes the specific NEW questions
the 2026-09-27 directive raises that §0-§13 didn't already answer, and
maps the directive's own literal domain list onto the existing 43. **No
code has changed as a result of this section — still inventory/design
only**, per the directive's own explicit instruction.

### §14.0 — Frontend's discovery is confirmation, not a new finding

The exact failure Frontend reproduced live (a brand-new Company's
Dashboard/Sales showing the legacy figures `245.00` / `2 Sales Orders`)
is precisely what §1.1 already stated as VERIFIED fact on 2026-09-25:
*"All 43 currently use only `JwtAuthGuard` + `PermissionGuard`... no
`CompanyContextGuard` anywhere... every read/write for these 43
controllers currently executes against the Platform database, regardless
of which Company the data conceptually belongs to."* `sales-orders.controller.ts`
is explicitly in the Tier 1 table (§1.2) as needing exactly this fix. The
Control Plane (P0) being real and correct does not — and was never
claimed to — imply the 43 operational controllers already routed through
it; §1.1 said the opposite, explicitly, two days before this was
observed at runtime. Recorded here so the record is accurate: this is
the Matrix's own prediction landing, not a gap in the Matrix.

### §14.1 — The architectural mechanism (already proven, not being invented)

The directive asks to *"identify the smallest safe architectural
mechanism that can make TypeORM repository resolution Company-aware
without duplicating or corrupting existing domain logic."* §1.3 already
names it, and it is not new — it is the exact mechanism ADR-074 (Gate
A/B/D), Track A, Track D, and Area 14 already built and real-PG-verified
for the Control Plane and the 6 schedulers:

```
POST /auth/select-company
        ↓
CompanyContextGuard (existing — validates Membership, resolves
  CompanyConnectionManagerService.getDataSource(companyId), attaches
  req.companyContext.dataSource)
        ↓
Controller passes req.companyContext.dataSource.manager into its
  service call(s) — one added parameter per call site, not a rewrite
        ↓
Service method signature gains manager?: EntityManager (Tier 1: already
  has it — 13 controllers' services, zero change; Tier 2: add it — 30
  controllers' services)
        ↓
Every repository/query call inside that method changes from
  `this.dataSource.getRepository(X)` to `(manager ?? this.dataSource).getRepository(X)`
  — same established idiom everywhere it already exists, never a new one
  invented per service. Raw `.query()` call sites (§6, 34 files) take the
  identical `manager` parameter, no entity-registry work needed.
        ↓
No entity gains a companyId column (§1.1) — isolation is which
  DataSource/connection served the query, never a WHERE clause.
```

**Why this is "the smallest safe mechanism," not just "a" mechanism:** it
introduces zero new abstractions, zero new guards beyond the one that
already exists and is already used by 4 compliant Company-scoped
controllers, and zero new service-layer pattern — Tier 1's 13 controllers
prove the END STATE already works today by simply threading a parameter
that already exists on those services. Tier 2's 30 controllers need the
identical parameter added, not a different architecture. This reuses
`CompanyContextGuard`, `CompanyConnectionManagerService`, and the
`manager?:` convention exactly as the directive requires ("reuse those
proven primitives... do not redesign Company provisioning") — nothing
here touches `CompanyRegistryService`, `DatabaseProvisioningService`, or
`CompanyActivationService`.

**Explicitly not done, per the directive's own stop condition #6:** this
is not "scatter `CompanyContextGuard` decorators across controllers" as
a bare guard-only change — the guard addition and the service-layer
`manager?:` threading are one inseparable unit of work per controller;
adding the guard without threading the parameter would 401/permit
correctly but silently keep reading the ambient DB, which is exactly the
symptom Frontend found. §1.3's 4-point shape already states both halves
as one change, not two separable ones.

### §14.2 — Domain list reconciliation (directive's list vs. the existing 43)

Every domain the directive names maps onto the already-inventoried 43
(§1.2) — nothing outside that set was found:

| Directive's domain | Existing controller(s) (§1.2) | Tier |
|---|---|---|
| Dashboard | **No dedicated controller exists** (confirmed: `find -iname "*dashboard*controller*"` — zero results). The frontend Dashboard view aggregates from Sales Orders / other already-listed domains — covered by fixing those, not a separate surface |
| Sales | `sales-orders.controller.ts`, `sales.controller.ts` (sales reps) | 1, 2 |
| Customers / Customer Ledger | `customer-ledger.controller.ts` (+ `customers.controller.ts`) | 1, 2 |
| Products | `products.controller.ts` (+ `price-lists.controller.ts`, `bom.controller.ts`) | 2 |
| Warehouse / Inventory | `inventory.controller.ts`, `inventory-valuation.controller.ts`, `warehouse-transactions.controller.ts` | 1, 1, 2 |
| Fulfillment / Shipping | `fulfillment.controller.ts`, `shipment.controller.ts`, `delivery.controller.ts`, `sales-returns.controller.ts`, `shipment-returns.controller.ts`, `returns.controller.ts` | 2, 1, 2, 2, 2, 1 |
| Procurement / Suppliers | `supplier.controller.ts`, `supplier-invoice.controller.ts`, `purchase-order.controller.ts`, `purchase-request.controller.ts`, `rfq.controller.ts`, `goods-receipt.controller.ts`, `supplier-payment.controller.ts` | 1, 1, 2×5 |
| Manufacturing | `work-order.controller.ts` | 2 |
| Treasury | `treasury.controller.ts` | 1 |
| Accounting / GL | `general-ledger.controller.ts`, `accounting.controller.ts`, `ap/ar/cash-bank/fixed-asset/grni/inventory-accounting/wip.controller.ts` | 1, 1, 2×7 |
| HR | `hr.controller.ts` | 2 |
| Payroll | `payroll.controller.ts` | 2 |
| Attendance | `attendance.controller.ts` | 2 |
| Targets / Commission | `target.controller.ts`, `commission.controller.ts` | 2, 2 |
| Reports | `reports.controller.ts` | 2 |
| Invoices/Payments/Deposits (not named, found anyway) | `invoices.controller.ts`, `payments.controller.ts`, `deposits.controller.ts` | 1, 1, 2 |

**Conclusion: the directive's list is a subset of the already-inventoried
43, not a superset.** Nothing new to add to §1.2's tables. The "inventory
the actual repository/data-source consumers... do not assume the list
above is complete" instruction is already satisfied — §1.2 was built by
reading every one of the 43 controllers' actual injected services
directly, not by working from a named list at all.

### §14.3 — Background jobs (directive requirement #9) — already closed, re-confirmed

§3 already exhaustively enumerated and real-PG-verified all 6 schedulers
in the codebase; every one resolves an explicit `companyId` through
`CompanyConnectionManagerService.getDataSource` (or the deliberate Track D
`DatabaseRegistryService.getConnectionConfigForCompany` variant) — never
ambient request context, because schedulers have no request context to
depend on in the first place. **No new scheduler has been added since
2026-09-25** (re-confirmed: `find src -iname "*.scheduler.ts"` still
returns exactly the same 6 files). Requirement #9 is met today, before
any of the 43's retrofit work even starts.

### §14.4 — Caches (directive requirement #10) — investigated fresh, zero risk found

Swept the 43's entire service layer for any persistent, cross-request
cache:

- `grep` for `CacheModule`/`@nestjs/cache-manager` anywhere in the whole
  backend (`src/`, not just the 43): **zero matches**. This framework
  caching mechanism is not used anywhere in this codebase.
- Every `new Map(...)` construction found in the 43's services (20 files)
  was individually confirmed to be a **local variable built fresh inside
  one method call** from that call's own just-fetched rows (e.g.
  `sales-orders.service.ts:586`: `const orderById = new Map(eligibleOrders.map(...))`)
  — discarded when the method returns, never a class field, never shared
  across requests. Zero cross-request state, zero cross-Company leakage
  risk, by construction.
- The one genuine process-level cache in the whole system relevant here,
  `CompanyConnectionManagerService`'s DataSource cache, is **already
  Company-aware by design and already proven** (§7's harness self-test:
  "two distinct, separately-cached DataSource objects for A and B") —
  exactly the shape requirement #10 asks for, already built, already
  tested.

**Conclusion: requirement #10 requires no new work for the 43.** Nothing
found needs to change; nothing was assumed clean without checking.

### §14.5 — Reports/exports/audit records (directive requirement #11)

- **`ExcelService`** (co-injected in `general-ledger`, `inventory`,
  `price-lists`, `products`, `customers`, `reports` controllers per §1.2):
  confirmed via its own constructor — **zero dependencies, no
  `@InjectRepository`, no `DataSource`**. It is a pure, stateless
  formatting utility with no database access of its own. It needs no
  Company-awareness and no retrofit — it only ever touches data its
  caller already fetched correctly.
- **`AuditService.record(input, manager?)`** — confirmed **already
  accepts the same `manager?: EntityManager` parameter** every Tier-1
  service does. Confirmed live in `journal-entry.service.ts` (Tier 1):
  its own `audit.record({...}, manager)` calls already thread the SAME
  `manager` the method received — meaning once `CompanyContextGuard`
  wires a real Company `manager` into these Tier-1 services, their audit
  writes become correctly Company-scoped **with zero additional code**,
  automatically, as a consequence of the one change already planned.
  **New, explicit instruction added to §1.3's required-change shape for
  Tier 2**: when a Tier-2 service method gains `manager?: EntityManager`,
  any `this.audit.record(...)` call inside that same method must also
  pass `manager` as its second argument — the exact same pattern Tier 1
  already demonstrates working, not a new one. This is one line per call
  site, folded into the SAME unit of work as the rest of that method's
  retrofit, not a separate audit-specific workstream.
- **Reports/exports themselves** (`reports.controller.ts`'s raw `.query()`
  calls, already counted in §6's 34-file raw-SQL finding): need only the
  same `manager` parameter threading as every other raw-SQL call site —
  no new mechanism.

### §14.6 — Updated Definition of Done for this workstream (per the 2026-09-27 directive's own verification requirement)

Per-controller, in addition to §1.4's Tests A-F (already specified per
controller in `AREA21-CONTROLLER-TEST-SPECS.md`), the retrofit is not
considered closed for that controller until the directive's own 12-step
sequence passes against it specifically: create A/B, seed distinct data
in each, select A → read/write A-only, select B → read/write B-only,
return to A → A unchanged except A's own writes, manipulated Company
context → rejected, no fallback to the legacy/ambient DB ever observed
(Test F's spy-based proof, not just "the response looked right"). This
is §1.4 restated in the directive's own words — no new test category is
required beyond what §1.4/the per-controller specs already define, and
the two-company harness (§7) plus its `assertDataSourceNeverRequestedFor`
helper already implement steps 5-11 mechanically.

### §14.7 — Status

Nothing here changes §11's status. Preparation for this exact workstream
was already **CLOSED** as of 2026-09-26. This update closes the 4
specific new questions the 2026-09-27 directive raised (mechanism naming,
domain-list completeness, caches, audit/reports) — all 4 resolved with
evidence, zero requiring new design work, zero requiring a new decision
from the CTO. The only things still requiring your decision before
`CODE → TEST → REAL-PG VERIFY → REGRESSION → DOCUMENT → NEXT` can start
are: (1) explicit Retrofit Authorization for the 43 (still not given),
and (2) the 5 Mixed/Special open decisions (§2.0 — unrelated to and not
blocking the 43's own retrofit, since none of the 5 are Tier 1/Tier 2
controllers).

## §16 — `sales-orders.controller.ts` retrofit (2026-09-27, CTO Authorization — first controller, CODE→TEST→VERIFY→DOCUMENT)

**Chosen first** because it is the exact controller behind Frontend's live
P1.7 bug report. Fully retrofitted, real-Postgres verified, zero
regressions. This section also **corrects §1.2's own Tier 1 cost
estimate** — real evidence found while doing the work, recorded here
rather than left standing.

### §16.0 — Correction to §1.2: "Tier 1 = fully capable, near-zero cost" was overstated

§1.2 marked `SalesOrdersService` "✓ (fully capable)" based on the
service CONTAINING the `manager?:` pattern somewhere (`getOrderStatus`,
`expireHoldForOrder`, both scheduler-only). Reading every method the
CONTROLLER actually calls found the opposite: of 14 public methods
`sales-orders.controller.ts` calls, only those 2 already had `manager?:`
— the other 12 (`createOrder`, `listOrders`, `listOrdersPage`, `getOrder`,
`getOrderDetailView`, `getOrderSnapshot`, `getOrderLines`,
`getOrderLineById`, `updateOrderLines`, `getOrderEditHistory`,
`editDraftOrder`, `deleteDraftOrder`, `transitionOrder`,
`releaseAfterDepositVerified`) needed it added. **"Tier 1" means "the
service already demonstrates the pattern works, copy it," not "little
work needed."** The real cost driver, not previously surfaced: full
correctness requires manager-threading through the ENTIRE transitive
call graph, not just the controller's own primary service — confirmed
live, `sales-orders.controller.ts` alone touched 6 services beyond
`SalesOrdersService` itself:

| Shared service | Was manager-capable before this pass? | Fixed now |
|---|---|---|
| `AuthorizationService.getRoleKeysForUser` | ✅ already | — |
| `ProcessEngineService.start/getState/transition` | ✅ already | — |
| `AuditService.record` | ✅ already | — |
| `InventoryReservationContract`'s 4 `*InTransaction` methods | ✅ already (required `manager`) | — |
| `NumberingService.getNextNumber` | ✅ already | — |
| `NumberingService.registerDocumentType` | ❌ | ✅ fixed |
| `ScopeService.assign/assertAccess/...` (all 6 methods) | ❌ — used `@InjectRepository`, structurally incapable, same class of gap as `media.controller.ts`'s own package (§2.5) | ✅ fixed, switched to injected `DataSource` |
| `ProductsService.getProductSnapshot`/`getProductSnapshotBySku` | ❌ | ✅ fixed |
| `PriceListsService.resolvePrice`/`getOverridePrice` | ❌ | ✅ fixed |
| `CustomersService.getWorkflowPolicySnapshot`/`getPriceListId`/`getCustomerSnapshot` | ❌ | ✅ fixed |
| `InventoryService.getWarehouse`/`confirmReservationsForOrder` | ❌ (contract + impl) | ✅ fixed |
| `UsersService.findById` (via `safeFindUser`) | N/A — Users are Platform-level (Model B), correctly stays ambient | left unchanged, correctly |

**Practical implication for pacing the remaining 12 Tier 1 + 30 Tier 2
controllers**: several of the now-fixed shared services (`ScopeService`,
`ProductsService`, `CustomersService`, `NumberingService`) are reused by
MANY of the other 42 controllers — this work is not sunk cost specific
to Sales Orders; it very likely reduces the remaining cost of several
other controllers whose own retrofit will find these dependencies
already fixed. Recommend continuing to work through controllers roughly
in dependency order (shared-service-heavy ones next) rather than a
strict list order, though still one controller at a time with its own
real-PG proof before moving on, per your explicit instruction.

### §16.1 — Entity-registry gap found and fixed (new, not previously known)

Making `ProductsService`/`PriceListsService`/`CustomersService`
manager-capable surfaced (via `company-entity-registry.completeness.spec.ts`,
ADR-074's own guard test — it caught this automatically, exactly as
designed) that `Product`, `PriceList`, `PriceListItem` (commerce) and
`Customer`, `CustomerAssignment` (crm) were never added to
`COMPANY_ENTITY_REGISTRY` — two domains with zero prior Company-entity
manifest at all. Fixed by adding
[`commerce-company-entities.ts`](../../src/domains/commerce/commerce-company-entities.ts)
and [`crm-company-entities.ts`](../../src/domains/crm/crm-company-entities.ts),
following ADR-074's exact established per-domain-manifest pattern —
confirmed via the same guard test now passing (2/2). `ScopeAssignment`
(foundation, not domain-owned) added to the existing `core-company-entities.ts`
for the same reason. **This means any OTHER controller relying on
Commerce/CRM/Scope data was ALSO silently missing this — not a
sales-orders-specific gap.** No other domain's manifest was touched.

### §16.2 — Real-Postgres verification (not simulated, not unit-mocked)

New test: [`sales-orders.company-isolation.spec.ts`](../../src/domains/sales-orders/interface/sales-orders.company-isolation.spec.ts) —
reproduces Frontend's exact bug shape against two real, separately-provisioned
Company databases (via the existing harness, `extraCompanyTags: ['sales']`),
with genuinely distinct seeded data (`SO-COMPANY-A-0001` / `SO-COMPANY-B-0001`)
inserted directly into each Company's own physical database:

- **Test A equivalent**: `listOrders` via Company A's manager resolves
  ONLY `SO-COMPANY-A-0001`.
- **Test B equivalent**: `listOrders` via Company B's manager resolves
  ONLY `SO-COMPANY-B-0001` — proves the exact bug is fixed, not just that
  the code compiles.
- **Test F**: `assertDataSourceNeverRequestedFor` proves Company B's
  DataSource is never even requested while resolving Company A's data.

3/3 passing, real Postgres, zero mocks below the service boundary.

### §16.3 — Build/lint/regression

`npm run build` clean throughout every incremental step. Real `NestApplication`
boot (live server restart, not just `Test.createTestingModule`) confirmed
zero DI/circular-dependency errors from the new `CompanyModule` import
into `SalesOrdersModule`. Lint and full regression suite results recorded
in chat (run in parallel with this document update) — not asserted here
without the actual output.

### §16.4 — What changed, file by file

`sales-orders.controller.ts` (guard + manager threading, all 8 routes),
`sales-orders.service.ts` (14 methods gained `manager?:`),
`sales-orders.module.ts` (+`CompanyModule` import), `scope.service.ts`
(rewritten to be manager-capable), `numbering.service.ts`
(`registerDocumentType` gained `manager?:`), `products.service.ts` (2
methods), `price-lists.service.ts` (2 methods), `customers.service.ts`
(3 methods), `inventory.service.ts` (2 methods) + its published contract
(`inventory.contract.ts`), `core-company-entities.ts` (+`ScopeAssignment`),
2 new files (`commerce-company-entities.ts`, `crm-company-entities.ts`),
`company-entity-registry.ts` (+2 imports), 1 new test file. **Zero
changes to any entity, zero new `companyId` column, zero change to
`CompanyContextGuard`/`CompanyConnectionManagerService`/Company
provisioning** — exactly the approved mechanism, nothing redesigned.

## §17 — `products.controller.ts` retrofit (2026-09-27, CTO "next preferred controllers" #1)

Second controller retrofitted, per the CTO's explicit 8-step execution
process (§ "IMPORTANT EXECUTION CORRECTION"). Chosen first of the three
named next controllers because `ProductsService` is a shared dependency
of both `PriceListsService` and `SalesOrdersService`.

### §17.0 — Call graph / manager-capability audit

All 9 controller-reachable methods (`createProduct`, `setStatus`,
`updateUnit`, `updatePrice`, `updateName`, `getProduct`,
`listActiveProducts`, `listAllProducts`, `importRows`) audited.
`getProductSnapshot`/`getProductSnapshotBySku` were already
manager-capable (fixed during the Sales Orders pass, §16.0). The
remaining 9 needed `manager?: EntityManager` added. Beyond
`ProductsService` itself, the only other dependencies are
`AuditService.record` (already manager-capable) and
`EventBusService` — see §17.2 below for the one gap found here.

### §17.1 — New DI wiring requirement discovered (applies to every remaining controller)

Adding `CompanyContextGuard` to `products.controller.ts` and importing
only `CompanyModule` into `CommerceModule` produced a real boot-time DI
resolution error on live server restart:

```
Nest can't resolve dependencies of the CompanyContextGuard (MembershipService, ?).
Please make sure that the argument CompanyConnectionManagerService at index [1]
is available in the CommerceModule context.
```

Root cause: `CompanyContextGuard`'s own constructor needs
`CompanyConnectionManagerService`, which lives in `DatabaseRegistryModule`
— importing `CompanyModule` alone does not transitively re-export it.
`SalesOrdersModule` had not hit this because it already imported
`DatabaseRegistryModule` for an unrelated reason (its own scheduler).
**Fixed by adding `DatabaseRegistryModule` alongside `CompanyModule` to
`CommerceModule`'s imports.** Confirmed via live server restart — zero
errors, clean "Nest application successfully started." **This is now a
documented required pattern for every remaining controller's own
module**, recorded here so it isn't rediscovered by trial and error 11
more times.

### §17.2 — `EventBusService` gap discovered here, fully documented in §18 below

`ProductsService.createProduct` dispatches a `commerce.product.created`
event that `PriceListsService.onModuleInit` subscribes to
(auto-add-to-General-list). Confirmed this handler's own downstream
calls resolve against the ambient connection, not the Company that
created the product — see §18.2 for the full write-up (found while
retrofitting the next controller, applies here too, not fixed by this
pass either).

### §17.3 — Real-Postgres verification

New test: [`products.company-isolation.spec.ts`](../../src/domains/commerce/interface/products.company-isolation.spec.ts) —
two real Company databases, one distinct seeded product each
(`SKU-COMPANY-A` / `SKU-COMPANY-B`), covering `listAllProducts`,
`listActiveProducts` (the public-read path, not just admin), and Test F
(`assertDataSourceNeverRequestedFor`). **4/4 passing.**

### §17.4 — Build/lint/regression

`npm run build` clean. Lint clean
(`products.controller.ts`/`products.service.ts`/`commerce.module.ts`).
`company-entity-registry.completeness.spec.ts` re-run, 2/2 passing
(no new entities needed — Product/PriceList/PriceListItem were already
registered during the Sales Orders pass, §16.1). Full regression: see
§19 below — the first full-suite run captured mid-session (background
task `bys0csynh`) was invalidated by `price-lists.controller.ts` being
mid-edit at the time it ran (a transient `AuthenticatedRequest` compile
error, since resolved); the authoritative run is the one in §19,
executed after both controllers reached a clean `npm run build`.

### §17.5 — What changed, file by file

`products.controller.ts` (`CompanyContextGuard` added to every route's
own `@UseGuards(...)`, all handlers now inject `CompanyScopedRequest` and
thread `req.companyContext.dataSource.manager`), `products.service.ts`
(9 methods gained `manager?:`), `commerce.module.ts` (+`CompanyModule`,
+`DatabaseRegistryModule`), 1 new test file. Zero changes to any entity,
zero new `companyId` column, zero change to `CompanyContextGuard`/
`CompanyConnectionManagerService`/Company provisioning.

## §18 — `price-lists.controller.ts` retrofit (2026-09-27, CTO "next preferred controllers" #2)

Third controller retrofitted. Reused `ProductsService`'s now-manager-capable
`getProductSnapshot`/`getProductSnapshotBySku` (fixed in §16) directly.

### §18.0 — Call graph / manager-capability audit

All controller-reachable methods (`createPriceList`, `setStatus`,
`setRole`, `getOrCreateGeneralList` (private, called by `onModuleInit`
and by `upsertItem`'s own event-handler path), `listPriceLists`,
`getPriceList`, `listItems`, `upsertItem`, `removeItem`,
`importItemRows`) audited and given `manager?: EntityManager`.
`resolvePrice`/`getOverridePrice` were already manager-capable (fixed
during the Sales Orders pass, §16.0). No new module-wiring change was
needed — `PriceListsController` lives in `CommerceModule`, already
updated with both `CompanyModule` and `DatabaseRegistryModule` during
the `products.controller.ts` fix (§17.1).

### §18.1 — Class-level guard (simpler than `products.controller.ts`)

`PriceListsController` already carried a single class-level
`@UseGuards(JwtAuthGuard, RequireModuleGuard)` (unlike
`products.controller.ts`'s per-route guards) — `CompanyContextGuard`
added once at the class level:
`@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)`,
correctly placed after `JwtAuthGuard` (needs `req.user`) and before
`RequireModuleGuard`/`PermissionGuard` (unaffected either way, but
matches the established ordering convention).

### §18.2 — Major finding: `EventBusService.subscribe` carries no Company context (NOT fixed, escalated)

`PriceListsService.onModuleInit` subscribes to `commerce.product.created`
to auto-add every new product to the General price list. Reading
`event-bus.service.ts` directly: `subscribe(topic, handler: (payload) =>
Promise<void>)` — the handler signature carries **no**
`EntityManager`/Company context at all, and `dispatchPending(batchSize,
manager?)` reads a specific Company's own outbox but never passes that
manager into the handler callback it invokes. Practical effect: this
handler's own `getProductSnapshot`/`upsertItem` calls resolve against
the **ambient** connection regardless of which Company's outbox the
event was actually dispatched from.

**Scope of this gap**: grep found **24 `subscribe()` call sites across
12 domains** (accounting ×6, attendance, commerce, commission ×4, hr,
payroll, procurement, shipment, targets, integrations ×4) — this is a
foundation-level `EventBusService` limitation, not specific to Price
Lists, and it also affects the already-closed `products.controller.ts`
(§17) via this exact same handler. Documented in code
(`price-lists.service.ts`'s `onModuleInit` doc comment, quoted in full
in the implementation) and here. **Explicitly not fixed by this
pass** — fixing it means changing the subscriber handler signature and
reviewing all 24 call sites for correctness, a foundation-level redesign
question out of scope for a single controller's retrofit. Recommend this
becomes its own explicitly-authorized workstream (either before or
interleaved with the remaining Tier 1/Tier 2 controllers) rather than
being silently absorbed into one controller's change set — flagged for
your decision.

### §18.3 — Real-Postgres verification

New test: [`price-lists.company-isolation.spec.ts`](../../src/domains/commerce/interface/price-lists.company-isolation.spec.ts) —
two real Company databases, each seeded (via direct raw-SQL insert) with
its own product, price list (`role: 'main'`), and price-list item at a
distinct override price. Covers `listPriceLists` (each Company also
correctly sees only its OWN migration-seeded `PL-GENERAL` row — confirms
that per-Company migration seeding, not a leak), `getPriceList` (a
cross-Company id correctly 404s — the row genuinely does not exist in
the other Company's own database), `listItems` (the sharpest proof: this
method calls into `ProductsService.getProductSnapshot(productId,
manager)` internally — a failure to thread `manager` would silently
resolve against the ambient Platform connection, which has no seeded
product data, and would fail closed rather than leak), `resolvePrice`
(each Company's own override price returned, never the other's), and
Test F (`assertDataSourceNeverRequestedFor`). **7/7 passing.**

### §18.4 — Build/lint/regression

`npm run build` clean. Lint clean
(`price-lists.controller.ts`/`price-lists.service.ts`/the new spec file).
`company-entity-registry.completeness.spec.ts` re-run, 2/2 passing (no
new entities needed). Full regression: see §19 below.

### §18.5 — What changed, file by file

`price-lists.controller.ts` (class-level guard change, all 11 routes
updated to inject `CompanyScopedRequest` and thread
`req.companyContext.dataSource.manager`), `price-lists.service.ts` (10
methods gained `manager?:`, plus the documented `onModuleInit` gap
comment), 1 new test file. No module-wiring change needed (`CommerceModule`
already correct from §17.1). Zero changes to any entity, zero new
`companyId` column, zero change to `CompanyContextGuard`/
`CompanyConnectionManagerService`/Company provisioning.

## §19 — Combined regression run for `products.controller.ts` + `price-lists.controller.ts` (authoritative, CLOSED)

Run from the clean, fully-compiling state (both controllers' edits
complete, `npm run build` exit 0) — supersedes the earlier
mid-edit-contaminated background run (`bys0csynh`, which failed 15
suites purely on a transient `AuthenticatedRequest` compile error from
`price-lists.controller.ts` being mid-edit at the time, since resolved).

**Result: 87 test suites, 85 passed outright, 556/556 individual tests
passed.** 2 suites (`area14-company-audit.real-pg.spec.ts`,
`database-provisioning.service.spec.ts`) failed to *run* (not a failed
assertion) on `QueryFailedError: permission denied to terminate process`
during their own `DROP DATABASE ... WITH (FORCE)` teardown step — the
same transient Postgres connection-state race already documented earlier
this session (§9/prior verification runs), unrelated to either
controller's own code. **Confirmed via isolated re-run**: both suites
pass cleanly on their own (7/7 tests). **Combined total: 563/563 tests
passing, zero real regressions.**

A benign `EventBusService` retry-exhaustion log
(`approval.request.approved` hitting `EXCL_targets_employee_period_when_approved`)
appears mid-run inside a passing test (`commission-phase1.spec.ts`/
targets-adjacent) — this is expected stderr output from a deliberate
negative-path test, not a new failure; the suite it belongs to is in the
85-passed count.

**Both `products.controller.ts` and `price-lists.controller.ts` are now
CLOSED** per the required `CODE → BUILD → REAL-PG ISOLATION → FULL
REGRESSION → DOCUMENT` sequence. Next: `customers.controller.ts` (3rd
CTO-named controller), one controller at a time, per the standing
instruction not to batch.

## §20 — `customers.controller.ts` retrofit (2026-09-27, CTO "next preferred controllers" #3)

Fourth controller retrofitted, completing the CTO's originally-named
3-controller batch (products → price-lists → customers).

### §20.0 — Call graph / manager-capability audit

All controller-reachable methods audited: `createCustomer`,
`assignSalesRep`, `importRows`, `setStatus`, `setOrderWorkflowPolicy`,
`setPriceList`, `setClassification`, `setFinancialSettings`,
`getCustomer`, `getPrimaryRepNamesByCustomerId`, `listCustomers`,
`listCustomersForRep`, `listCustomersPage` — all 13 gained
`manager?: EntityManager`. `getWorkflowPolicySnapshot`/`getPriceListId`/
`getCustomerSnapshot` were already manager-capable (fixed during the
Sales Orders pass, §16.0) — not HTTP-reachable via this controller, left
as-is. `findByPhone`/`findByCode`/`getCreditLimit` are called only by
OTHER controllers (external integrations, Customer-Finance) — correctly
left untouched here; they'll be addressed when THOSE controllers reach
their own turn, per the standing rule not to reach past this
controller's own boundary.

Beyond `CustomersService` itself, the transitive call graph touches:
`ScopeService` (already manager-capable, §16.0), `AuditService.record`
(already manager-capable), `EventBusService.publish` (already requires a
manager), `AuthorizationService.getRoleKeysForUser` (already
manager-capable, confirmed Role/UserRole are genuinely per-Company
tables — Multi-Company Area 6, seeded per-Company at provisioning),
`NumberingService.getNextNumber` (already manager-capable),
`UsersService.findByFullName` (Platform-level, correctly stays ambient —
`importRows`'s rep-name lookup is a cross-Company-irrelevant identity
lookup, same class as `UsersService.findById`).

### §20.1 — New gap found and fixed: `LimitService.check()` had no `manager?` at all

`CustomersService.createCustomer`'s `sales.max_customers` pre-check
(`this.limits.check('sales.max_customers')`) called `LimitService.check()`,
which — unlike `consume()`/`release()` just below it in the same class —
accepted **no** `manager` parameter whatsoever and always ran
`this.dataSource.transaction(...)` against the ambient connection.
`LimitProfile`/`LimitUsageCounter` are already Company-owned entities
(registered in `core-company-entities.ts`, confirmed before touching
anything), so this was a real, live correctness gap: even after every
other part of this retrofit was done correctly, the create-customer
quota gate would have kept silently checking (though not consuming —
`consume()` was already correctly manager-capable) the WRONG Company's
counters. **Fixed**: `check(limitKey, delta, manager?)`, same
optional-external-manager shape as `consume()`/`release()`. This
resolves a bug that would otherwise have shipped invisibly — `sales.max_customers`
has no manifest-declared default today, so it never actually denies a
create in the current running system, but the counter itself would have
been read from the wrong place the moment any Edition sets a real cap.

### §20.2 — Real-Postgres verification

New test: [`customers.company-isolation.spec.ts`](../../src/domains/crm/interface/customers.company-isolation.spec.ts) —
two real Company databases, each with its own distinct seeded customer
and primary-rep assignment. The test actor is seeded with the `admin`
role directly in EACH Company's own `roles`/`user_roles` tables
(confirming Multi-Company Area 6's per-Company role tables are real,
not assumed), so `listCustomers`/`getCustomer` exercise the
`REVIEWER_ROLES` bypass path — only `AuthorizationService.getRoleKeysForUser`
is constructed for real, matching the "construct only what the code path
under test actually needs" precedent. Covers `listCustomers` (each
Company sees only its own customer), `getCustomer` (a cross-Company id
genuinely 404s — the row does not exist in the other Company's own
database), `getPrimaryRepNamesByCustomerId` (the raw-SQL join correctly
threads `manager`, resolving each Company's own assignment), and Test F
(`assertDataSourceNeverRequestedFor`). **6/6 passing.**

One infrastructure-only finding surfaced while building this test, not a
controller bug: the two-Company harness's `extraCompanyTags: ['sales']`
alone does not provision `Customer.creditLimit`/`paymentTermsDays`/
`accountType`/`financialStatus` — those columns are added by a
`finance`-tagged migration (`AddCustomerFinancialCore`). Fixed by adding
`'finance'` to this test's own `extraCompanyTags`; no code or migration
changed.

### §20.3 — Build/lint/regression (CLOSED)

`npm run build` clean. Lint clean
(`customers.controller.ts`/`customers.service.ts`/`crm.module.ts`/
`limit.service.ts`/the new spec file). `company-entity-registry.completeness.spec.ts`
re-run, 2/2 passing (no new entities needed — Customer/CustomerAssignment
were already registered during the Sales Orders pass, §16.1).

**Full regression result: 88 test suites, 86 passed outright, 562/562
individual tests passed.** 2 suites
(`area14-company-audit.real-pg.spec.ts`,
`company-datasource-factory-impact.characterization.spec.ts`) failed to
*run* (not a failed assertion) on the same
`QueryFailedError: permission denied to terminate process` teardown race
already documented in §19/prior runs, unrelated to this controller's own
code. **Confirmed via isolated re-run**: both pass cleanly on their own
(14/14 tests). **Combined total: 576/576 tests passing, zero real
regressions.**

**`customers.controller.ts` is now CLOSED** per the required
`CODE → BUILD → REAL-PG ISOLATION → FULL REGRESSION → DOCUMENT`
sequence. This completes the CTO's 3-controller batch
(products → price-lists → customers), all three CLOSED.

### §20.4 — What changed, file by file

`customers.controller.ts` (class-level `CompanyContextGuard` added
alongside the existing `JwtAuthGuard`/`RequireModuleGuard`, all 12 routes
updated to inject `CompanyScopedRequest` and thread
`req.companyContext.dataSource.manager`), `customers.service.ts` (13
methods gained `manager?:`), `crm.module.ts` (+`CompanyModule`,
+`DatabaseRegistryModule`), `limit.service.ts` (`check()` gained
`manager?:`, matching `consume()`/`release()`), 1 new test file. Zero
changes to any entity, zero new `companyId` column, zero change to
`CompanyContextGuard`/`CompanyConnectionManagerService`/Company
provisioning.

**This closes the CTO's originally-named 3-controller batch
(products → price-lists → customers).** Next: pick the 4th controller
dependency-first from the remaining Tier 1 set — several now benefit
from the same shared-service fixes made across these three passes
(`ScopeService`, `AuthorizationService`, `NumberingService`,
`LimitService`, `ProductsService`, `PriceListsService`, `CustomersService`
are all now manager-capable), so the next candidate should be chosen by
which remaining controller reuses the MOST of this already-fixed
foundation, per the same dependency-order reasoning that picked this
batch in the first place — one controller at a time, no batching, per
standing instruction.

## §21 — `inventory.controller.ts` retrofit (2026-09-27, 4th controller, dependency-first pick)

Picked as the 4th controller, dependency-first: `InventoryService.getWarehouse`/
`confirmReservationsForOrder` were already made manager-capable during
the Sales Orders pass (§16.0), and §1.2's own Tier 1 table lists
`InventoryService`✓ against this controller's route. This is the
LARGEST controller retrofitted so far (18 HTTP-reachable service
methods, vs. 8-14 for the first three) — the CTO's own §16.0 correction
("Tier 1 does not mean minimal work") applied here more than anywhere
else yet.

### §21.0 — Call graph / manager-capability audit

18 controller-reachable `InventoryService` methods audited and given
`manager?: EntityManager`: `createWarehouse`, `listWarehouses`,
`setWarehouseStatus`, `importWarehouseRows`, `importOpeningStockRows`,
`getMovement`, `listMovements`, `getStockReport`,
`getWarehouseInventoryPage`, `getOnHand`, `getReserved`, `getAvailable`,
`reserveStock`, `getActiveReservationsForOrder`, `releaseReservation`,
`assembleProduct`. `getWarehouse`/`confirmReservationsForOrder` were
already manager-capable (§16.0). `recordMovement` was already fully
manager-capable (a prior, unrelated fix) — only the controller's own
call site needed to start passing a manager. `getOnHandQuantityInTransaction`/
`getAvailableInTransaction`/`reserveStockInTransaction`/
`reserveStockForReferenceInTransaction`/
`releaseReservationForOrderProductInTransaction`/
`adjustReservationQuantityInTransaction`/`releasePreliminaryHoldsForOrder`/
`findExpiredPreliminaryHoldOrderIds`/`findOperationalSubLocation`/
`relocateReservedStock`/`fulfillReservation`/`fulfillReservationsForOrder`/
`releaseReservedQuantity`/`releaseReservedQuantityForReference`/
`getActiveReservationsForReference`/`getTotalAvailable` are NOT reachable
from this controller (Sales Orders/Manufacturing/Shipment/Fulfillment/
Returns internals or external integrations) — correctly left untouched,
per the standing rule not to reach past this controller's own boundary;
several were already manager-capable from earlier passes regardless.

**One real, pre-existing gap fixed in passing**: `fulfillReservationsForOrder`'s
own transaction manager `m` was never threaded into its own
`getActiveReservationsForOrder(salesOrderId)` call — a bug that predates
Area 21 entirely (that method had NO manager parameter at all until this
pass), now closed as a direct consequence of adding `manager?` to
`getActiveReservationsForOrder` and reviewing every existing call site
per the CTO's "do not stop at the controller boundary" rule.

### §21.1 — New gap found and fixed: `SalesBomContract`/`SalesProductsContract` interfaces didn't expose `manager?`

`assembleProduct` calls `this.bom.getBomForAssembly(finishedProductId)` —
a cross-domain contract call (`SalesBomContract`, resolved via DI token,
per ADR-027's module-decoupling pattern). The CONCRETE `BomService` had
no `manager?` param at all (a genuinely new gap, not previously touched
by any earlier Area 21 pass) — fixed by adding it, matching
`ProductsService.getProductSnapshot`'s exact precedent. But a second,
more subtle gap surfaced immediately: even after fixing the concrete
class, the PUBLISHED INTERFACES (`SalesBomContract.getBomForAssembly`,
`SalesProductsContract.getProductSnapshot`/`getProductSnapshotBySku`,
used directly by `inventory.controller.ts`'s own `productLabel` helper
and by `InventoryService.importOpeningStockRows`) still declared the
OLD, narrower signature with no `manager` parameter — TypeScript
structural typing meant a caller typed against the contract (not the
concrete class) could not pass `manager` through even though the
concrete implementation now accepted it. **Fixed**: widened all three
interface methods in `sales.contract.ts` to accept `manager?: EntityManager`,
matching their concrete implementations exactly. `BillOfMaterial`/
`BomComponent` were also newly added to `commerce-company-entities.ts`
(previously deliberately excluded there, per that file's own prior doc
comment, pending exactly this moment).

**This is a new class of gap for this Matrix to track**: a cross-domain
contract interface can silently lag behind its own concrete
implementation's manager-capability, since TypeScript's structural
typing lets a WIDER concrete signature satisfy a NARROWER published
interface without any compile error — the gap only surfaces when a
caller actually tries to pass the extra argument through the interface
type. Recommend checking every remaining Tier 1/Tier 2 controller that
crosses one of `module-registry/contracts/*.ts`'s published seams for
this same class of drift before assuming the concrete service being
manager-capable is sufficient.

### §21.2 — Real-Postgres verification

New test: [`inventory.company-isolation.spec.ts`](../../src/domains/inventory-warehouse/interface/inventory.company-isolation.spec.ts) —
two real Company databases, each seeded with its own warehouse, product,
a receipt movement (on-hand 100), and an active reservation (30), via
direct raw-SQL inserts. Covers `listWarehouses` (each Company sees only
its own), `getAvailable` (the correct 100-30=70 figure per Company, and
a cross-Company lookup correctly resolves to 0 — the rows genuinely
don't exist in the other Company's own database), `getActiveReservationsForOrder`
(Company-scoped), `recordMovement` (a real write, verified via that same
Company's own subsequent `getOnHand` — 100+15=115 — while the OTHER
Company's on-hand for its own warehouse/product stays untouched at 100),
and Test F (`assertDataSourceNeverRequestedFor`). This is also the FIRST
Area 21 isolation test to exercise a real `AuditService` write (previous
tests only exercised read paths) — constructed for real
(`new AuditService(h.controlPlane)`) since `recordMovement` genuinely
calls `audit.record(...)`. **7/7 passing, first run, no fixture
corrections needed.**

### §21.3 — Build/lint/regression (CLOSED)

`npm run build` clean throughout. Lint clean on every touched file
(`inventory.controller.ts`, `inventory.service.ts`,
`inventory-warehouse.module.ts`, `bom.service.ts`,
`commerce-company-entities.ts`, `sales.contract.ts`, the new spec file).
`company-entity-registry.completeness.spec.ts` re-run, 2/2 passing
(confirms `BillOfMaterial`/`BomComponent`'s new registration is
complete and non-duplicate).

**Full regression result: 89 test suites, 88 passed outright, 569/569
individual tests passed.** 1 suite
(`products.company-isolation.spec.ts`) failed to *run* (not a failed
assertion) on the same `QueryFailedError: permission denied to
terminate process` teardown race already documented in §19/§20 — this
time in ITS OWN teardown, not this controller's new test, and unrelated
to any code changed in this pass. **Confirmed via isolated re-run**:
passes cleanly on its own (4/4 tests). **Combined total: 573/573 tests
passing, zero real regressions.**

**`inventory.controller.ts` is now CLOSED** per the required
`CODE → BUILD → REAL-PG ISOLATION → FULL REGRESSION → DOCUMENT`
sequence — the 4th controller closed, first one picked independently
(dependency-first) rather than from the CTO's original named batch.

### §21.4 — What changed, file by file

`inventory.controller.ts` (class-level `CompanyContextGuard` added, all
18 routes updated to inject `CompanyScopedRequest` and thread
`req.companyContext.dataSource.manager`, including the two private
helpers `buildNameMaps`/`productLabel` which now take an explicit
`EntityManager` parameter), `inventory.service.ts` (16 methods gained
`manager?:`, plus one pre-existing internal-threading bug fixed in
`fulfillReservationsForOrder`), `inventory-warehouse.module.ts`
(+`CompanyModule`, +`DatabaseRegistryModule`), `bom.service.ts`
(`getBomForAssembly` gained `manager?:`), `sales.contract.ts`
(`SalesBomContract`/`SalesProductsContract` widened to publish
`manager?:` on all 3 methods), `commerce-company-entities.ts`
(+`BillOfMaterial`, +`BomComponent`), 1 new test file. Zero changes to
any entity's own columns, zero new `companyId` column, zero change to
`CompanyContextGuard`/`CompanyConnectionManagerService`/Company
provisioning. `WarehouseTransactionsController` (Tier 2, same module)
was NOT touched — its own retrofit is a separate future turn.

## §22 — `inventory-valuation.controller.ts` retrofit (2026-09-27, 5th controller, dependency-first pick)

Picked because `InventoryValuationService.getUnitCost` (and the
`MovingAverageCostEngine.resolveIssueCost` it delegates to) were already
FULLY `manager?`-capable before this pass — confirmed directly while
retrofitting §21's `assembleProduct`, which already threads a manager
into this exact same method via the `INVENTORY_VALUATION_CONTRACT`
token. The smallest controller in the 43: exactly ONE route, ONE service
call, no writes at all (F08 explicitly submits nothing itself — ADR-041
D11/D21).

### §22.0 — Call graph / manager-capability audit

`currentCost` → `InventoryValuationService.getUnitCost(productId,
warehouseId, _asOfDate?, manager?)` → `MovingAverageCostEngine.resolveIssueCost(...,
manager?)` — both already accepted `manager?` with zero changes needed.
`InventoryValuationState`/`InventoryValuationMovement` were already
registered in `inventory-valuation-company-entities.ts` (pre-existing,
ADR-074). **This controller needed zero service-layer changes at all** —
only the guard + module wiring + one call-site update passing the
manager through.

### §22.1 — No new gaps found

Unlike every controller retrofitted so far in this workstream, this pass
found no new manager-capability gap, no contract-interface drift, and no
missing entity registration — the smallest possible retrofit shape,
confirming the "reuse already-fixed foundations" dependency-first
strategy pays off as intended once enough shared services are already
manager-capable.

### §22.2 — Real-Postgres verification

New test: [`inventory-valuation.company-isolation.spec.ts`](../../src/domains/inventory-valuation/interface/inventory-valuation.company-isolation.spec.ts) —
two real Company databases, each seeded with its own
`inventory_valuation_state` row (different average costs: 12.5000 vs.
99.0000) via direct raw-SQL insert. Covers `getUnitCost` resolving each
Company's own cost, a cross-Company lookup correctly resolving `null`
(the row genuinely doesn't exist in the other Company's own database —
not a leaked value, not an error), and Test F
(`assertDataSourceNeverRequestedFor`). One infrastructure-only finding,
not a controller bug: `extraCompanyTags: ['inventory']` alone failed
migration with `relation "products" does not exist` (some `inventory`-tagged
migration has a dependency reaching into the `sales`-tagged `products`
table) — fixed by adding `'sales'` alongside `'inventory'`, matching
`inventory.controller.ts`'s own test tags. **4/4 passing.**

### §22.3 — Build/lint/regression (CLOSED)

`npm run build` clean. Lint clean
(`inventory-valuation.controller.ts`/`inventory-valuation.module.ts`/the
new spec file). `company-entity-registry.completeness.spec.ts` re-run,
2/2 passing (no new entities needed).

**Full regression result: 90 test suites, 87 passed outright, 573/573
individual tests passed.** 3 suites
(`inventory.company-isolation.spec.ts`,
`database-provisioning.service.spec.ts`,
`company-membership-provisioning.real-pg.spec.ts`) failed to *run* (not
a failed assertion) on the same teardown race documented in §19-§21,
none involving any code touched by this pass. **Confirmed via fully
isolated re-run** (one suite per process, since running the 3 together
still showed 2/3 racing against each other): all 3 pass cleanly on
their own (7 + 4 + already-confirmed passing tests). **Zero real
regressions.**

**`inventory-valuation.controller.ts` is now CLOSED** per the required
`CODE → BUILD → REAL-PG ISOLATION → FULL REGRESSION → DOCUMENT`
sequence — the 6th controller closed (37 remaining of the 43).

### §22.4 — What changed, file by file

`inventory-valuation.controller.ts` (class-level `CompanyContextGuard`
added, the one route updated to inject `CompanyScopedRequest` and thread
`req.companyContext.dataSource.manager`), `inventory-valuation.module.ts`
(+`CompanyModule`, +`DatabaseRegistryModule`), 1 new test file. Zero
service-layer changes, zero entity changes, zero change to
`CompanyContextGuard`/`CompanyConnectionManagerService`/Company
provisioning.

## §23 — `returns.controller.ts` — STOP/ESCALATE, not retrofitted this turn (2026-09-27, evidence only, zero code changed)

Attempted as the 7th controller (§1.2 lists it Tier 1, "`ReturnsService`✓
fully capable"). Full transitive call-graph read found this label is
**overstated in the same way §16.0 already corrected for Sales
Orders** — but here the gap reaches OUTSIDE this controller's own
domain into three others that have not yet had their own Area 21 turn.
Per the CTO's own STOP CHANGE → RECORD EVIDENCE → CLASSIFY → ESCALATE
protocol for new discoveries, and the explicit "do not batch multiple
controllers into one unverified change set" instruction — a partial
retrofit leaving 2 of 18 routes still ambient-scoped would be a false
"CLOSED" claim, so **no code was changed for this controller this
turn**.

### §23.0 — What IS safely fixable in-scope (would need no cross-domain escalation)

- `ReturnsService`'s own 16 non-custody, non-invoice-credit HTTP-reachable
  methods would need `manager?:` added — ordinary, same shape as every
  prior controller.
- **New same-class contract-drift gap, confirmed exactly matching
  §21.1's prediction**: `SalesOrdersReadContract.getOrder`/
  `getOrderSnapshot`/`getOrderLineById`/`getOrderStatus` publish NO
  `manager?` parameter, even though the CONCRETE `SalesOrdersService`
  methods have been manager-capable since §16. Same fix shape as §21.1
  (widen the interface only).
- `InventoryLogisticsContract.createWarehouse` publishes NO `manager?`
  either (concrete `InventoryService.createWarehouse` gained it in
  §21) — same interface-widening fix. (`listWarehouses`/`getStockReport`/
  `getActiveReservationsForOrder` on this SAME contract are also stale
  for the same reason, though not on Returns's own call path — noted for
  whichever controller reaches them first.)
- `InventoryService.findOperationalSubLocation` has **no `manager?` at
  all yet, on the CONCRETE class** (confirmed by direct read, §21 did
  not touch this method) — a genuine, same-domain, Inventory-owned gap,
  safe to fix in Inventory's own files same as `getBomForAssembly` was
  in §21.1.
- `FinanceInvoiceContract.recomputeStatus` publishes no `manager?`
  (concrete `InvoiceService.recomputeStatus` already has it) —
  interface-widening only.

### §23.1 — What is NOT safely fixable without touching another domain's own future turn

- **`ShipmentService.getStatus`/`getShipmentSnapshot`/
  `getCurrentCustodyWarehouseId`/`recordCustodyReversal`** — confirmed
  by direct read: **zero** `manager?` capability, not interface drift,
  a real concrete-class gap. All 4 are called by `initiateCustodyReturn`
  (the Phase B pre-delivery custody-return path). `shipment.controller.ts`
  is itself still an un-retrofitted Tier 1 controller (§1.2) — fixing
  these here would mean doing part of Shipment's own retrofit inside
  Returns's turn.
- **`DeliveryService.getCollectionForShipmentUnscoped`** — same
  finding, zero `manager?` capability, also only reached by
  `initiateCustodyReturn`.
- **`InvoiceService.getInvoice`** — same finding, zero `manager?`
  capability (unlike its sibling `recomputeStatus`, already fixed).
  Reached only by `applyCreditToInvoice`.

**Practical implication for sequencing**: `invoices.controller.ts`
(Tier 1) and `shipment.controller.ts` (Tier 1) each own one of these
exact gaps as part of their OWN legitimate retrofit scope. Doing either
of those next resolves the corresponding blocker for Returns as a
natural side effect — the same "shared-foundation reuse" dependency
ordering already validated in §16.0/§20's closing note, just discovered
from the consuming side this time instead of the providing side.
**Recommendation, not yet acted on**: retrofit `invoices.controller.ts`
next (also closes the `FinanceInvoiceContract` widening from §23.0 as
part of the same turn), then `shipment.controller.ts`, then return to
`returns.controller.ts` as a clean, fully in-scope retrofit with zero
remaining cross-domain blockers.

**Correction (same session, minutes later)**: `invoices.controller.ts`
was attempted next per this recommendation and found to have the exact
same blocking shape — see §24 immediately below. `accounting.TaxEngineService`
is now added to the list of un-retrofitted domains a "Tier 1" controller
can silently depend on.

## §24 — `invoices.controller.ts` — STOP/ESCALATE, not retrofitted this turn (2026-09-27, evidence only, zero code changed)

Attempted immediately after §23, per that section's own recommendation.
Full call-graph read found: `createDraftInvoice`/`postInvoice`/`voidInvoice`
(3 of 10 routes, but the controller's core write paths) all call
`TaxEngineContract.calculateForInvoice`/`resolveTaxAccountCode` →
concrete `TaxEngineService` (owned by `accounting`, a domain with its own
un-retrofitted Tier 1/Tier 2 controllers, `accounting.controller.ts`/
`general-ledger.controller.ts` among them) — confirmed by direct read:
**zero** `manager?` capability, reads `TaxCode` via the ambient
`this.dataSource` unconditionally. Same STOP/ESCALATE shape as §23; no
code changed.

**What WOULD be safely in-scope for this controller's own future
turn** (recorded for whoever picks it up next): `CustomerLedgerService.postEntry`/
`getCustomerBalance`/`sweepUnappliedFor` already manager-capable;
`CustomerLedgerService.reverseEntry` needs `manager?` added (same-domain,
customer-finance's own file, small); `SalesOrdersReadContract`/
`SalesCustomersContract` need the same interface widening §23.0 already
identified (now doubly-motivated — both Returns AND Invoices need it).

## §25 — `customer-ledger.controller.ts` retrofit (2026-09-27, 7th controller — the clean pick after two STOP/ESCALATEs)

Picked after §23/§24 both blocked on un-retrofitted domains
(Shipment/Delivery/Invoice, then Accounting's TaxEngineService).
`customer-ledger.controller.ts` shares `customer-finance` with the
blocked Invoices controller, but its own 3 routes never touch tax,
invoicing, or any other blocked path — verified by direct read of
`CustomerLedgerService`'s full file before starting, per the CTO's own
required step 1 ("read the complete transitive service call graph"
FIRST, not after starting to code).

### §25.0 — Call graph / manager-capability audit

All 3 controller-reachable `CustomerLedgerService` methods audited:
`getCreditSummary`, `listLedger`, `getBalancesForVisibleCustomers`, plus
the private `getOverdueAmount` it calls — all 4 gained `manager?:`.
`getCustomerBalance`/`sweepUnappliedFor` were already manager-capable
(pre-existing, "Multi-Company Area 9" per that method's own doc comment
— predates this session's Area 21 work). `reverseEntry` is NOT
controller-reachable (called only from `InvoiceService.voidInvoice`) —
correctly left for Invoices' own future turn (§24).

### §25.1 — Same-class contract-drift gap, resolved (predicted in §23.0/§24)

`SalesCustomersContract.getCustomer`/`listCustomers`/`getCreditLimit`
published NO `manager?` — the concrete `CustomersService.getCustomer`/
`listCustomers` already had it (§16/§20); `getCreditLimit` did not (a
genuine concrete gap, not just interface drift — confirmed by direct
read, §20.0 had explicitly deferred this exact method to "whichever
controller reaches it next"). **Fixed**: `getCreditLimit` gained
`manager?:` in `customers.service.ts` (CRM's own file — same-domain,
safe), and all 3 interface methods widened in `sales.contract.ts`. This
closes one of the two contract-widening items §23.0/§24 flagged as
needed for Returns/Invoices too — their own future turns benefit from
this for free, same "shared foundation reuse" pattern as §16.0/§20.

### §25.2 — Real-Postgres verification

New test: [`customer-ledger.company-isolation.spec.ts`](../../src/domains/customer-finance/interface/customer-ledger.company-isolation.spec.ts) —
two real Company databases, each with its own distinct customer
(different `creditLimit`) and one ledger entry (different amount), via
direct raw-SQL insert. The test actor is seeded with the `admin` role
per-Company (same `REVIEWER_ROLES`-bypass pattern as
`customers.company-isolation.spec.ts`) since `getBalancesForVisibleCustomers`
genuinely calls `CustomersService.listCustomers`. Covers `getCreditSummary`
(each Company's own balance AND credit limit, proving the cross-domain
`SalesCustomersContract.getCreditLimit` call threads correctly),
`listLedger` (Company-scoped), `getBalancesForVisibleCustomers`
(Company-scoped via the nested Scope/Authorization call), and Test F
(`assertDataSourceNeverRequestedFor`). **5/5 passing, first run.**

### §25.3 — Build/lint/regression (CLOSED)

`npm run build` clean. Lint clean on every touched file
(`customer-ledger.controller.ts`, `customer-ledger.service.ts`,
`customer-finance.module.ts`, `customers.service.ts`, `sales.contract.ts`,
the new spec file). `company-entity-registry.completeness.spec.ts`
re-run, 2/2 passing (no new entities needed — `Customer`/
`CustomerLedgerEntry` were already registered before this session's Area
21 work).

**Full regression result: 91 test suites, 88 passed outright, 578/578
individual tests passed.** 3 suites
(`inventory-valuation.company-isolation.spec.ts`,
`products.company-isolation.spec.ts`,
`two-company-real-pg-harness.spec.ts`) failed to *run* — the same
teardown race documented in §19-§22, none involving code touched by
this pass. **Confirmed via isolated re-run**: all 3 pass cleanly on
their own (4/4, 4/4, 9/9). One of the 3
(`two-company-real-pg-harness.spec.ts`) needed a SECOND isolated attempt
to pass clean — its first isolated re-run still failed, traced to real
Postgres connection-pool contention from an accidentally-still-running
duplicate full-regression process in the background (a session-continuity
artifact, not a code issue) rather than the usual teardown race; once
that duplicate process was accounted for, the suite passed 9/9. **Zero
real regressions.**

**`customer-ledger.controller.ts` is now CLOSED** per the required
`CODE → BUILD → REAL-PG ISOLATION → FULL REGRESSION → DOCUMENT`
sequence — the 7th controller closed (36 remaining of the 43, plus 2
STOP/ESCALATE findings recorded for `returns.controller.ts`/
`invoices.controller.ts` awaiting their blocking domains' own turns).

### §25.4 — What changed, file by file

`customer-ledger.controller.ts` (class-level `CompanyContextGuard`
added, all 3 routes updated to inject `CompanyScopedRequest` and thread
`req.companyContext.dataSource.manager`), `customer-ledger.service.ts`
(4 methods gained `manager?:`), `customer-finance.module.ts`
(+`CompanyModule`, +`DatabaseRegistryModule` — `InvoicesController`/
`PaymentsController`, also in this module, are NOT yet retrofitted and
were not touched), `customers.service.ts` (`getCreditLimit` gained
`manager?:`), `sales.contract.ts` (`SalesCustomersContract` widened, 3
methods), 1 new test file. Zero changes to any entity, zero new
`companyId` column, zero change to `CompanyContextGuard`/
`CompanyConnectionManagerService`/Company provisioning.

## §26 — `shipment.controller.ts` — STOP/ESCALATE, not retrofitted this turn (2026-09-27, evidence only, zero code changed)

Attempted next specifically BECAUSE §23 named it as the controller that
would resolve Returns's own custody-return blocker. Full call-graph read
(25 controller-reachable `ShipmentService` methods, only 1 —
`transitionShipment` — already `manager?`-capable) found this is the
**largest cross-cutting dependency surface found in the 43 so far**,
worse than Returns or Invoices: `ShipmentService`'s constructor injects
6 cross-domain dependencies, and TWO of them are concrete services with
**zero** `manager?` capability, confirmed by direct read:

- **`TreasuryService.listAccountTypes`/`createAccount`**
  (`FinanceTreasuryContract`) — `treasury.controller.ts` is itself a
  separate, un-retrofitted Tier 1 controller (§1.2). (`getAccountBalance`
  on the same contract is already capable — interface-only drift there.)
- **`FulfillmentService.getFulfillmentOrder`/`getFulfillmentOrderBySalesOrderId`**
  — Fulfillment has no controller of its own in the 43's list at all
  (internal-only service), so there is no future "Fulfillment's own
  turn" to defer this to the way Shipment/Invoice can defer to
  `shipment.controller.ts`/`invoices.controller.ts` — this gap can ONLY
  ever be fixed from a consumer's turn (Shipment's, Returns's, or
  whoever else calls it).

Plus the already-known, now THIRD confirmation of the same interface-drift
pattern: `InventoryLogisticsContract.createWarehouse`/`listWarehouses`/
`getStockReport`/`getActiveReservationsForOrder` and
`SalesOrdersReadContract`/`SalesCustomersContract.findByCode` all lack
published `manager?` despite (mostly) capable concrete classes. Per the
same STOP CHANGE → RECORD EVIDENCE → CLASSIFY → ESCALATE protocol as
§23/§24: **no code changed for this controller this turn.**

**Note for whoever picks up `treasury.controller.ts` next**: fixing
`TreasuryService.listAccountTypes`/`createAccount` there directly
resolves one of Shipment's two concrete blockers. The `FulfillmentService`
gap has no equivalent natural home — it will need to be fixed as a
same-turn side-fix by whichever controller (Shipment, Returns, or
another) reaches it first, similar in shape to `BomService`/
`findOperationalSubLocation` in §21, just in a domain with no controller
of its own to eventually "own" the fix.

**§26 update (2026-09-27, later same session) — both concrete blockers
now closed, zero controller work involved:** §28 (`treasury.controller.ts`)
closed the Treasury half. The `FulfillmentService` half was ALSO closed
directly, independent of any controller's own turn, since (per the note
above) it has no controller of its own to ever own the fix:
`getFulfillmentOrder`/`getFulfillmentOrderBySalesOrderId` gained
`manager?:` (2-line mechanical change, `dataSource` → `(manager ?? this.dataSource)`,
identical shape to every other such fix this session), and
`FulfillmentContract` (`inventory.contract.ts`) widened to match. Build
clean, lint clean. **Not exercised by a dedicated isolation test** — this
fix has no controller of its own to close, so it will be proven end-to-end
when `shipment.controller.ts`'s own future turn writes its isolation test
(which will call `createShipment`/`assignShippingRoute`, both reaching
this contract). Confirmed via the next full regression run (§29) that
zero existing test broke. **`shipment.controller.ts` now has ZERO
remaining concrete-service blockers** — only the `SalesOrdersReadContract`/
`InventoryLogisticsContract` interface-widening items from §26's own
evidence list remain, both trivial (concrete classes already capable).

**§26 correction (2026-09-27/28, discovered while scoping `supplier.controller.ts`,
§30): this section's repeated claim that "Fulfillment has no controller
of its own in the 43" was FACTUALLY WRONG.** `fulfillment.controller.ts`
(`src/domains/fulfillment/interface/fulfillment.controller.ts`) exists
and IS one of the Tier 2 30 (§1.2's own table lists it —
"`fulfillment.controller.ts` | `fulfillment` | `FulfillmentService`" —
this section simply failed to cross-check its own §1.2 table before
writing "no controller of its own," three separate times, above). The
mistake did not cause any incorrect CODE — fixing
`getFulfillmentOrder`/`getFulfillmentOrderBySalesOrderId` was still the
right, safe, mechanical call regardless of whose "turn" it technically
was — but the STATED REASONING for treating it as foundation-orphaned
work was wrong, and is corrected here per the standing discipline of
never leaving a known-wrong finding silently uncorrected. Practical
consequence: `fulfillment.controller.ts` now starts its own eventual
retrofit turn with 2 of its own methods already manager-capable, a head
start, not a gap — see §31 if/when it's picked up.

## §27 — `supplier-invoice.controller.ts` retrofit (2026-09-27, 8th controller — clean, zero cross-domain contracts)

Picked after §26. Full call-graph read of `SupplierInvoiceService`
found it has **zero cross-domain dependencies** — `DataSource`,
`SupplierLedgerService` (same `procurement` domain, already
manager-capable on its 3 relevant methods), `NumberingService`,
`ProcessEngineService`, `AuditService`, `EventBusService` — every one
already touched/capable from earlier passes in this session. The
cleanest retrofit since `inventory-valuation.controller.ts` (§22).

### §27.0 — Call graph / manager-capability audit

All 10 controller-reachable `SupplierInvoiceService` methods gained
`manager?:`: `createDraftInvoice`, `postInvoice`, `voidInvoice`,
`getInvoice`, `listForSupplier`, `listForPurchaseOrder`, `listAll`,
`computeAgingRow` (private), `getApAging`, `getApAgingForAllSuppliers`.
`getStatus`/`getInvoiceRemaining`/`recomputeStatus` were already
manager-capable (pre-existing). One same-domain concrete gap found and
fixed: `SupplierLedgerService.reverseEntry` had no `manager?` at all
(called from `voidInvoice`) — fixed identically to `postEntry`'s
existing pattern in the same file. `listLedger` on the same class was
also widened while there (not on this controller's own call path, but
cheap and consistent — it's `supplier.controller.ts`'s own future
concern).

### §27.1 — Real-Postgres verification

New test: [`supplier-invoice.company-isolation.spec.ts`](../../src/domains/procurement/interface/supplier-invoice.company-isolation.spec.ts) —
two real Company databases, each with its own distinct supplier,
purchase order, and supplier invoice, seeded directly via raw SQL
(including a real `process_instances` row at `'draft'`, since
`getStatus`/`getInvoiceRemaining` are genuinely exercised, not stubbed).
Covers `getInvoice` (Company-scoped, cross-Company lookup 404s — the row
genuinely doesn't exist in the other Company's own database),
`listAll`/`listForSupplier` (Company-scoped), and Test F
(`assertDataSourceNeverRequestedFor`). Two infrastructure-only findings
while building the fixture, neither a controller bug: (1) the harness's
`'procurement'` tag alone doesn't include the `'sales'`-tagged `products`
table a procurement migration depends on — fixed by adding `'sales'`;
(2) `PurchaseOrder`'s real column is `poNumber` (not `orderNumber`) and
it has a required, non-nullable `warehouseId` — fixed the seed SQL and
added the `'inventory'` tag for the `warehouses` table. **6/6 passing.**

### §27.2 — Build/lint/regression (CLOSED)

`npm run build` clean. Lint clean on every touched file
(`supplier-invoice.controller.ts`, `supplier-invoice.service.ts`,
`supplier-ledger.service.ts`, `procurement.module.ts`, the new spec
file). `company-entity-registry.completeness.spec.ts` re-run, 2/2
passing (no new entities needed — all 6 Procurement entities were
already registered before this session's Area 21 work).

**Full regression result: 92 test suites, 90 passed outright, 584/584
individual tests passed.** 2 suites
(`customers.company-isolation.spec.ts`,
`company-membership-provisioning.real-pg.spec.ts`) failed to *run* — the
same teardown race documented in §19-§26, none involving code touched
by this pass. **Confirmed via isolated re-run**: both pass cleanly
(6/6, and 5/5 on a second attempt after one more transient teardown hit
on the first). **Combined total: 595 tests confirmed passing, zero real
regressions.**

**`supplier-invoice.controller.ts` is now CLOSED** per the required
`CODE → BUILD → REAL-PG ISOLATION → FULL REGRESSION → DOCUMENT`
sequence — the 8th controller closed (35 remaining of the 43, plus 3
STOP/ESCALATE findings recorded for `returns.controller.ts`/
`invoices.controller.ts`/`shipment.controller.ts` awaiting their
blocking domains' own turns).

### §27.3 — What changed, file by file

`supplier-invoice.controller.ts` (class-level `CompanyContextGuard`
added, all 9 routes updated to inject `CompanyScopedRequest` and thread
`req.companyContext.dataSource.manager`), `supplier-invoice.service.ts`
(10 methods gained `manager?:`), `supplier-ledger.service.ts`
(`reverseEntry`/`listLedger` gained `manager?:`), `procurement.module.ts`
(+`CompanyModule`, +`DatabaseRegistryModule` — the other 6 controllers
in this module are NOT yet retrofitted and were not touched), 1 new test
file. Zero changes to any entity, zero new `companyId` column, zero
change to `CompanyContextGuard`/`CompanyConnectionManagerService`/Company
provisioning.

## §28 — `treasury.controller.ts` retrofit (2026-09-27, 9th controller — closes 2 of §26's blockers)

Picked specifically because §26 (`shipment.controller.ts` STOP/ESCALATE)
named `TreasuryService.listAccountTypes`/`createAccount` as one of
Shipment's two concrete blockers. Both are now manager-capable, closing
that blocker for whenever Shipment's own turn comes.

### §28.0 — Call graph / manager-capability audit

16 controller-reachable `TreasuryService` methods gained `manager?:`:
`createAccountType`, `getAccountType`, `createAccount`, `getAccount`,
`setAccountStatus`, `setAccountGlMapping`, `listAccountsWithBalances`,
`assertLedgerAccountAccess`, `assertTransactionAccess`, `cashInDirect`,
`cashOutDirect`, `transferDirect`, `reverseTransaction`, `listLedger`,
`listLedgerPage`. `getAccountBalance`/`cashIn`/`cashOut`/`cashOutForSupplier`/
`cashOutForEmployee`/`transfer`/`cashInCore`/`cashOutCore`/`transferCore`
were already manager-capable (pre-existing, several from earlier
Gap Resolution Packages predating this session).

**Two real, pre-existing gaps fixed in passing** (found by reading every
line these methods touch, not just their own signatures):
`cashInCore`/`cashOutCore`/`transferCore` each called their own
`getAccount(...)` without threading the ALREADY-AVAILABLE `manager`
parameter — the account existence/active check would have silently run
against the ambient connection even after every other part of this
retrofit was correct. `insertLeg` (the one place every ledger row is
actually written) called `this.numbering.getNextNumber(...)` the same
way — the transaction-number sequence would have drawn from the ambient
`numbering_sequences` table regardless of which Company's transaction it
was really part of. Both fixed by threading the manager/transaction
argument already sitting right there. `cashOutCore`'s own final
`audit.record(...)` call was also missing its `manager` argument (its
sibling `cashInCore` already had it) — fixed for consistency.

### §28.1 — Two foundation-level structural gaps found and fixed (same class as `ScopeService`, §16)

Reading `TreasuryService`'s `ScopeResolver` dependency (used by
`listAccountsWithBalances`/`assertLedgerAccountAccess`/
`assertTransactionAccess`) surfaced two services that were STILL
`@InjectRepository`-based — structurally incapable of Company-routing,
the exact same gap `ScopeService` had before its own §16 fix:

- **`OrganizationService`** (`foundation/organization/`) — backs
  `ScopeResolver`'s org-unit-branch/department derivation (ADR-031),
  consumed across `treasury`, `accounting`, and `hr` (confirmed by grep
  before touching anything). Rewritten from
  `@InjectRepository(OrgUnit)`/`@InjectRepository(OrgMembership)` to an
  injected `DataSource` + `manager?` on all 9 methods — the identical
  fix shape `ScopeService` received. `OrgUnit`/`OrgMembership` newly
  registered in `core-company-entities.ts` (they were never registered
  at all before this — each Company's own branch/department tree is
  genuinely Company-owned data).
- **`IdempotencyService`** (`foundation/error-contract/`) — used by
  `treasury.controller.ts`'s own cash-in/cash-out/transfer routes AND by
  `payments.controller.ts` (customer-finance, not yet retrofitted).
  Rewritten the same way; `IdempotencyRecord` newly registered in
  `core-company-entities.ts`. **This was a genuine cross-Company
  correctness risk, not just a missing optimization**: before this fix,
  the SAME `(scope, key)` idempotency pair submitted by two DIFFERENT
  Companies would have collided against the one shared ambient table —
  Company B's cash-in could have been silently treated as a replay of
  Company A's, returning Company A's cached response instead of
  executing. Proven fixed (not just compiled) by the real-Postgres test
  in §28.2 below.

Both fixes are foundation-level (like `ScopeService`/`NumberingService`/
`LimitService` before them) — consumed by domains (`accounting`, `hr`,
`payments`/`customer-finance`) that have NOT had their own Area 21 turn
yet, but fixing the shared service itself required zero changes to any
of those domains' own files and is backward-compatible by construction
(`manager?` is additive-optional throughout), consistent with the
precedent this Matrix has followed since §16.

### §28.2 — Real-Postgres verification

New test: [`treasury.company-isolation.spec.ts`](../../src/domains/treasury/interface/treasury.company-isolation.spec.ts) —
two real Company databases, each with its own distinct account type and
account (plus each Company's own migration-seeded default account
types/account, confirming per-Company seeding, not a leak). Constructs
`ScopeResolver` (`ScopeService` + `OrganizationService` +
`AuthorizationService`, ALL real) and `IdempotencyService` for real —
not stubbed — specifically to prove the two foundation fixes actually
route per-Company rather than merely compiling. Covers `listAccountTypes`
(Company-scoped), `cashInDirect` (a real ledger write, verified via that
same Company's own `getAccountBalance` afterwards while the other
Company's balance stays untouched), `listAccountsWithBalances`
(Company-scoped through the real `ScopeResolver` chain), **and the
sharpest proof in this pass**: the SAME idempotency `(scope, key)` pair
submitted for Company A and Company B produces two independent, real
cash-in legs (550.00 and 75.00 respectively) rather than Company B's
call being treated as a cached replay of Company A's — directly
demonstrating the `IdempotencyService` fix closes a real cross-Company
bug, not just a theoretical one. Plus Test F
(`assertDataSourceNeverRequestedFor`). **6/6 passing** (2 fixture
corrections needed for migration-seeded default account types/accounts,
same pattern as `customers`/`price-lists`/`treasury`'s own prior specs —
not controller bugs).

### §28.3 — Build/lint/regression (CLOSED)

`npm run build` clean throughout every incremental step (including
after the two foundation-level rewrites, confirming `gl-account.service.ts`/
`hr.service.ts`'s existing calls to `OrganizationService`/`ScopeResolver`
remain backward-compatible). Lint clean on every touched file
(`treasury.controller.ts`, `treasury.service.ts`, `treasury.module.ts`,
`organization.service.ts`, `scope-resolver.service.ts`,
`idempotency.service.ts`, `core-company-entities.ts`,
`finance.contract.ts`, the new spec file).
`company-entity-registry.completeness.spec.ts` re-run, 2/2 passing
(confirms `OrgUnit`/`OrgMembership`/`IdempotencyRecord`'s new
registration is complete and non-duplicate).

**Full regression result: 93 test suites, 92 passed outright, 590/590
individual tests passed.** 1 suite
(`inventory.company-isolation.spec.ts`) failed to *run* — the same
teardown race documented in §19-§27, unrelated to any code touched by
this pass (not even in a domain this pass touched). **Confirmed via
isolated re-run**: passes cleanly (7/7). **Combined total: 597 tests
confirmed passing, zero real regressions** — notably including every
existing `gl-account.service.ts`/`hr.service.ts` test, confirming the
two foundation-level rewrites (`OrganizationService`/`IdempotencyService`)
introduced zero behavioral change for their other, not-yet-retrofitted
consumers.

**`treasury.controller.ts` is now CLOSED** per the required
`CODE → BUILD → REAL-PG ISOLATION → FULL REGRESSION → DOCUMENT`
sequence — the 9th controller closed (34 remaining of the 43, plus 3
STOP/ESCALATE findings recorded for `returns.controller.ts`/
`invoices.controller.ts`/`shipment.controller.ts`, one of which
(`shipment.controller.ts`'s Treasury half) is now resolved as a side
effect of this turn).

### §28.4 — What changed, file by file

`treasury.controller.ts` (class-level `CompanyContextGuard` added, all
14 routes updated to inject `CompanyScopedRequest` and thread
`req.companyContext.dataSource.manager`), `treasury.service.ts` (15
methods gained `manager?:`, plus 3 pre-existing internal-threading bugs
fixed), `treasury.module.ts` (+`CompanyModule`, +`DatabaseRegistryModule`),
`organization.service.ts` (full rewrite: `@InjectRepository` →
`DataSource`, `manager?` on all 9 methods), `scope-resolver.service.ts`
(`manager?` threaded through all 3 public methods + the private
`isUnrestricted`/`accessibleOrgUnitIds` helpers), `idempotency.service.ts`
(full rewrite: `@InjectRepository` → `DataSource`, `manager?` added to
both `withIdempotency`/`withIdempotencyInTransaction`), `core-company-entities.ts`
(+`OrgUnit`, +`OrgMembership`, +`IdempotencyRecord`), `finance.contract.ts`
(`FinanceTreasuryContract.createAccount`/`listAccountTypes`/
`getAccountBalance` widened to publish `manager?:`), 1 new test file.
Zero changes to any entity's own columns, zero new `companyId` column,
zero change to `CompanyContextGuard`/`CompanyConnectionManagerService`/
Company provisioning.

## §29 — `shipment.controller.ts` retrofit (2026-09-27, 10th controller — the STOP/ESCALATE from §26, now closed)

Re-attempted after §28 (Treasury) and the §26-update (Fulfillment) closed
both of this controller's concrete-service blockers, leaving only known-
trivial interface-widening items. **This is the largest single-controller
retrofit in the 43** — 25 controller-reachable `ShipmentService` methods
(vs. 18 for Inventory, §21, the previous largest), across a
1400-line service file with 6 injected cross-domain dependencies.

### §29.0 — Remaining blockers closed before starting

Per §26/§26-update's own evidence list, three more interface-widening
items were closed in the same pass, before touching `ShipmentService`
itself:

- `SalesOrdersReadContract.getOrder`/`getOrderLines`/`getOrderSnapshot`/
  `getOrderLineById`/`getOrderStatus` — widened to publish `manager?:`
  (concrete `SalesOrdersService` already capable since §16).
- `InventoryLogisticsContract.createWarehouse`/`listWarehouses`/
  `getStockReport`/`getActiveReservationsForOrder`/
  `findOperationalSubLocation` — widened to publish `manager?:` (concrete
  `InventoryService` already capable since §21, EXCEPT
  `findOperationalSubLocation`, which had **zero** manager capability at
  the concrete level too — fixed in the same pass, a genuine gap not
  just interface drift).
- `SalesCustomersContract.getCustomerSnapshot`/`findByCode` — widened to
  publish `manager?:`. `getCustomerSnapshot`'s concrete method was
  already capable; `findByCode`'s was NOT (another genuine concrete gap,
  fixed in `customers.service.ts` — same-domain CRM fix, matching the
  `getCreditLimit` precedent from §25.1).

All three are foundation-level contract/CRM fixes, zero changes to any
domain this controller doesn't own.

### §29.1 — Call graph / manager-capability audit

25 controller-reachable `ShipmentService` methods gained `manager?:`:
`createShipment`, `getShipmentBySalesOrderId`, `assignDriver`,
`assignShippingRoute`, `setCarrierWaybill`, `assertDriverOrAdmin`,
`assertCanReadShipment` (private), `transitionShipment` (already had
`manager?`, but 3 internal calls it never threaded — see §29.2),
`listShipments`, `enrichForBoard` (private), `listShipmentsPage`,
`getShipmentByFulfillmentOrderId`, `getShipment`, `getShipmentDetail`,
`getShipmentSnapshot`, `getTrackingHistory` (already capable),
`getStatus`, `createShippingCompany`, `updateShippingCompany`,
`listShippingCompanies`, `getShippingCompany`,
`setShippingCompanyTreasuryAccount`, `setShippingCompanyStatus`,
`createVehicle`, `listVehicles`, `getVehicle`, `updateVehicle`,
`setVehicleDriver`, `setVehicleStatus`, `setVehicleSettlementAccount`,
`getCustodianOverview`, `resolveCustodyWarehouseId` (private),
`getCurrentCustodyWarehouseId`, `transferCustodyOnPickup` (private, see
§29.2), `recordCustodyReversal`, `searchCustodyShipments`. Plus 3
private provisioning helpers: `getCustodyAccountTypeId`,
`resolveParentWarehouseId`, `provisionCustodianResources`.
`getShipmentLinesSnapshot` is NOT controller-reachable (Returns's own
cross-domain read) — correctly left for that consumer's own concern,
same standing rule as every prior controller.

### §29.2 — A deliberate PRE-Area-21 design decision reversed, with full justification recorded

`transitionShipment`'s own doc comment previously said `manager` was
deliberately NOT threaded into `transferCustodyOnPickup` (the `pickup`
action's custody-transfer branch) — that was an **atomicity** decision
(Gap Resolution Package 3, 2026-09-14): no caller combined a supplied
`manager` with `action === 'pickup'` at the time, so it was left out of
that package's scope. Area 21's requirement is different in kind — every
nested call must resolve the correct COMPANY regardless of atomicity
questions — so `transferCustodyOnPickup` (and the
`InventoryService.relocateReservedStock` call inside it, which already
accepted `manager?`) now both receive it, and the old doc comment was
rewritten to explain why the prior "not threaded" note no longer
applies. This is the first case in the Matrix so far of REVERSING a
pre-existing, deliberately-documented design decision rather than
filling in an untouched gap — flagged here explicitly rather than
silently changed.

### §29.3 — Real-Postgres verification

New test: [`shipment.company-isolation.spec.ts`](../../src/domains/shipment/interface/shipment.company-isolation.spec.ts) —
two real Company databases, each seeded with its own active 'main'
warehouse (required by `resolveParentWarehouseId`, not created by any
migration). `createShippingCompany` is the sharpest proof available:
constructs REAL `InventoryService`/`TreasuryService` instances (not
stubbed) and verifies the auto-provisioned Operational Sub-location
warehouse AND Custody treasury account are genuinely written into the
CORRECT Company's own database — directly exercising the exact
cross-domain chain (`ShipmentService` → `InventoryLogisticsContract`/
`FinanceTreasuryContract`) that §26 originally found blocked. Also
covers `listShippingCompanies` (Company-scoped) and Test F
(`assertDataSourceNeverRequestedFor`). One fixture correction needed
(not a controller bug): `createShippingCompany` requires an active
`'main'` warehouse to nest its sub-location under, which no migration
seeds — added directly to the harness setup. **5/5 passing.**

### §29.4 — Build/lint/regression (CLOSED)

`npm run build` clean (after fixing one real omission caught by the
build itself: `SalesCustomersContract.getCustomerSnapshot`'s interface
was widened for `getCreditLimit`/etc. in §25.1 but `getCustomerSnapshot`
itself was missed until this pass — 3 call sites in `shipment.service.ts`
surfaced it immediately). Lint clean on every touched file
(`shipment.controller.ts`, `shipment.service.ts`, `shipment.module.ts`,
`customers.service.ts`, `sales.contract.ts`, `inventory.contract.ts`,
`fulfillment.service.ts`, `inventory.service.ts`, the new spec file).
`company-entity-registry.completeness.spec.ts` re-run, 2/2 passing (no
new entities needed — Shipment's 5 entities were already registered
before this session's Area 21 work).

**Full regression result: 94 test suites, 90 passed outright, 595/595
individual tests passed.** 4 suites
(`supplier-invoice.company-isolation.spec.ts`,
`price-lists.company-isolation.spec.ts`,
`company-migration-runner.spec.ts`,
`database-provisioning.service.spec.ts`) failed to *run* — the same
teardown race documented in §19-§28, none involving code touched by
this pass (two are from previously-CLOSED controllers, confirming the
race is purely infrastructure, not a latent defect in earlier work).
**Confirmed via isolated re-run**: all 4 pass cleanly (6/6, 7/7, and
9/9 combined for the last two). **Combined total: 617 tests confirmed
passing, zero real regressions.**

**`shipment.controller.ts` is now CLOSED** per the required
`CODE → BUILD → REAL-PG ISOLATION → FULL REGRESSION → DOCUMENT`
sequence — the 10th controller closed (33 remaining of the 43, plus 2
STOP/ESCALATE findings still open for `returns.controller.ts`/
`invoices.controller.ts`, both now smaller than when first recorded).

### §29.5 — What changed, file by file

`shipment.controller.ts` (class-level `CompanyContextGuard` added, all
23 routes updated to inject `CompanyScopedRequest` and thread
`req.companyContext.dataSource.manager`), `shipment.service.ts` (25
methods gained `manager?:`, plus the §29.2 atomicity-vs-Company-routing
reversal), `shipment.module.ts` (+`CompanyModule`,
+`DatabaseRegistryModule`), `customers.service.ts` (`findByCode` gained
`manager?:` — a genuine concrete gap), `sales.contract.ts`
(`SalesOrdersReadContract` widened, 5 methods; `SalesCustomersContract.
getCustomerSnapshot`/`findByCode` widened), `inventory.contract.ts`
(`InventoryLogisticsContract` widened, 5 methods; `FulfillmentContract`
widened, 2 methods — carried over from the §26-update), `inventory.service.ts`
(`findOperationalSubLocation` gained `manager?:` — a genuine concrete
gap), 1 new test file. Zero changes to any entity, zero new `companyId`
column, zero change to `CompanyContextGuard`/
`CompanyConnectionManagerService`/Company provisioning.

**This closes the LAST of §26's originally-identified blockers.**
`returns.controller.ts` (§23) can now be revisited — its own remaining
blockers (`InvoiceService.getInvoice`, `DeliveryService.
getCollectionForShipmentUnscoped`) are unaffected by this pass and still
belong to `invoices.controller.ts`'s/Delivery's own future turns, but
its `ShipmentService`/`InventoryLogisticsContract` half is now fully
resolved.

## §30 — `supplier.controller.ts` — STOP/ESCALATE, not retrofitted this turn (2026-09-27, evidence only, zero code changed)

Attempted as the 11th controller (§1.2 lists it Tier 1, "`SupplierLedgerService`✓,
`SupplierService`✗" — the ledger half already fully manager-capable
since §27). Full call-graph read of `SupplierService` found a
**foundation-level blocker of a different character than any prior
STOP/ESCALATE**: `ApprovalEngineService` (bank-account-change approval
routing, ADR-033) has **zero** `manager?` capability on any of its
public methods (`submit`, `getRequest`, `decide`, `registerRequestType`,
etc.), confirmed by direct read — the exact same structural gap
`ScopeService`/`OrganizationService`/`IdempotencyService` had before
their own Area 21 fixes. Unlike those three, this one was **not**
fixed independently this turn, for two reasons:

1. **Blast radius**: grepped consumers span `accounting` (5 adjustment/
   disposal services), `attendance`, `commission`, `hr`, `payroll`,
   `procurement` (`rfq.service.ts` too, not just `supplier.service.ts`),
   and `targets` — by far the widest fan-out of any foundation service
   touched so far in this Matrix (wider than Organization/Idempotency
   combined).
2. **`approval.controller.ts` is one of the 5 Mixed/Special surfaces
   explicitly excluded from this authorization** ("separate decision
   gate," per the CTO's own directive). `ApprovalEngineService` is that
   controller's own underlying service. Fixing the service's
   manager-capability is technically separable from touching
   `approval.controller.ts` itself (same distinction already drawn for
   `IdempotencyService`/`OrganizationService`, neither of which has its
   own controller) — but Approval Engine DOES have an owning controller,
   one this authorization deliberately carved out as a separate decision
   point. Fixing its underlying service as a side effect of a different
   controller's turn would preempt that decision rather than honor it.

**Scope of the blocker on this controller**: NOT limited to `addBankAccount`
(the obvious write) — `syncBankAccountApproval` (a read-repair helper
that reflects the Approval Engine's current decision onto a cached
column) is called from the READ paths too (`list`/`listAllActive`/
`getById`, via `SupplierService`'s own internal wiring), so this blocks
most of the controller's routes, not just one write.

**Recommendation, not yet acted on**: either (a) request explicit CTO
authorization to fix `ApprovalEngineService`'s manager-capability as its
own dedicated foundation-level task (given its size, likely warranting
the same "Inventory & Design" treatment §14 originally gave Area 21
itself, given how many already-closed and not-yet-touched controllers
it would affect), or (b) accept `supplier.controller.ts` staying blocked
until `approval.controller.ts`'s own Mixed/Special decision is made. No
code changed for this controller this turn.

## §31 — `fulfillment.controller.ts` retrofit (2026-09-28, 12th controller — closes the §26 correction's follow-up)

Picked immediately after the §26 correction note (above) identified that
"Fulfillment has no controller of its own in the 43" was **factually
wrong** — `fulfillment.controller.ts` genuinely exists
(`src/domains/fulfillment/interface/fulfillment.controller.ts`) and is
listed in §1.2's own Tier 2 table. The `FulfillmentService`
manager-threading work done during §26/§29 (as a foundation-level fix
for Shipment's sake) was the right call regardless of that wrong
reasoning — but it left the controller's own turn undone, so this
section closes it properly.

**Pre-flight**: `FulfillmentService`'s constructor
(`dataSource, processEngine, authorization, audit, events, inventory,
numbering`) has **zero cross-domain contract dependencies** — every dep
was already manager-capable from earlier passes this session
(`ProcessEngineService`, `AuditService`, `EventBusService`,
`NumberingService` all foundation-level; `InventoryService` already
retrofitted during §21). No contract-interface drift found. No
STOP/ESCALATE needed.

**Service changes** (`fulfillment.service.ts`, all 15 public/private
methods gained `manager?: EntityManager`, threaded into every nested
call): `createFulfillmentOrder`, `listFulfillmentOrders`,
`getFulfillmentOrderBySalesOrderId`, `getFulfillmentOrder`,
`listPickTasks`, `listPackTasks`, `getPickTask`, `getPackTask`,
`assignPickTask`, `requireWorkerRole` (private), `receiveAndStartPickTask`,
`transitionPickTask`, `listPickTaskLines`,
`getOrCreatePreparationWarehouse` (private), `markPickTaskLineDone`,
`markAllPickTaskLinesDone`, `finishPreparationAndReadyForShipping`,
`transitionPackTask`. Two inner transactions renamed their callback
param `manager` → `txManager` to avoid shadowing the outer
manager-threading param (`(manager ?? this.dataSource).transaction(async
(txManager) => {...})`), same convention as every prior controller this
session. `transitionPackTask`'s trailing `events.dispatchPending()` is
now gated `if (!manager) await this.events.dispatchPending();` — same
convention as `products.service.ts`/`supplier-invoice.service.ts`/
`treasury.service.ts`.

**Controller changes** (`fulfillment.controller.ts`): `AuthenticatedRequest`
→ `CompanyScopedRequest`, `@UseGuards(JwtAuthGuard, CompanyContextGuard)`
at class level, all 15 routes now check `req.companyContext`
(+ `req.user` where an actor id is needed) and thread
`req.companyContext.dataSource.manager` into every service call.
No `RequireModuleGuard`/`PermissionGuard` added — the controller had
neither before this retrofit, and Area 21 is Company-routing only, not
a permissions pass.

**Module changes** (`fulfillment.module.ts`): added `CompanyModule` +
`DatabaseRegistryModule` imports — the same required pairing for
`CompanyContextGuard`'s own `CompanyConnectionManagerService` dependency
discovered during `products.controller.ts`'s retrofit.

**Entity registry**: `FULFILLMENT_COMPANY_ENTITIES` (`FulfillmentOrder`,
`PickTask`, `PickTaskLine`, `PackTask`) was already registered during
the §26/§29 foundation work — `company-entity-registry.completeness.spec.ts`
re-run clean (2/2 passed), no changes needed this turn.

**Build**: `npx nest build` clean, zero errors, both before and after
the controller/module edit.

**Real-PG isolation** (`fulfillment.company-isolation.spec.ts`, new
file, 5 tests, `extraCompanyTags: ['sales', 'inventory']` — `inventory`
for `fulfillment_orders`/`pick_tasks`/`pack_tasks`/`pick_task_lines`/
`stock_reservations`, `sales` for `products`' FK the seeded
`stock_reservations` row and a real `warehouses` row both need).
`createFulfillmentOrder` is the deep-chain proof: it transitively
exercises `InventoryService.getActiveReservationsForOrder`,
`NumberingService.getNextNumber`, `ProcessEngineService.start`, and
`AuditService.record`, all real instances, all manager-threaded. Two
Companies, each with its own seeded `warehouses`/`products`/
`stock_reservations` rows and its own distinct `salesOrderId` (random
UUID suffix per Company, avoiding any collision with the unique index
on `fulfillment_orders.salesOrderId`):

1. `createFulfillmentOrder` for Company A creates its Fulfillment Order
   + Pick Task inside Company A's own database — PASS.
2. `createFulfillmentOrder` for Company B creates independently in
   Company B's own database, no leakage of Company A's order — PASS.
3. `listFulfillmentOrders` via Company A resolves only Company A's own
   order — PASS.
4. `listFulfillmentOrders` via Company B resolves only Company B's own
   order — PASS.
5. Test F — resolving Company A's Fulfillment Orders never even
   requests Company B's `DataSource` (`assertDataSourceNeverRequestedFor`)
   — PASS.

All 5/5 passed on first green run after seeding a real `warehouses` row
and a real `products` row per Company (both FK-referenced by
`stock_reservations` at the DB level, even though neither is declared
as a TypeORM `@ManyToOne` on the `StockReservation` entity — caught by
the first run's `QueryFailedError`, not a design surprise).

**Full regression**: 600/600 tests passed (3 suites needed an isolated
re-run, all confirmed non-regressions, none touching Fulfillment):

- `sales-orders.company-isolation.spec.ts` and
  `company-membership-provisioning.real-pg.spec.ts` both failed the
  full run on the well-documented `permission denied to terminate
  process` teardown race (`DROP DATABASE ... WITH (FORCE)` racing a
  still-closing connection under full-suite parallel load) — both PASS
  clean in isolation (3/3 and 5/5 respectively).
- `payroll-phase1.spec.ts` (`5. Full lifecycle...`) failed the full run
  expecting `POSTED`, got `REJECTED` — Payroll domain, entirely
  untouched by this retrofit. PASSES clean in isolation (10/10) —
  confirmed a full-suite contention flake, not a Fulfillment regression.

`fulfillment.controller.ts` is now CLOSED (12th of the 43). Next:
continue through the remaining controllers per standing authorization,
no batching.

## §32 — `payments.controller.ts` retrofit (2026-09-28, 13th controller — refined pipeline: CODE → DEPENDENCY REVIEW → MANAGER PROPAGATION → REAL-PG A/B ISOLATION → BUILD → LINT → FULL REGRESSION → DOCUMENT → VERIFIED/CLOSED)

Picked after CTO sign-off on §31 (`fulfillment.controller.ts`, confirmed
CLOSED 12/43) and the CTO's refined pipeline directive: explicit
dependency review before code, no controller called CLOSED on
build/unit-test success alone, and any new cross-domain/foundation
dependency gets STOP → DOCUMENT → ESCALATE rather than a silent fix.
`returns.controller.ts` (§23) and `invoices.controller.ts` (§24) stay
BLOCKED, untouched; `supplier.controller.ts` (§30) stays STOP/ESCALATE
on `ApprovalEngineService`, not fixed.

**Dependency review** (§1.2 lists `payments.controller.ts` Tier 1:
`PaymentsService`✓, `EventBusService`✓, `IdempotencyService`✗). The ✗ was
already stale before this turn started — `IdempotencyService` was fully
rewritten to manager-capable during §28 (`treasury.controller.ts`)'s
foundation-level work, confirmed by direct read
(`withIdempotency`/`withIdempotencyInTransaction` both `manager?`-capable).
Full call-graph read of `PaymentsService.recordPayment` found every
transitive dependency (`TreasuryService.cashIn`, `CustomerLedgerService.
postEntry`, `InvoiceService.getInvoiceRemaining`/`recomputeStatus`,
`SalesCustomersContract.getCustomer`) already manager-threaded from
earlier passes this session — no new cross-domain/foundation blocker,
no STOP/ESCALATE needed. Two concrete gaps found and fixed (both
mechanical, same-graph, not scope expansion):

1. `PaymentsService.recordPayment` called
   `this.customers.getCustomer(customerId, actorUserId)` without its
   already-supported third `manager` argument (interface/concrete both
   already `manager?`-capable — a plain omission, not drift).
2. `PaymentsService.recordPayment` called
   `this.numbering.registerDocumentType(PAYMENT_DOCUMENT_TYPE,
   PAYMENT_PREFIX)` **inside its own transaction** without threading
   `m` — pre-existing code, explicitly commented "idempotent; not
   manager-threaded... negligible" from before Area 21 existed. Under
   Model B this is a real (if low-severity — `customer_payment` is
   always pre-seeded per Company by `AddCustomerFinancialCore`'s own
   migration) wrong-DataSource call; threaded it.

**Manager propagation**:

- `payments.service.ts`: the 2 fixes above, plus `manager?:
  EntityManager` added to `listPaymentsForCustomer` and
  `listAllPayments` (both previously always read via ambient
  `this.dataSource`), threaded into their repo access and
  `listAllPayments`'s `this.customers.listCustomers(actorUserId,
  manager)` call.
- `payments.controller.ts`: `AuthenticatedRequest` → `CompanyScopedRequest`,
  `@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)` at
  class level (kept the existing `RequireModule('finance')`/
  `PermissionGuard`/`RequirePermission` exactly as before — Area 21 adds
  Company-routing only, never touches entitlement/permission gating).
  All 3 routes now check `req.companyContext` (+ `req.user` where an
  actor id is needed) and thread `req.companyContext.dataSource.manager`
  through, including into `IdempotencyService.withIdempotencyInTransaction`'s
  own trailing `manager` argument so the idempotency-dedup transaction
  itself opens on the Company's own `DataSource`, not the ambient one.
- **A third gap surfaced only by the real-PG isolation test, not the
  dependency review**: `CustomerLedgerService.postEntry` (Tier 1,
  already ✓, its own controller `customer-ledger.controller.ts` already
  CLOSED at §25) had the exact same unthreaded-`registerDocumentType`
  pattern as gap 2 above, one level deeper in `recordPayment`'s call
  graph. The first isolation-test run threw outright
  (`EntityMetadataNotFoundError: No metadata for "NumberingSequence"` —
  the harness's control-plane `DataSource` has no `NumberingSequence`
  entity at all, so this wasn't a silent misroute, it was a hard
  failure). Fixed in place in `customer-ledger.service.ts` — a
  mechanical same-graph fix inside an already Company-scoped, already-
  manager-capable service reached by THIS controller's own request
  path, not a new cross-domain dependency and not scope creep into a
  different controller's turn (per "do not stop at the controller
  boundary," the same standing rule applied to every prior controller
  this session).

**Module**: `customer-finance.module.ts` already imported `CompanyModule`
+ `DatabaseRegistryModule` (added during §25's own retrofit, since both
controllers share one module) — only the module's own doc comment was
updated to reflect `PaymentsController` now also being retrofitted.

**Build**: `npx nest build` clean, zero errors.

**Lint**: `payments.service.ts`, `payments.controller.ts`,
`customer-finance.module.ts`, `customer-ledger.service.ts`, and the new
isolation spec all clean.

**Entity registry**: `company-entity-registry.completeness.spec.ts`
re-run clean (2/2) — no new entities, no changes needed.

**Real-PG isolation** (`payments.company-isolation.spec.ts`, new file, 5
tests, `extraCompanyTags: ['sales', 'finance']`). Two Companies, each
seeded with its own admin-roled actor, customer, `posted`-state invoice
(process instance inserted directly, same precedent as the shipment/
fulfillment specs), and using each Company's own migration-seeded
`MAIN-CASH` treasury account (never hand-rolled — same "rely on the
migration default" precedent `treasury.company-isolation.spec.ts`
established):

1. `recordPayment` for Company A posts against Company A's own
   invoice/account inside Company A's own database — PASS.
2. `recordPayment` for Company B posts independently in Company B's own
   database, no leakage of Company A's invoice/account — PASS.
3. `listPaymentsForCustomer` via Company A resolves only Company A's own
   payment — PASS.
4. `listAllPayments` via Company B resolves only Company B's own payment
   — PASS.
5. Test F — resolving Company A's payments never even requests Company
   B's `DataSource` — PASS.

First run failed both `recordPayment` tests on the `CustomerLedgerService`
gap above; second run, after that fix, 5/5 green.

**Full regression**: 605/605 tests passed (2 suites needed an isolated
re-run, both the well-documented `permission denied to terminate
process` teardown race in `dropDatabase` — `DROP DATABASE ... WITH
(FORCE)` racing a still-closing connection under full-suite parallel
load — never an actual test failure): `customer-ledger.company-isolation.spec.ts`
(also re-confirms the `customer-ledger.service.ts` fix above didn't
regress its own already-closed §25 controller — 5/5 clean) and
`database-provisioning.service.spec.ts` (unrelated to this retrofit
entirely). Both PASS clean in isolation.

`payments.controller.ts` is now VERIFIED / CLOSED (13th of the 43).
Next: continue through the remaining controllers per standing
authorization, no batching, refined pipeline in force.

## §33 — Area 21 Closure Gate (CTO-defined, 2026-09-28) — 5 post-43 tasks, explicitly NOT scheduled now

Recorded per direct CTO instruction, for execution **only after** the
43/43 controller-by-controller sequence finishes — explicitly **not**
added as parallel work during the remaining controllers, to avoid
token waste and overlapping edits. The current controller-by-controller
path is confirmed unchanged and needs no expansion during execution.

1. **Area 21 Global Isolation Audit (P0)** — after 43/43: one pass over
   every Company-scoped controller for any remaining `@InjectRepository`
   or unintended ambient Platform-DB access, every `manager` path, every
   raw SQL call, any Company-related cache/state, and no legacy fallback
   left behind.
2. **Cross-Company Adversarial Verification (P0)** — one uniform test
   matrix across Company A/B, real PostgreSQL (not mocks): `A→A ALLOW`,
   `A→B DENY`, `B→A DENY`, no-company-context `DENY`, revoked-membership
   `DENY`, wrong-resource-id `DENY`, Platform-DB access `NEVER`.
3. **Full Transitive Dependency Audit (P0)** — reviewed as a graph
   (Controller → Service → Contract → Shared Service → Repository access
   → Raw SQL → Transaction boundary), not per-file, since this Matrix
   has repeatedly found a controller itself clean while a deep dependency
   still had a manager gap (e.g. §32's `CustomerLedgerService` gap,
   surfaced only by the isolation test, not the dependency review).
4. **Company-Aware Cache / State Audit (P1)** — confirms `DataSource`
   caching, in-memory `Map`s, request/session state, idempotency,
   numbering, and process state can never cross a Company boundary.
5. **Area 21 Closure Gate (P0)** — Area 21 is not declared CLOSED at
   43/43 alone. Required sequence: `43/43 Controllers → Global Isolation
   Audit → Adversarial A/B Test → Transitive Dependency Audit → Full
   Regression → Matrix Finalization → CTO Verification → Area 21
   VERIFIED`, which then unblocks Frontend P1.7.

## §34 — `delivery.controller.ts` retrofit (2026-09-28, 14th controller — picked to potentially unblock part of §23's open `DeliveryService` blocker)

Picked deliberately: `returns.controller.ts` (§23) has 2 open blockers,
one of which is `DeliveryService.getCollectionForShipmentUnscoped`.
Closing `delivery.controller.ts` on its own turn makes `DeliveryService`
itself fully manager-capable, which may close that half of §23's
blocker on a future pass (not re-attempted this turn — §23 stays
BLOCKED as recorded, revisited separately).

**Dependency review**: `DeliveryService` (Tier 2, single service per
§1.2) has the widest cross-domain fan-out of any controller retrofitted
so far — `ShipmentService` (direct concrete injection, not a contract),
`FulfillmentContract`, `SalesOrdersReadContract`, `FinanceTreasuryContract`,
`InventoryLogisticsContract`, `FinanceCustomerLedgerContract`,
`FinanceInvoiceContract`. Full call-graph read of all 7 controller-
reachable methods (`recordOutcome`, `recordCollection`,
`getOutcomeForShipment`, `getCollectionForShipment`,
`listPendingRemittances`, `getCollectionForShipmentUnscoped`,
`remitCollection`) found every dependency already manager-capable at
the contract level **except** `FinanceInvoiceContract` (zero `manager?`
on any of its 4 methods, despite the concrete `InvoiceService.getStatus`/
`recomputeStatus` already having it — contract drift, the same recurring
class this Matrix has hit 6+ times). No foundation-service blocker of
the `ApprovalEngineService`/`TaxEngineService` kind found — no
STOP/ESCALATE needed.

**Concrete gaps found and fixed** (all mechanical, same-graph, not scope
expansion):

1. `FinanceInvoiceContract.findOpenInvoiceForOrder`/`getStatus`/
   `recomputeStatus` widened to `manager?: EntityManager` (`getInvoice`
   left untouched — not called anywhere in `DeliveryService`'s reachable
   graph, out of this turn's scope). `InvoiceService.findOpenInvoiceForOrder`
   itself gained `manager?` at the concrete level too (a genuine gap, not
   just interface drift — it previously always read via ambient
   `this.dataSource`).
2. `ShipmentService.getCustodianForShipment` — **zero** `manager?`
   capability at all, despite `shipment.controller.ts` being CLOSED
   since §29. One level into an already-closed controller's own
   service, reached by THIS controller's request path
   (`recordCollection`/`remitCollection` both call it to resolve the
   custodian) — fixed in place (threaded into its own nested
   `getVehicle`/`getShippingCompany` calls, both of which were already
   manager-capable), same "do not stop at the controller boundary" rule
   applied to `CustomerLedgerService` in §32. Re-ran
   `shipment.company-isolation.spec.ts` afterward to confirm no
   regression on the already-closed controller — 5/5 clean.
3. `DeliveryService` itself: all 7 reachable methods gained
   `manager?: EntityManager`, threaded through every nested call,
   including 3 internal transactions renamed `manager`→`txManager`
   (`(manager ?? this.dataSource).transaction(async (txManager) => {...})`)
   to avoid shadowing the outer param, and both `events.dispatchPending()`
   calls gated `if (!manager)`.

**A production gap found only by the isolation test, not the dependency
review**: `DeliveryOutcome`/`Collection` were **never registered in
`COMPANY_ENTITY_REGISTRY`** at all (not merely unguarded) —
confirmed by `EntityMetadataNotFoundError` on the isolation spec's
first run, which is not a test-harness artifact: any real Company
`DataSource` would throw the identical error on a live request today.
Fixed per the established ADR-074 Hybrid B pattern — new
`delivery-company-entities.ts` (`DELIVERY_COMPANY_ENTITIES = [DeliveryOutcome,
Collection]`), registered into `company-entity-registry.ts`.
`company-entity-registry.completeness.spec.ts` re-run clean (2/2)
afterward.

**Controller**: `AuthenticatedRequest` → `CompanyScopedRequest`,
`@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)` at
class level (existing `RequireModule('logistics')`/`PermissionGuard`/
`RequirePermission` unchanged). All 7 routes now check
`req.companyContext` (+ `req.user` where an actor id is needed) and
thread `req.companyContext.dataSource.manager` through.

**Module**: `delivery.module.ts` gained `CompanyModule` +
`DatabaseRegistryModule`.

**Build**: `npx nest build` clean, zero errors.

**Lint**: all 9 touched files clean.

**Real-PG isolation** (`delivery.company-isolation.spec.ts`, new file, 7
tests, `extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics']`).
Two Companies, each seeded with its own admin-roled actor, a shipping
company with its own custody treasury account, a shipment routed
through it (process instance seeded at `out_for_delivery`, same
direct-seed precedent as the shipment/fulfillment specs).
`FulfillmentContract`/`SalesOrdersReadContract` are stubbed (their own
Company-isolation is proven by §31's own spec and a future controller's
own spec respectively — this spec's job is `DeliveryService`'s own
tables and its real `ShipmentService`/`TreasuryService` integration,
not re-deriving two more domains' full setup):

1. `recordOutcome` ('failed') for Company A transitions its own
   shipment and writes the outcome inside Company A's own database —
   PASS.
2. `recordOutcome` for Company B transitions independently in Company
   B's own database — PASS.
3. `recordCollection` for Company A posts custody cash-in against
   Company A's own custody account (the deep-chain proof — exercises
   the `getCustodianForShipment` fix directly) — PASS.
4. `recordCollection` for Company B posts independently against Company
   B's own custody account — PASS.
5. `listPendingRemittances` via Company A resolves only Company A's own
   collection — PASS.
6. `remitCollection` for Company A transfers custody → settlement
   inside Company A's own database — PASS.
7. Test F — resolving Company A's delivery data never even requests
   Company B's `DataSource` — PASS.

First run failed all 7 on the missing entity-registry registration
above; second run, after that fix, 7/7 green.

**Full regression**: 612/612 tests passed (3 suites needed an isolated
re-run, all confirmed transient full-suite contention, none touching
Delivery or any file this retrofit changed):
`integrated-attendance-payroll-commission-gl-e2e.spec.ts` (2 tests,
`deadlock detected` inside `ApprovalEngineService`/`AuditService` —
Payroll/Commission/Approval domain), `wip-reconciliation.spec.ts` Case E
(a numeric drift assertion — Accounting/WIP domain), and
`company-audit-access.real-pg.spec.ts` (the well-documented `permission
denied to terminate process` teardown race). All three PASS clean in
isolation.

`delivery.controller.ts` is now VERIFIED / CLOSED (14th of the 43).
Next: continue through the remaining controllers per standing
authorization, no batching, refined pipeline in force. Note for a
future turn: this closes half of §23's (`returns.controller.ts`) two
open blockers (`DeliveryService` is now fully manager-capable) —
`returns.controller.ts` itself was not re-attempted this turn and stays
recorded BLOCKED until `InvoiceService.getInvoice`'s own gap (the
other blocker) is separately addressed.

## §35 — `bom.controller.ts` retrofit (2026-09-28, 15th controller)

Picked after `general-ledger.controller.ts` (the last remaining Tier 1
controller besides `accounting.controller.ts`) was scoped and found
unusually large for a single turn — 5 injected services, ~1,900 lines
across `JournalEntryService`/`LedgerService` (✓) and
`FinancialReportingService`/`FinancialEventService`/`ExcelService` (✗,
all substantial) — better sized as its own dedicated future turn than
folded into this one; recorded here, not implemented, no code touched.
Picked `bom.controller.ts` (Tier 2, single service, `BomService`, 197
lines) instead — small and contained, a better-sized #15.

**Dependency review**: `BomService`'s only dependency beyond
`DataSource`/`AuditService` is `ProductsService.getProductSnapshot`,
already manager-capable since §17 (`products.controller.ts`). No
cross-domain/foundation blocker — no STOP/ESCALATE needed. Only
`getBomForAssembly` (a cross-domain read contract for
`InventoryService.assembleProduct`) had `manager?` already, added
during §21's own retrofit; the other 4 methods
(`defineBom`/`getBom`/`listBoms`/`deleteBom`, all controller-reachable)
were still ambient.

**Manager propagation**: `bom.service.ts`'s 4 methods gained
`manager?: EntityManager`, threaded through every `products.
getProductSnapshot` call, repo access, and `defineBom`'s own inner
transaction (renamed `manager`→`txManager`,
`(manager ?? this.dataSource).transaction(async (txManager) => {...})`).
`bom.controller.ts`: `AuthenticatedRequest` → `CompanyScopedRequest`,
`@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)` at
class level, all 4 routes thread `req.companyContext.dataSource.manager`
through.

**Module**: `commerce.module.ts` already had `CompanyModule` +
`DatabaseRegistryModule` (shared with `products.controller.ts`/
`price-lists.controller.ts`) — no change needed.

**Entity registry**: `BillOfMaterial`/`BomComponent` were already
registered in `commerce-company-entities.ts` during §21 — no change
needed, `company-entity-registry.completeness.spec.ts` re-run clean
(2/2) to confirm.

**Build**: `npx nest build` clean, zero errors.

**Lint**: `bom.service.ts`, `bom.controller.ts`, and the new isolation
spec all clean.

**Real-PG isolation** (`bom.company-isolation.spec.ts`, new file, 7
tests, `extraCompanyTags: ['sales']`). Two Companies, each seeded with
its own finished product + component product (`ProductsService`
constructed for real, same precedent as `products.company-isolation.spec.ts`):

1. `defineBom` for Company A creates its own BOM inside Company A's own
   database — PASS.
2. `defineBom` for Company B creates independently, no leakage of
   Company A's BOM — PASS.
3. `getBom` for Company A resolves only its own recipe (component
   SKU/quantity) — PASS.
4. `listBoms` via Company A resolves only Company A's own BOM — PASS.
5. `listBoms` via Company B resolves only Company B's own BOM — PASS.
6. `deleteBom` for Company A removes only Company A's own BOM — Company
   B's stays untouched — PASS.
7. Test F — resolving Company B's BOM never even requests Company A's
   `DataSource` — PASS.

All 7/7 passed on first run — no gaps found beyond the expected
manager-threading work itself.

**Full regression**: 619/619 tests passed (2 suites needed an isolated
re-run, both previously-seen transient patterns, neither touching
`bom.controller.ts` or any file this retrofit changed):
`integrated-attendance-payroll-commission-gl-e2e.spec.ts` (`deadlock
detected` inside `AuditService`/`PayrollService.createPeriod` under
full-suite contention — Payroll/Commission domain) and
`company-audit-access.real-pg.spec.ts` (the well-documented `permission
denied to terminate process` teardown race). Both PASS clean in
isolation, documented as transient per Step 7.

**§35 — Structured summary (Step 8 format)**

- **Controller**: `bom.controller.ts`
- **Tier**: 2 (single service, `BomService`)
- **Dependencies reviewed**: `ProductsService.getProductSnapshot` (already manager-capable, §17); no cross-domain/foundation blocker found
- **Manager changes**: `defineBom`/`getBom`/`listBoms`/`deleteBom` in `bom.service.ts` gained `manager?: EntityManager`
- **Shared dependencies changed**: none (no fix required outside `bom.service.ts`/`bom.controller.ts`)
- **Entity registry changes**: none — `BillOfMaterial`/`BomComponent` already registered since §21
- **Real-PG isolation result**: `bom.company-isolation.spec.ts`, 7/7 PASS
- **Build**: clean
- **Lint**: clean, 0 errors/warnings
- **Full regression**: 619/619 (2 confirmed-transient failures, documented above)
- **Known transient failures**: `integrated-attendance-payroll-commission-gl-e2e.spec.ts`, `company-audit-access.real-pg.spec.ts` — both unrelated, both re-verified clean in isolation
- **Files changed**: `src/domains/commerce/application/bom.service.ts`, `src/domains/commerce/interface/bom.controller.ts`, `src/domains/commerce/interface/bom.company-isolation.spec.ts` (new)
- **Architectural impact**: none — mechanical manager-threading only, same established pattern, no schema/behavior change
- **Status**: VERIFIED / CLOSED

`bom.controller.ts` is now VERIFIED / CLOSED (15th of the 43). Holding
here per the Master Sequential Execution Directive — reporting this
result for approval before starting controller #16.

## §36 — `deposits.controller.ts` retrofit (2026-09-28, 16th controller) + ApprovalEngineService blast-radius finding

**Aggregate finding, recorded once (applies to the whole remaining
queue, not just this controller):** a grep of `ApprovalEngineService`
consumers found it imported by the services behind 11 further
controllers beyond `supplier.controller.ts` (§30): `ap`, `ar`,
`cash-bank`, `fixed-asset` (disposal), `inventory-accounting`,
`attendance`, `commission`, `hr`, `payroll`, `rfq`, `target`. Whether
it sits on each controller's *reachable* call graph (vs. an unrelated
method) is verified per controller when its turn comes — not assumed.
Where it is reachable: STOP → DOCUMENT → ESCALATE under §30's existing
finding (no independent fix). The queue is therefore steered, per the
standing "continue with the next safe controller" rule, toward
controllers clear of it first.

**Dependency review (`deposits.controller.ts`, Tier 2)**:
`SalesOrdersService` (concrete, closed §16), `FinanceTreasuryContract`,
`FinanceCustomerLedgerContract`, `FinanceInvoiceContract` (widened §34).
No Approval Engine / Tax Engine / foundation blocker — SAFE.

**Concrete gaps found and fixed (mechanical, same call graph)**:

1. `TreasuryService.createDepositTransaction` — zero `manager?` at both
   concrete and `FinanceTreasuryContract` level (missed by §28's
   Treasury pass). Threaded into `getAccount`, the inner transaction
   (`manager`→`txManager`), and `audit.record`; contract widened.
2. `DepositsService` — all 6 reachable methods
   (`submitDeposit`/`approveDeposit`/`rejectDeposit`/`getDeposit`/
   `getLatestDepositForOrder`, plus `listDepositsForOrder` for
   consistency) gained `manager?`, threaded through every nested
   `salesOrders`/`treasury`/`customerLedger`/`invoices` call, 3 inner
   transactions renamed to `txManager`, `dispatchPending()` gated
   `if (!manager)`. `SalesDepositContract.getLatestDepositForOrder`
   widened.
3. **Production gap found only by the isolation test**: `Deposit` was
   never registered in `COMPANY_ENTITY_REGISTRY` (same shape as
   Delivery, §34) — new `deposit-control-company-entities.ts`,
   registered.

**Controller/module**: `CompanyContextGuard` at class level, all 5
routes thread `req.companyContext.dataSource.manager`;
`deposit-control.module.ts` gained `CompanyModule` +
`DatabaseRegistryModule`.

**Closed controller touched → re-proved**: `treasury.service.ts`
(§28) was edited; `treasury.company-isolation.spec.ts` re-run — 6/6 PASS.

**Real-PG isolation** (`deposits.company-isolation.spec.ts`, 6 tests,
`['sales','finance']`): real `TreasuryService`/`CustomerLedgerService`;
`SalesOrdersService`/`FinanceInvoiceContract` stubbed (their isolation
is proven by §16/§32/§34). `submitDeposit` A and B, `getLatest…` A,
`approveDeposit` A (Treasury deposit leg + ledger credit land in A's
DB), `rejectDeposit` B (A's stays `approved`), Test F — 6/6 PASS after
the registry fix (first run 0/6 on `EntityMetadataNotFoundError`).

**Build**: clean. **Lint**: clean. **Registry completeness**: 2/2.

**Full regression**: 625 tests; 614 passed first run, 11 failed across
2 suites, both in domains untouched by this retrofit and both
concurrency-sensitive: `payroll-phase1.spec.ts` (Payroll, same suite
that flaked in §19's run) and `f03-deadlock-retry-verification.spec.ts`
(GL concurrency test — intentionally provokes contention). Both PASS
clean in isolation (10/10 and 1/1) — documented transient. Effective:
625/625.

**Status**: VERIFIED / CLOSED (16th of the 43). Files changed:
`deposits.service.ts`, `deposits.controller.ts`,
`deposit-control.module.ts`, `deposit-control-company-entities.ts` (new),
`company-entity-registry.ts`, `treasury.service.ts`,
`finance.contract.ts`, `sales.contract.ts`,
`deposits.company-isolation.spec.ts` (new).

## §37 — `warehouse-transactions.controller.ts` retrofit (2026-09-28, 17th controller)

**Dependency review (Tier 2)**: `WarehouseTransactionsService` calls
`NumberingService`, `ProcessEngineService`, `AuthorizationService`,
`AuditService` (all manager-capable foundation services),
`SalesProductsContract` (`getProductSnapshot`/`listAllProducts`, widened
earlier) and the concrete `InventoryService` (closed §21 —
`getOnHand`/`getWarehouse`/`listWarehouses`/`getStockReport`/
`listMovements`/`getAvailableInTransaction`/`recordMovement`, all already
manager-capable). No Approval Engine / Tax Engine / foundation / cross-
domain blocker — SAFE; zero shared-dependency changes needed.

**Manager propagation**: all 9 controller-reachable methods
(`createTransaction`, `startCount`, `recordCountResults`,
`getTransaction`, `getLines`, `getOverview`, `listTransactions`,
`listTransactionsPage`, `transition`) plus the internal
`postTransaction` / `reverseTransaction` / `assertWarehouseActive` gained
`manager?`, threaded through every nested call. The document-locked
`postTransaction` transaction is now
`(manager ?? this.dataSource).transaction(async (txManager) => …)` with
every in-lock call (advisory locks, state re-check, ledger writes,
`update`, state transition) on `txManager` — the atomic-posting and
idempotency guarantees are unchanged, only the DataSource they run on is
now Company-routed. Controller: `CompanyContextGuard` at class level, all
9 routes thread `req.companyContext.dataSource.manager` (the paginated
list route resolves it once and passes it to either list method).

**Production gap found only by the isolation test**:
`WarehouseTransaction`/`WarehouseTransactionLine` were never registered
in `COMPANY_ENTITY_REGISTRY` (same shape as §34/§36) — added to
`inventory-warehouse-company-entities.ts` (additive; the already-closed
§21 inventory controller shares that manifest — covered by the full
regression).

**Module**: `inventory-warehouse.module.ts` already imported
`CompanyModule` + `DatabaseRegistryModule` (§21) — no change.

**Real-PG isolation** (`warehouse-transactions.company-isolation.spec.ts`,
7 tests, `['sales','inventory']`, all real services — real ledger,
Process Engine, Numbering): `createTransaction` A and B; receipt
`submit` → auto-`post` writes the stock movement only into A's ledger
(B's `stock_movements` stays empty); list A/B each see only their own
document and state (`posted` vs `draft`); `startCount` B captures B's
own on-hand and A has no trace of it; `getOverview` A reports A's own
figures (1 warehouse, 70.00 value); Test F — 7/7 PASS.

**Build**: clean. **Lint**: clean. **Registry completeness**: 2/2.

**Full regression**: 632 tests; 631 passed first run, 1 failed, across
4 flagged suites: `f03-deadlock-retry-verification.spec.ts` (the GL
concurrency test that flaked in §36's run too — one real test failure
under full-suite contention) and three suite-level
`permission denied to terminate process` teardown races
(`inventory-valuation.company-isolation`, `price-lists.company-isolation`
— both already-closed controllers' specs — and
`memberships-mine.real-pg`). All four PASS serially in isolation (19/19).
Effective: 632/632.

**Status**: VERIFIED / CLOSED (17th of the 43). Files changed:
`warehouse-transactions.service.ts`, `warehouse-transactions.controller.ts`,
`inventory-warehouse-company-entities.ts`,
`warehouse-transactions.company-isolation.spec.ts` (new).

## §38 — `sales.controller.ts` — STOP/ESCALATE, not retrofitted (2026-09-28, evidence only, zero code changed)

Attempted as a candidate for #18 (smallest of the remaining queue: 42-line
controller, 55-line `SalesService`). The dependency review found a
**foundation / architectural-ownership blocker**: `SalesService.
createSalesRepProfile` calls `AuthorizationService.assignRole(userId,
'sales_rep')`, and `isSalesRep` calls `hasRole`. `assignRole`/
`revokeRole`/`getUserIdsForRole` are the **platform-level** role-grant
methods — `@InjectRepository(Role)`/`(UserRole)`-bound, no `manager?`,
and explicitly documented in `AuthorizationService`'s own class comment
as "platform-level role grants… deliberately untouched, not part of the
Company boundary". Whether `sales_rep` becomes a Company-local role
(written to each Company's own `Role`/`UserRole` catalog) or stays a
platform-wide designation is exactly the open decision already recorded
in §2.3 (`admin.controller.ts` `GET /admin/sales-reps`) — the same
underlying question, now blocking a second surface.

Not fixed autonomously: making `assignRole` manager-capable would decide
that ownership question and change a foundation authorization service
(directive: foundation / shared-engine / authorization-boundary →
STOP → DOCUMENT → ESCALATE). A partial retrofit (only
`getSalesRepProfile`, which reads Company-owned `SalesRepProfile`) is
also not done — the directive forbids opening a controller partially.

**Recommendation for CTO**: resolve §2.3's decision once; it unblocks
both `sales.controller.ts` and `admin.controller.ts`'s sales-reps route.
Queue continues with the next safe controller.

## §39 — `goods-receipt.controller.ts` retrofit (2026-09-28, 18th controller)

**Dependency review (Tier 2)**: `GoodsReceiptService` calls
`ProcessEngineService`, `NumberingService`, `AuditService`,
`EventBusService` (all manager-capable foundation services) and the
concrete `InventoryService.recordMovement` (closed §21, already
manager-capable, already called with the transaction's manager). No
Approval Engine / Tax Engine / cross-domain / foundation blocker — SAFE;
zero shared-dependency changes.

**Manager propagation**: both reachable methods (`listForPurchaseOrder`,
`post`) gained `manager?`; the 3 pre-transaction reads, the
`registerDocumentType('goods_receipt')` call (previously ambient — the
one un-threaded write, a hard failure on a Company DataSource, same class
as §32's finding) and the inner transaction
(`(manager ?? this.dataSource).transaction(async (txManager) => …)`, every
in-transaction call on `txManager`) are all Company-routed;
`dispatchPending()` gated `if (!manager)`. Controller:
`CompanyContextGuard` at class level, both routes thread
`req.companyContext.dataSource.manager`. `procurement.module.ts` already
had `CompanyModule` + `DatabaseRegistryModule` — no change.

**Production gap found by the entity-manifest check**:
`GoodsReceipt`/`GoodsReceiptLine` were never registered in
`COMPANY_ENTITY_REGISTRY` (same shape as §34/§36/§37) — added to
`procurement-company-entities.ts` (additive; shared with the closed §27
`supplier-invoice` controller — covered by the full regression).

**Real-PG isolation** (`goods-receipt.company-isolation.spec.ts`, 5 tests,
`['sales','inventory','procurement']`, real Inventory/Process Engine/
Numbering): `post` A writes the stock movement only into A's ledger and
moves A's PO to `partially_received`; `post` B (full receipt → `received`)
leaves B's ledger empty beforehand and independent of A;
`listForPurchaseOrder` — A's PO id returns 1 receipt via A's manager and 0
via B's; `post` of A's PO id through B's manager is rejected
(wrong-resource-id DENY); Test F — 5/5 PASS on first run.

**Build**: clean. **Lint**: clean. **Registry completeness**: 2/2.

**Full regression**: 637 tests; 633 passed first run, 4 failed across 3
flagged suites — all in code this retrofit did not touch:
`wip-reconciliation.spec.ts` (3 cases; Accounting/WIP numeric-drift
flake, flaked in an earlier run too), `closing-snapshot-key-rotation.spec.ts`
(1 case; Accounting) and `inventory.company-isolation.spec.ts` (suite-
level teardown race on an already-closed controller's spec). All three
PASS serially in isolation (15/15). Effective: 637/637.

**Status**: VERIFIED / CLOSED (18th of the 43). Files changed:
`goods-receipt.service.ts`, `goods-receipt.controller.ts`,
`procurement-company-entities.ts`,
`goods-receipt.company-isolation.spec.ts` (new).

## §40 — `purchase-order.controller.ts` retrofit (2026-09-28, 19th controller)

**Dependency review (Tier 2)**: `PurchaseOrderService` calls only
`ProcessEngineService`, `NumberingService`, `AuditService` (all
manager-capable foundation services) plus its own Company-owned entities
(`PurchaseOrder`, `PurchaseOrderLine`, `Supplier`, `ProcessInstance` —
all already in the entity registry). No Approval Engine (confirmed: the
controller documents a plain permission split, not the generic engine),
Tax Engine or cross-domain blocker — SAFE; zero shared-dependency
changes.

**Manager propagation**: `list`, `getById`, `transition`, the private
`statesFor`, and `create` (its un-threaded
`registerDocumentType('purchase_order')` call now uses the manager).
Design note on `create`: it already accepted an `externalManager`
meaning "join the caller's transaction" (used by `RfqService`'s award
flow). A Company-scoped `dataSource.manager` is **not** a transaction, so
`create` now joins only when `externalManager.queryRunner.isTransactionActive`
and otherwise opens a transaction on the supplied manager — preserving
`RfqService`'s exact behaviour while making the controller path atomic.
Controller: `CompanyContextGuard` at class level; all 7 routes thread
`req.companyContext.dataSource.manager`. Module/registry: already wired
(§39) — no change.

**Real-PG isolation** (`purchase-order.company-isolation.spec.ts`, 7
tests, `['sales','inventory','procurement']`, real Numbering/Process
Engine/Audit): `create` A and B independent; `create` against A's
supplier through B's manager → DENY; `submit`→`approve` moves only A's PO
(B's stays `draft`); `list` A/B each see only their own PO and state;
`getById`/`transition` of A's id through B's manager → DENY; Test F —
7/7 PASS on first run.

**Build**: clean. **Lint**: clean.

**Full regression**: 644/644 tests passed (including every `RfqService`
→ `create` consumer). One suite-level failure,
`payments.company-isolation.spec.ts` (already-closed §32 controller):
`permission denied to terminate process` in `dropDatabase` — the
documented teardown race, no test failed. PASSES 5/5 in isolation.

**Status**: VERIFIED / CLOSED (19th of the 43). Files changed:
`purchase-order.service.ts`, `purchase-order.controller.ts`,
`purchase-order.company-isolation.spec.ts` (new).

## §41 — `purchase-request.controller.ts` retrofit (2026-09-28, 20th controller)

**Dependency review (Tier 2)**: `PurchaseRequestService` calls only
`ProcessEngineService`, `NumberingService`, `AuditService` (manager-
capable foundation services) and its own procurement entities. No
Approval Engine, Tax Engine, cross-domain or foundation blocker — SAFE.
Boundary note: `createRfqFromRequest` writes `Rfq`/`RfqSupplierInvite`
rows itself (the PR → RFQ handoff). Registering those entities is an
additive manifest entry required by *this* controller's call graph;
`RfqService`/`rfq.controller.ts` (Approval-Engine-blocked) are untouched
and stay in the queue's blocked set.

**Manager propagation**: all 8 reachable methods (`list`, `getById`,
`create`, `transition` ×4 actions via one method, `createRfqFromRequest`)
plus private `statesFor`; both `registerDocumentType` calls ('purchase_request',
'rfq' — previously ambient) now use the manager; both transactions are
`(manager ?? this.dataSource).transaction(async (txManager) => …)` with
every in-transaction call on `txManager`. Controller:
`CompanyContextGuard` at class level, all 8 routes thread
`req.companyContext.dataSource.manager`. Module already wired (§39).

**Production gap**: `PurchaseRequest`/`PurchaseRequestLine`/`Rfq`/
`RfqSupplierInvite` were never registered in `COMPANY_ENTITY_REGISTRY` —
added to `procurement-company-entities.ts`.

**Real-PG isolation** (`purchase-request.company-isolation.spec.ts`, 6
tests, `['sales','inventory','procurement']`, real Numbering/Process
Engine/Audit): `create` A and B independent; `submit`→`approve`→
`createRfqFromRequest` for A writes the RFQ only into A's database
(B's `rfqs` empty), A's PR → `converted_to_rfq`, B's stays `draft`;
`list` A/B each see only their own; `getById`/`transition`/
`createRfqFromRequest` of A's PR id through B's manager → DENY; Test F —
6/6 PASS on first run.

**Build**: clean. **Registry completeness**: 2/2.

**Lint**: all files this retrofit touched are clean. A whole-domain lint
also surfaced one pre-existing error in `supplier-payment.service.ts`
(unused `EntityManager` import; file unmodified since the baseline
commit) — not attributable to this retrofit; it is resolved by
`supplier-payment.controller.ts`'s own retrofit, next in the queue.

**Full regression**: 650/650 tests passed. One suite-level failure,
`payments.company-isolation.spec.ts` (already-closed §32 controller; the
same suite hit the same `permission denied to terminate process`
`dropDatabase` teardown race in §40's run — a recurring race on that
spec's teardown timing, never a test failure). PASSES 5/5 in isolation.

**Status**: VERIFIED / CLOSED (20th of the 43). Files changed:
`purchase-request.service.ts`, `purchase-request.controller.ts`,
`procurement-company-entities.ts`,
`purchase-request.company-isolation.spec.ts` (new).

## §42 — `supplier-payment.controller.ts` retrofit (2026-09-28, 21st controller)

**Dependency review (Tier 2)**: `SupplierPaymentService` calls
`SupplierLedgerService` / `SupplierInvoiceService` (closed §27, manager-
capable), `FinanceTreasuryContract.cashOutForSupplier` (manager-capable
since F09-H3 / §28), `NumberingService`, `AuditService`, `EventBusService`.
No Approval Engine / Tax Engine / cross-domain / foundation blocker — SAFE.

**Manager propagation**: all 3 reachable methods (`recordPayment`,
`listForSupplier`, `listAll`) gained `manager?`; the transaction is
`(manager ?? this.dataSource).transaction(async (m) => …)`; the in-
transaction `registerDocumentType('supplier_payment')` (previously
ambient) now uses `m`; `dispatchPending()` gated `if (!manager)`.
Controller: `CompanyContextGuard` at class level, all 3 routes thread
`req.companyContext.dataSource.manager`. Module already wired (§39).
This also resolves the pre-existing unused-`EntityManager` lint error
recorded in §41 (the import is now used).

**Gaps found only by the isolation test**:

1. `SupplierPayment` was never registered in `COMPANY_ENTITY_REGISTRY` —
   added to `procurement-company-entities.ts`.
2. `SupplierLedgerService.postEntry` (and `reverseEntry`) — inside the
   already-closed §27 service — still called `registerDocumentType`
   ambiently: `EntityMetadataNotFoundError: No metadata for
   "NumberingSequence"` on a Company DataSource (same class as §32's
   `CustomerLedgerService.postEntry`). Fixed both calls in place (manager
   already in scope; mechanical, same call graph). Closed-controller
   re-proof: `supplier-invoice.company-isolation.spec.ts` re-run — 6/6.

**Aggregate finding for the later audit gates (A/C)** — a sweep of
remaining *ambient* `registerDocumentType` calls (each is a latent
hard-failure on a Company DataSource, to be fixed in its owning
controller's turn, or by the Transitive Dependency Audit):
`customer-ledger.service.ts` `reverseEntry` (no `manager` at all; not
reachable from any retrofitted controller so far),
`journal-entry.service.ts`, `invoices.service.ts` (blocked, §24),
`hr.service.ts`, `payroll.service.ts`, `rfq.service.ts`,
`returns.service.ts` ×3, `sales-returns.service.ts`,
`shipment-returns.service.ts` — none touched this turn.

**Real-PG isolation** (`supplier-payment.company-isolation.spec.ts`, 6
tests, `['sales','inventory','finance','procurement']`; real Treasury,
Ledger, Invoice, Numbering, Process Engine; each Company's `MAIN-CASH`
funded via the real manager-threaded `cashIn`): `recordPayment` A (500 of
1500) writes the ledger debit in A's database and moves A's invoice to
`partially_paid`; `recordPayment` B (full) → `paid`, B's invoice
`posted` beforehand — unaffected by A; payment against A's invoice
through B's manager → DENY; `listAll` A/B each see only their own payment
with their own supplier/invoice labels; `listForSupplier` of A's supplier
from B → empty; Test F — 6/6 PASS (after the two fixes above; first run
3/6).

**Build**: clean. **Lint**: whole procurement domain clean.

**Full regression**: 656 tests; 651 passed first run, 5 failed across 5
flagged suites, none on code this retrofit changed except one
already-closed spec which I examined directly:
`supplier-invoice.company-isolation.spec.ts` (the closed §27 spec whose
service I touched) failed as a *suite-level*
`permission denied to terminate process` teardown race — not a test
failure — and PASSES serially (re-proven also in the dedicated run
above, 6/6). `wip-reconciliation.spec.ts` (3 cases) and
`work-order-phase3-e2e.spec.ts` Item 6 are the Accounting/Manufacturing
WIP numeric-drift family that has flaked in three earlier full runs
(§39/§36 etc.) — consistent with cross-suite contention on shared WIP
state, never reproducible in isolation. `database-provisioning.service.spec.ts`
is the known teardown race. All five PASS serially (35/35). Effective:
656/656.

**Status**: VERIFIED / CLOSED (21st of the 43). Files changed:
`supplier-payment.service.ts`, `supplier-payment.controller.ts`,
`supplier-ledger.service.ts`, `procurement-company-entities.ts`,
`supplier-payment.company-isolation.spec.ts` (new).

## §43 — `grni.controller.ts` retrofit (2026-09-28, 22nd controller — first Accounting-domain controller)

**Dependency review (Tier 2)**: `GrniReconciliationService` calls
`LedgerService` (Tier 1 "✓" — but see below), `AuditService`, and an
`@Optional()` `GRNI_LEDGER_CONTRACT` bound (in `ProcurementModule`) to the
Procurement-owned `GrniLedgerService`. Cross-domain dependency assessed
per Gate B: Company-owned (reads `purchase_order_lines`/`goods_receipts`),
fix mechanical (two plain queries), blast radius contained (one contract
method, one consumer) → fixed in this call graph, no escalation. No
Approval Engine / Tax Engine involvement.

**Concrete gaps fixed (mechanical)**:

1. `LedgerService.getAccountLedger` — despite §1.2's "Tier 1 ✓", this
   method had **no `manager?`** (only `getTrialBalance` did — the same
   §16.0 "Tier 1 ≠ fully capable" caveat). Added as an optional third
   parameter; all 5 `this.dataSource` uses inside it now go through
   `(manager ?? this.dataSource)`. Additive: every existing caller
   (`general-ledger.controller.ts`, closing services) is unchanged and
   remains un-retrofitted/ambient until its own turn.
2. `GrniLedgerService.getAllGrniBalances` + `GrniLedgerContract` gained
   `manager?`. Disclosed pre-existing behaviour, **not** changed: the
   concrete method ignores the contract's `asOfDate` (balances are always
   "as of now") — accepted as `_asOfDate` for parity only.
3. `GrniReconciliationService` — all 4 reachable methods plus
   `grniAccount`/`recordAudit` gained `manager?`; its raw-SQL drift
   arithmetic and `save` run on the Company manager; audit writes use it.
4. `GrniReconciliationRun` was never registered in
   `COMPANY_ENTITY_REGISTRY` — added to `accounting-company-entities.ts`
   (`GLAccount` was already registered).

**Module**: `AccountingModule` had `DatabaseRegistryModule` (for the
closing-snapshot scheduler) but **not** `CompanyModule` — added, as
`CompanyContextGuard` needs both. Verified no module cycle:
`CompanyModule`'s import graph (Audit, Identity, Authorization,
Permission, Authentication, DatabaseProvisioning, DatabaseRegistry) never
reaches Accounting.

**Controller**: `CompanyContextGuard` at class level; all 4 routes thread
`req.companyContext.dataSource.manager`.

**Real-PG isolation** (`grni.company-isolation.spec.ts`, 6 tests,
`['sales','inventory','finance','procurement','accounting']` — the first
Accounting-domain use of the harness; real Ledger, Audit, GRNI ledger):
Company A (4 × 5.00 outstanding, empty `grni` GL) → `drift_found`,
subledger `20.0000`, persisted in A's database; Company B (nothing
outstanding) → `matched`, `0.0000` — a leak either way would flip an
outcome; `listRuns` A/B each see only their own run; `getRun`/`closeRun`
of A's run id through B's manager → DENY; `closeRun` A leaves B's run
`matched`; Test F — 6/6 PASS (first run failed only on my spec's table
name `accounting_gl_accounts`, fixed).

**Build**: clean. **Lint**: clean (8 files).

**Full regression**: 105/105 suites, 662/662 tests — fully green on the
first run, no flaky reruns needed (the `LedgerService` and
`GrniLedgerContract` changes are additive and every existing consumer,
including the closing-snapshot suites, passed unchanged).

**Status**: VERIFIED / CLOSED (22nd of the 43). Files changed:
`ledger.service.ts`, `grni-reconciliation.service.ts`,
`grni.controller.ts`, `accounting.module.ts`,
`accounting-company-entities.ts`, `grni-ledger.service.ts` (Procurement),
`grni-events.contract.ts`, `grni.company-isolation.spec.ts` (new).

## §44 — `wip.controller.ts` retrofit (2026-09-28, 23rd controller)

**Dependency review (Tier 2)**: `WipReconciliationService` calls
`LedgerService.getAccountLedger` (made manager-capable in §43),
`AuditService`, and the `@Optional()` `MANUFACTURING_WIP_CONTRACT` bound
to the Manufacturing-owned `ManufacturingWipLedgerService` — which, with
its contract, was **already** manager-capable from Multi-Company Area 9,
and itself delegates to the inventory-valuation contract (closed §22). No
Approval Engine / Tax Engine / cross-domain blocker — SAFE; zero
shared-dependency changes this turn (it consumes §43's `LedgerService`
fix).

**Manager propagation**: all 4 reachable methods (`listRuns`, `getRun`,
`reconcile`, `closeRun`) plus the private `wipAccount`/`recordAudit`
gained `manager?`; the raw-SQL drift arithmetic, run persistence, GL
read, contract call and audit writes all use the Company manager.
Controller: `CompanyContextGuard` at class level, all 4 routes thread
`req.companyContext.dataSource.manager`. Module: `AccountingModule`
already wired (§43).

**Production gap**: `WipReconciliationRun` was never registered in
`COMPANY_ENTITY_REGISTRY` — added to `accounting-company-entities.ts`.

**Real-PG isolation** (`wip.company-isolation.spec.ts`, 6 tests,
`['sales','inventory','finance','procurement','accounting','manufacturing']`;
real Ledger, Audit and `ManufacturingWipLedgerService`): each Company has
its own `wip` control account and Work Order with a **different** WIP
value — Company A 40.00, Company B 70.00 — so any leakage (or summing)
shows directly in `subledgerTotalBase`. The inventory-valuation
dependency is a stub that reads *through the manager it receives* and
would throw on `undefined` (the control plane has no `work_orders`), so
it also proves the manager reaches that layer; the cost engine itself is
proven by §22. Results: `reconcile` A → `40.0000` `drift_found`, B →
`70.0000`; `listRuns` A/B see only their own; `getRun`/`closeRun` of A's
id through B's manager → DENY; `closeRun` A leaves B open; Test F — 6/6
PASS on first run.

**Build**: clean. **Lint**: clean. **Registry completeness**: 2/2.

**Full regression**: 668 tests; 667 passed first run, 1 failed across 3
flagged suites. `payroll-phase1.spec.ts` case 5 (Payroll full lifecycle —
the recurring full-suite contention flake, untouched domain);
`wip.company-isolation.spec.ts` (this retrofit's own new spec) and
`supplier-invoice.company-isolation.spec.ts` both failed as *suite-level*
`permission denied to terminate process` `dropDatabase` teardown races —
confirmed from the failure text, no test inside either failed. All three
PASS serially (22/22). Effective: 668/668.

**Status**: VERIFIED / CLOSED (23rd of the 43). Files changed:
`wip-reconciliation.service.ts`, `wip.controller.ts`,
`accounting-company-entities.ts`, `wip.company-isolation.spec.ts` (new).

## §45 — `sales-returns.controller.ts` retrofit (2026-09-28, 24th controller)

**Dependency review (Tier 2)**: `SalesReturnsService` calls
`NumberingService`, `ProcessEngineService`, `AuditService`,
`InventoryLogisticsContract.recordMovement` (closed §21),
`SalesOrdersReadContract` (`findEligibleReturnPurchaseLines`,
`getOrderLineById`, `getOrder`), `SalesCustomersContract.getCustomerSnapshot`,
the stateless `OrderLineReturnCapacityService` (already takes a manager),
and `ConfigurationEngineService`. No Approval Engine / Tax Engine /
Invoice / `ReturnsService` involvement — the still-BLOCKED `returns.controller.ts`
(§23) and its `InvoiceService.getInvoice` dependency are **not** touched.

**Gaps fixed (mechanical)**: `SalesOrdersReadContract.findEligibleReturnPurchaseLines`
lacked `manager?` (concrete already had it — the recurring contract drift;
widened). `SalesReturnsService` — all 7 reachable methods gained
`manager?`; `registerDocumentType('sales_return')`/`getNextNumber` now use
it; both transactions are `(manager ?? this.dataSource).transaction(async
(txManager) => …)` with the row-locked capacity read, header/line writes
and process start on `txManager`. Controller: `CompanyContextGuard` at
class level, all 6 routes thread `req.companyContext.dataSource.manager`.
`ReturnsModule` gained `CompanyModule` + `DatabaseRegistryModule`
(adding the guard's imports does not change the still-blocked
`ReturnsController`). `SalesReturn`/`SalesReturnLine` were never
registered in `COMPANY_ENTITY_REGISTRY` — added to
`returns-company-entities.ts`.

**Finding for Gate D (Company-aware state/cache audit) — NOT changed,
NOT blocking**: `ConfigurationEngineService.get()` is a *synchronous
in-process cache*, loaded from the ambient/platform `DataSource` on boot
and refreshed periodically — i.e. **installation-wide**, shared by every
Company. `SalesReturnsService` reads one policy value from it
(`logistics.sales_return_eligibility_window_days`, falling back to 365).
It is not Company-owned *data* and no request-time database access
happens, so the controller's data path is Company-isolated; but whether
configuration should be per-Company (a per-Company config cache) is an
architecture decision for the CTO, recorded here rather than expanded
into the foundation engine. Every other `config.get(…)` consumer shares
this property.

**Real-PG isolation** (`sales-returns.company-isolation.spec.ts`, 8
tests, `['sales','inventory','finance','logistics']`; `SalesOrdersService`
and `CustomersService` built with an **inert ambient DataSource** so any
call that missed the Company manager would crash, not silently read the
wrong database): `createSalesReturn` A (3 of 10) and B (5 of 10)
independent; an A order line through B's manager → DENY;
`completeSalesReturn` A writes the restock only into A's `stock_movements`
(B's empty) and ends `completed`; `listSalesReturns` A/B each see only
their own return/state/customer name; `getSalesReturnDetail`/`complete`
of A's id through B's manager → DENY; `listEligiblePurchaseLines` returns
A's line from A's manager and nothing from B's; Test F — 8/8 PASS (first
run needed one seed fix in my spec: the NOT NULL `listPrice` column).

**Build**: clean. **Lint**: clean (6 files).

**Full regression**: 107 suites / 676 tests — **all 676 tests passed**.
Four suites reported a failure with no failing test inside them; the
output contains exactly four `permission denied to terminate process`
messages, one per suite — the documented `dropDatabase` teardown race
(`purchase-request.company-isolation`, `payments.company-isolation`,
`database-provisioning.service`, `memberships-mine.real-pg`). All four
PASS serially (35/35). Effective: 676/676.

**Status**: VERIFIED / CLOSED (24th of the 43). Files changed:
`sales-returns.service.ts`, `sales-returns.controller.ts`,
`returns.module.ts`, `returns-company-entities.ts`, `sales.contract.ts`,
`sales-returns.company-isolation.spec.ts` (new).

## §46 — `shipment-returns.controller.ts` retrofit (2026-09-28, 25th controller)

**Dependency review (Tier 2)**: `ShipmentReturnsService` calls
`NumberingService`, `ProcessEngineService`, `AuditService`,
`InventoryLogisticsContract.recordMovement`, `SalesOrdersReadContract`
(`getOrderSnapshot`, `getOrder`), `SalesCustomersContract.getCustomerSnapshot`
(all already manager-capable), the stateless `OrderLineReturnCapacityService`,
and the concrete `ShipmentService.getShipmentLinesSnapshot`. No Approval
Engine / Tax Engine / Invoice / `ReturnsService` involvement — the
still-BLOCKED `returns.controller.ts` (§23) is not touched.

**Gap in a closed controller's service (fixed in place)**:
`ShipmentService.getShipmentLinesSnapshot` — **zero** `manager?` despite
`shipment.controller.ts` being CLOSED (§29); the second such missed method
after §34's `getCustodianForShipment`. Fixed (both reads now
`(manager ?? this.dataSource)`); not on any contract. Closed-controller
re-proof: `shipment.company-isolation.spec.ts` 5/5 and
`delivery.company-isolation.spec.ts` 7/7 re-run serially after the edit.

**Manager propagation**: all 7 reachable service methods gained `manager?`;
`registerDocumentType('shipment_return')`/`getNextNumber` use it; the
creation transaction (`(manager ?? this.dataSource).transaction(async
(txManager) => …)` — region-limited rename covering the locked capacity
read, the per-line cap query, header/line writes and process start) and
the completion transaction run on `txManager`; the read-only
`getReturnableLines` query uses the manager. Controller:
`CompanyContextGuard` at class level, all 6 routes thread
`req.companyContext.dataSource.manager`. `ReturnsModule` already wired
(§45). `ShipmentReturn`/`ShipmentReturnLine` were never registered in
`COMPANY_ENTITY_REGISTRY` — added to `returns-company-entities.ts`.

**Real-PG isolation** (`shipment-returns.company-isolation.spec.ts`, 8
tests, `['sales','inventory','finance','logistics']`; `ShipmentService`,
`SalesOrdersService`, `CustomersService` built with an **inert ambient
DataSource** so a missed manager crashes rather than misreads):
`createShipmentReturn` A (3 of 10) and B (5 of 10) independent; A's
shipment through B's manager → DENY; `getReturnableLines` reflects only
the owner's prior returns (A: 3 returned/7 remaining, B: 5/5) and 404s
across Companies; `completeShipmentReturn` A restocks only into A's
ledger (B's empty); `listShipmentReturns` A/B each see only their own
state/amount/customer; `getShipmentReturnDetail`/`complete` of A's id
through B → DENY; Test F — 8/8 PASS on first run.

**Build**: clean. **Lint**: clean (whole returns domain + shipment service).
**Registry completeness**: 2/2.

**Full regression**: 108 suites / 684 tests — **all 684 tests passed**.
One suite (`supplier-payment.company-isolation`) reported a suite-level
failure matching exactly one `permission denied to terminate process`
teardown-race message in the output; no test inside it failed. PASSES
serially. Effective: 684/684.

**Status**: VERIFIED / CLOSED (25th of the 43). Files changed:
`shipment-returns.service.ts`, `shipment-returns.controller.ts`,
`shipment.service.ts` (closed-controller gap), `returns-company-entities.ts`,
`shipment-returns.company-isolation.spec.ts` (new).

## §47 — `work-order.controller.ts` retrofit (2026-09-28, 26th controller — first Manufacturing-domain controller)

**Dependency review (Tier 2)**: `WorkOrderService` (the largest service in
the Approval-free set — 760 lines, 17 reachable methods) calls
`NumberingService`, `ProcessEngineService`, `AuditService`,
`EventBusService`, `SalesBomContract.getBomForAssembly`, the F08
`InventoryValuationContract` (`getUnitCost`/`consumeIssueCost`/
`recordReceiptCost`/`consumeManufacturingPooledCost`/`getValuedOnHandTotal`,
all already `manager?`-capable) and the concrete `InventoryService`
(`recordMovement`, `findOperationalSubLocation`, `createWarehouse`,
`reserveStockForReferenceInTransaction`, `releaseReservedQuantityForReference`,
`getOnHandQuantityInTransaction` — all already manager-capable). No
Approval Engine / Tax Engine / cross-domain blocker; **zero shared-
dependency changes**.

**Manager propagation**: every reachable method gained `manager?`
(queries, `computeWipValue`, financial/audit trails, `createWorkOrder`,
`release`, `materialIssue`, `materialReturn`, `finishedGoodsOutput`,
`hold`, `resume`, `complete`, `cancel`). For the three methods carrying a
defaulted `requestId`, `manager` is appended *after* it (the controller
passes `dto.requestId`, `undefined` still triggers the default). All 9
`this.dataSource.transaction(async (manager) => …)` blocks became
`(manager ?? this.dataSource).transaction(async (txManager) => …)` with
every in-transaction call on `txManager` (region-limited rename, then
compiler- and grep-verified); the 3 `dispatchPending()` calls are gated
`if (!manager)`. A latent ambient read was also fixed:
`computeWipValue` passed `this.dataSource.manager` (the ambient one) to
valuation — it now uses the Company manager. Controller:
`CompanyContextGuard` at class level, all 11 routes thread the manager
(the 6-way `Promise.all` in `GET :id` shares one manager).
`ManufacturingModule` gained `CompanyModule` + `DatabaseRegistryModule`.

**Production gap**: `WorkOrder`/`WorkOrderComponent` were never registered
in `COMPANY_ENTITY_REGISTRY` and Manufacturing had **no** manifest file —
new `manufacturing-company-entities.ts`, registered; completeness spec 2/2.

**Gate D note (not changed)**: the controller's `RequireFeatureGuard`
(`manufacturing.work_orders`) resolves from the installation-wide
`ConfigurationEngineService` cache (§45 finding) — feature flags are not
per-Company.

**Real-PG isolation** (`work-order.company-isolation.spec.ts`, 8 tests,
`['sales','inventory','finance','accounting','manufacturing']`; the
service, BOM and Products built with an **inert ambient DataSource**; real
Inventory, Process Engine, Numbering and BOM; the F08 cost engine is a
stub that **throws unless handed the Company manager**, its own isolation
proven by §22): `createWorkOrder` A/B independent; `release` A snapshots
A's BOM (2/unit × 5 = 10), reserves 10 of A's stock and creates the WIP
sub-warehouse only in A (B has none), B stays `draft`; `materialIssue` A
moves 4 units warehouse → WIP in A's ledger (A: 96 + 4 in WIP) while B's
stock stays 100; `hold` A → `on_hold`, B `draft`; `listWorkOrdersWithSummary`
A/B each see only their own order/state/WIP value; `getWorkOrderOrThrow`/
`release`/`materialIssue` of A's id through B's manager → DENY; Test F —
8/8 PASS (one spec fix: the `accounting` migration tag, because
`getFinancialTrail` legitimately reads the accounting tables).

**Build**: clean. **Lint**: all files this retrofit touched are clean. A
whole-domain lint also reports 2 pre-existing errors in
`work-order-phase3-e2e.spec.ts` (`inventoryReconciliation` unused,
`wip` prefer-const) — file unmodified since its own commit (`7079eae`),
not attributable, left untouched.

**Full regression**: 109 suites / 692 tests — **all 692 tests passed**
(including every pre-existing Manufacturing E2E suite against the changed
`WorkOrderService`, which confirms the additive `manager?` is
backward-compatible). One suite (`company-audit-access.real-pg`) reported
a suite-level failure matching exactly one `permission denied to
terminate process` teardown-race message; no test inside it failed.
PASSES serially. Effective: 692/692.

**Status**: VERIFIED / CLOSED (26th of the 43). Files changed:
`work-order.service.ts`, `work-order.controller.ts`,
`manufacturing.module.ts`, `manufacturing-company-entities.ts` (new),
`company-entity-registry.ts`, `work-order.company-isolation.spec.ts` (new).

## §48 — `reports.controller.ts` retrofit (2026-09-28, 27th controller — the cross-domain aggregator)

**Dependency review (Tier 2)**: `reports.controller.ts` fronts
`ReportsService` (6 contract dependencies), `CustomerAccountsService` (8)
and `ExcelService`. `ExcelService` was confirmed **DB-free** (no
`DataSource`/repository — its Matrix "✗" is moot). Every callee turned out
to be mechanical:

- **Contract drift only** (concrete already `manager?`-capable; the
  contract lagged — the 7th–10th recurrences of this class): sales
  `listOrders`, `SalesDepositContract.listDepositsForOrder`;
  `LogisticsShipmentContract` ×4 (`getShipmentByFulfillmentOrderId`,
  `listShippingCompanies`, `listVehicles`, `getCustodianOverview`);
  `LogisticsDeliveryContract.getCollectionForShipmentUnscoped`;
  `FinanceCustomerLedgerContract` ×2 (`getCreditSummary`, `listLedger`).
- **Concrete gaps (3 read-only methods)**:
  `DeliveryService.listAllCollections` (the one method §34 deliberately
  left ambient because *this* controller owns its caller — closed-§34
  re-proof: `delivery.company-isolation.spec.ts` 7/7 re-run);
  `ReturnsService.listReturns`/`getStatus`/`getCreditForReturnRequest`.
  The last three sit in the Returns domain whose controller
  (`returns.controller.ts`, §23) **remains BLOCKED and untouched** — these
  are read-only dependency threading on this controller's call graph, not
  the §23 blocker (`InvoiceService.getInvoice`) and not a retrofit of that
  controller. Both contract families got the `manager?` widening.
- No Approval Engine / Tax Engine / Invoice dependency.

**Manager propagation**: `ReportsService` (5 methods) and
`CustomerAccountsService` (2 methods) thread the manager through every
contract call. Controller: `CompanyContextGuard` at class level; all 12
routes (incl. the 5 `@Res()` export routes, which gained a `@Req()`)
thread `req.companyContext.dataSource.manager`. `ReportsModule` gained
`CompanyModule` + `DatabaseRegistryModule`. No entity-manifest change
(the reports domain owns no entities); registry completeness 2/2.

**Findings for Gate A/C (not changed, not blocking)**:
1. `ReportsService.getSalesOrdersReport` resolves sales-rep display names
   through `UsersService.findById` — a **Platform identity read** by
   design (same precedent as `SalesOrdersService`'s user-name lookups,
   §16). It exposes only ids already present in the Company's own orders
   and never Company data; recorded because the Gate B matrix says
   "Platform DB access NEVER" and this is the intentional exception to
   confirm or replace with a Company-local projection.
2. The reports routes are gated by `RequireModule('reporting')` /
   `PermissionGuard` (entitlement/permission axis) — unchanged.

**Real-PG isolation** (`reports.company-isolation.spec.ts`, 7 tests,
`['sales','inventory','finance','logistics']`): real `DeliveryService`
and `ReturnsService` (inert ambient DataSource); the proven Sales/
Shipment/Finance contracts are stubs that read through the manager and
**throw if handed none**; `UsersService` stubbed (finding 1). Figures
differ per Company on purpose: `getSalesOrdersReport` A/B each only their
own order; `getSalesByCustomer`/`ByPeriod`/`ByRep` 245.00 vs 900.00;
`getCustodyCodReport` A 300.00 vs B 450.00 pending (via the real
`listAllCollections`); `getCustomerAccountStatement` A 245.00 vs B 900.00;
`getCustomerAccountReconciliation` shows A's 40.00 return credit and
none for B (via the real `ReturnsService`); A's customer id through B's
manager → DENY (statement and reconciliation); Test F — 7/7 PASS on first
run.

**Build**: clean. **Lint**: clean. **Registry completeness**: 2/2.

**Full regression**: 110 suites / 699 tests — 698 passed first run, 1
failed. Six flagged suites: five were suite-level `permission denied to
terminate process` teardown races (exactly five such messages in the
output; no test inside them failed — `products`, `wip`,
`shipment-returns`, `supplier-payment` isolation specs and
`company-membership-provisioning.real-pg`), and one was the recurring
`wip-reconciliation.spec.ts` Case D WIP numeric-drift flake (untouched
domain, flaked in earlier runs too). All six PASS individually; in the
batched serial re-run `products.company-isolation` reported a suite-level
failure again (all 34 tests green) and passed 4/4 when run alone — the
same teardown race triggered by back-to-back database teardowns, never a
test failure. Effective: 699/699.

**Status**: VERIFIED / CLOSED (27th of the 43). Files changed:
`reports.service.ts`, `customer-accounts.service.ts`,
`reports.controller.ts`, `reports.module.ts`, `delivery.service.ts`
(`listAllCollections`), `returns.service.ts` (3 read methods),
`logistics.contract.ts`, `sales.contract.ts`, `finance.contract.ts`,
`reports.company-isolation.spec.ts` (new).

## §49 — CONSOLIDATED STOP/ESCALATE: `ApprovalEngineService` blocks 11 further controllers (2026-09-28, evidence only, zero code changed)

§36 recorded, from an import grep, that `ApprovalEngineService` is a
dependency of the services behind 11 controllers beyond
`supplier.controller.ts` (§30), to be *verified per controller, not
assumed*. This section is that verification. A call-graph script mapped
every service method that touches the Approval Engine against the
methods each controller actually calls (HTTP-routed):

| Controller | Approval-touching service methods | Routed from the controller |
|---|---|---|
| `ap.controller.ts` | `submitAdjustment`, `decide` | **yes** |
| `ar.controller.ts` | `submitAdjustment`, `decide` | **yes** |
| `cash-bank.controller.ts` | `submitAdjustment`, `decide` | **yes** |
| `inventory-accounting.controller.ts` | `submitAdjustment`, `decide` | **yes** |
| `fixed-asset.controller.ts` | `submitDisposal`, `decide` (`FixedAssetDisposalService`) | **yes** |
| `attendance.controller.ts` | `submitApprovalBatch`, `listApprovalBatches`, `decide`, `correctDay` | **yes** |
| `commission.controller.ts` | `submitApprovalBatch`, `decide` | **yes** |
| `hr.controller.ts` | `submitLeaveRequest`, `listLeaveRequestsWithApprovalState`, `decide`, `cancelLeaveRequest` | **yes** |
| `payroll.controller.ts` | `submitForApproval`, `decide` | **yes** |
| `rfq.controller.ts` | `awardToSupplier` | **yes** |
| `target.controller.ts` | `submitForApproval`, `decide` | **yes** |

All eleven therefore sit on the same blocker as §30:
`ApprovalEngineService` has **zero** `manager?` capability and is the
engine behind `approval.controller.ts`, one of the 5 explicitly CTO-
excluded Mixed/Special surfaces (§2.2 — "is Approval Company-scoped or
Installation-wide by design?" is still the open, load-bearing decision).
Per the standing rule — foundation / shared-engine / authorization-
boundary → STOP → DOCUMENT → ESCALATE, no partial retrofit of a
controller, no ambient-Platform workaround — **none of the twelve
(these eleven + `supplier.controller.ts`) is touched.**

**What a CTO decision would unlock — one decision, twelve controllers**
(`supplier`, `ap`, `ar`, `cash-bank`, `inventory-accounting`,
`fixed-asset`, `attendance`, `commission`, `hr`, `payroll`, `rfq`,
`target` — 28% of the 43, and by far the largest remaining block):

1. **Decide §2.2**: Approval is Company-scoped (approvals live in each
   Company's own database, `ApprovalEngineService` gains `manager?`, and
   `ApprovalRequest`/related entities join `COMPANY_ENTITY_REGISTRY`) *or*
   Installation-wide by design (then the 12 controllers need a different
   resolution: approvals reference Company resources by id but are stored
   Platform-side, with a per-`resourceType` ownership check). Recommended:
   **Company-scoped** — every one of these 12 domains is already
   Company-owned data, an approver sees only their own Company's requests,
   and it is the same mechanical pattern as the other foundation fixes
   (`ScopeService`, `OrganizationService`, `IdempotencyService`).
2. If Company-scoped is chosen, the work is a **dedicated foundation task**
   (the §30 recommendation): `ApprovalEngineService` + its `ApprovalRequest`
   family manager-threading, consumers' `onApprovalApproved`/`Rejected`
   callbacks and the `onModuleInit` request-type registration (which today
   registers once per installation — itself a Gate D cache/state question),
   then the 12 controllers proceed one at a time through the normal
   pipeline.

**Addendum — `accounting.controller.ts` also blocked (reachability
verified)**: `FiscalPeriodService.submitPeriodClose`/`submitPeriodReopen`/
`submitYearClose` touch the Approval Engine and are all routed from
`accounting.controller.ts` (46 routes, 9 services). It additionally
injects `TaxCodeService`/`TaxPeriodService` (Tax-Engine-adjacent, the
§24 neighbourhood). **STOP/ESCALATE under the same decision** — the
blocked-by-Approval-Engine set is therefore **13 controllers** (the 12
above + `accounting`).

**Queue consequence**: the only remaining *independently safe* controller
is `general-ledger.controller.ts` (no Approval-Engine-touching methods in
`JournalEntryService`/`LedgerService`/`FinancialReportingService`/
`FinancialEventService`); execution continues with it. Everything else is
blocked/escalated as listed here and in §23/§24/§30/§38.

## §50 — CRITICAL CROSS-CUTTING FINDING: the Event Engine has no Company context (2026-09-28, evidence only, zero code changed) — STOP → DOCUMENT → ESCALATE — **RESOLVED by D10 / ADR-075, see §53 (2026-10-04)**

**Classification**: foundation / shared-engine boundary **and** a potential
business-behaviour regression for every Company-routed write that
publishes an event. Found while reviewing `general-ledger.controller.ts`
(whose `FinancialEventService` is itself an event-bus handler) and
double-checking my own `dispatchPending` handling across the retrofits.

**Mechanics (verified by reading `event-bus.service.ts`, not yet by an
executed end-to-end test)**:

1. `EventBusService.publish(manager, …)` writes the outbox row through the
   caller's manager — so for a Company-routed request the row lands in the
   **Company's own** `event_outbox`.
2. `dispatchPending(batch, manager?)` selects pending rows from that
   manager's outbox (Area 9) **or**, with no manager, from the ambient
   (Platform) outbox repository.
3. Handlers are `(payload) => Promise<void>`; the dispatcher invokes
   `handler(row.payload)` — **no manager, no companyId** is passed. Every
   subscriber is a singleton that uses its own ambient `this.dataSource`.
4. No scheduler/dispatcher walks the Companies' outboxes for generic
   events (`ApprovalExpiryScheduler` dispatches only its own expiry
   events for each Company).

**Consequence** — for an operation whose events are published into a
Company outbox: (a) dispatching with the ambient repo finds nothing
(the rows are in the Company DB), so the side effect **never runs**;
(b) dispatching with the Company manager finds the rows but runs the
handlers against the **ambient** database (wrong-DB writes or reads).
Either way the event-driven effect is not Company-correct.

**Surfaces affected** (every `subscribe(` in the codebase, by topic):
- **GL posting**: `FinancialEventService` subscribes one handler per
  finance topic (`deposit.verified`, `collection.remitted`,
  `goods_receipt.posted`, `supplier_payment.recorded`, payment, inventory/
  manufacturing movement events, …) — i.e. **every automatic GL journal**
  for a Company-routed operation.
- **Fulfillment → Shipment handoff**: `ShipmentService` subscribes
  `fulfillment.ready-for-dispatch`.
- **Product events**: `PriceListsService` (`commerce.product.created`) and
  `IntegrationsService` (4 product topics).
- Approval-driven callbacks (`approval.request.approved/rejected`) — the
  §49 blocked set; commission's `finance.invoice.posted`/`collection.remitted`.

**My own convention, disclosed (not a hidden inconsistency)**: the
retrofits so far split three ways — (i) `products.service` /
`inventory.service` dispatch with the Company manager
(`dispatchPending(undefined, manager)`), which finds the rows but runs
ambient-context handlers; (ii) most later retrofits (Fulfillment §31,
Delivery §34, Deposits §36, Goods Receipt §39, Supplier Payment §42, Work
Orders §47) gate `dispatchPending()` on `if (!manager)` — correct when
`manager` is a caller's *transaction* (caller owns the boundary) but, from
a controller, `manager` is the Company's non-transaction manager, so
**nothing dispatches**; (iii) `PaymentsController`/`ReturnsService`
still call ambient `dispatchPending()`. None of these is "right": the
right behaviour depends on the unmade decision below. I did not
unilaterally change any of them (that is the foundation decision).

**Decision requested (one, small in code, large in blast radius)**:
make dispatch Company-aware. Recommended: handlers become
`(payload, ctx: { manager: EntityManager; companyId: string }) =>
Promise<void>`; `dispatchPending(batch, manager)` passes the Company
manager/`companyId` through; every subscriber threads `ctx.manager`
(mechanical — the domains' services are already manager-capable after
this program); in-request dispatch passes the Company manager; and a
**per-Company dispatcher** (same shape as `PreliminaryHoldExpiryScheduler`
/ `ApprovalExpiryScheduler`: iterate ACTIVE Companies via the connection
manager) retries pending rows. Alternative: a Platform-side outbox with a
`companyId` envelope and handlers resolving the Company `DataSource`
through `CompanyConnectionManagerService`. Either way it needs an ADR.

**Recommended proof** (before/with the decision, and required for Gate B):
an executable real-PG test that publishes `deposit.verified` (or
`collection.remitted`) inside Company A and asserts the GL journal appears
in Company A — and **nowhere else** — end to end. Today it would fail.

**Queue consequence**: not blocking the remaining controller work (the
controllers' own data paths are Company-isolated and individually proven),
but **Area 21 cannot be declared VERIFIED** (Gate A/C/D, and "business
behaviour regression" per the closure gate) until this is decided and
proven. Recorded now so it is not discovered at the audit.

## §51 — BOOKKEEPING CORRECTION: the true closed count is 26/43, not 27/43 (2026-09-28)

**Error (mine, now corrected — not silently adjusted)**: from §31 onward
the ordinal labels ("12th of the 43" … "27th of the 43") are **one too
high**. §30 (`supplier.controller.ts`, STOP/ESCALATE, *not* closed) was
described as "attempted as the 11th controller"; the next real closure,
`fulfillment` (§31), was then labelled "12th" instead of 11th, and every
later label inherited the +1. The CTO's baselines ("14/43" after
`delivery`, "15/43" after `bom`) were derived from those labels and are
off by the same one.

**Re-derivation (distinct controllers with a VERIFIED/CLOSED section)**:
1 `sales-orders` (§16), 2 `products` (§17), 3 `price-lists` (§18),
4 `customers` (§20), 5 `inventory` (§21), 6 `inventory-valuation` (§22),
7 `customer-ledger` (§25), 8 `supplier-invoice` (§27), 9 `treasury`
(§28), 10 `shipment` (§29), 11 `fulfillment` (§31), 12 `payments` (§32),
13 `delivery` (§34), 14 `bom` (§35), 15 `deposits` (§36),
16 `warehouse-transactions` (§37), 17 `goods-receipt` (§39),
18 `purchase-order` (§40), 19 `purchase-request` (§41),
20 `supplier-payment` (§42), 21 `grni` (§43), 22 `wip` (§44),
23 `sales-returns` (§45), 24 `shipment-returns` (§46),
25 `work-order` (§47), 26 `reports` (§48).

**Therefore: 26 CLOSED, 17 remaining**, and the 17 are exactly enumerable
(which is the independent check that 26 is right — 26 + 17 = 43):

- **Approval-Engine-blocked (13)**, §30/§49: `supplier`, `ap`, `ar`,
  `cash-bank`, `inventory-accounting`, `fixed-asset`, `attendance`,
  `commission`, `hr`, `payroll`, `rfq`, `target`, `accounting`.
- **Blocked by Tax / Invoice dependency (2)**: `invoices` (§24,
  `TaxEngineService`), `returns` (§23, `InvoiceService.getInvoice`).
- **Escalated — `sales_rep` platform-role ownership (1)**: `sales` (§38,
  same decision as §2.3 / `admin.controller.ts`).
- **Open, independently safe (1)**: `general-ledger`.

No controller was mis-closed; only the *numbering* was wrong. Section
headings/closing sentences from §31 on keep their original text (history
is not rewritten); **this section supersedes their ordinals**: read
"12th" as 11th … "27th" as 26th. All evidence (builds, specs,
regressions) is unaffected.

## §52 — `general-ledger.controller.ts` retrofit (2026-10-04, 27th controller by the corrected §51 count)

**Dependency review (Tier 2, large)**: the controller's 20 routes reach
`JournalEntryService`, `LedgerService` (manager-capable since §43),
`FinancialReportingService`, `FinancialEventService`, and — transitively —
`CurrencyService`, `GLAccountService`, `FiscalPeriodService.assertOpenForPosting`,
`FinancialDimensionService.findTypeByCode`, `ProcessEngineService` (already
manager-capable), `NumberingService` (already manager-capable). **No Approval
Engine / Tax Engine dependency on any reachable path** (`FiscalPeriodService`
holds `ApprovalEngineService`, but only its approval-driven close/reopen paths
use it — `assertOpenForPosting`, the only method on the posting path, does
not). Verdict: SAFE; every shared-service change below is an additive
trailing `manager?` (behavior unchanged when omitted).

**Manager propagation**: `CurrencyService` (`getCurrency`, `getBaseCurrency`,
`getRateOnOrBefore`), `FiscalPeriodService.assertOpenForPosting`,
`GLAccountService` (`assertPostable`, `resolveDimensions`, `hasDimensionRule`),
`FinancialDimensionService.findTypeByCode`, `FinancialReportingService` (every
public method + `accountSection` and the P&L / depreciation / delta /
investing internals), `JournalEntryService` (`listEntries`, `updateEntry`,
`submitEntry`, `reverseEntry`; transaction callbacks use `txManager`),
`FinancialEventService` (`listEvents`, `getEvent`, `ingest`, `redrive`,
handler-through-posting, `buildContext`, `mark/discardDraft/publishRejected`).
Controller: `CompanyContextGuard` at class level; all 20 routes (including the
three `@Res()` export routes, which gained `@Req()`) thread
`req.companyContext.dataSource.manager`. `AccountingModule` already had
`CompanyModule` + `DatabaseRegistryModule` (§43).

**Trap (same as §40)**: a supplied non-transaction Company manager must open
its own transaction, else the journal's pessimistic `lockEntry` fails —
`run = manager?.queryRunner?.isTransactionActive ? fn(manager) : (manager ?? ds).transaction(fn)`
in `createEntry` and `postEntry`.

**Production gaps found (registry)**: `Currency`, `ExchangeRate`,
`GLAccountDimensionRule`, `FinancialDimensionType`, `FinancialDimensionValue`,
`TaxPeriod` were never registered in `COMPANY_ENTITY_REGISTRY`; the completeness
guard additionally caught `ClosingWorkflowRun` (queried by `FiscalPeriodService`,
which became manager-capable this turn). All added to
`accounting-company-entities.ts`.

**Real-PG isolation** (`general-ledger.company-isolation.spec.ts`, 9 tests,
tags `sales/inventory/finance/procurement/accounting`; real Journal, Ledger,
Reporting, Currency, GLAccount, FiscalPeriod, FinancialEvent, Numbering,
ProcessEngine, Audit services; ambient DataSource inert): Company A journal
100.00, Company B journal 250.00. Results: create→submit→post for A lands only
in A (numbered `JV…`, POSTED), B empty; B posts independently; **A→B DENY**
(get/update/submit/post/reverse of A's id through B → not found); **B→A DENY**;
trial balance A 100.00 / B 250.00 (never the sum), foreign account ledger → not
found; balance sheet / P&L per-Company, cash-flow resolves, foreign tax period →
not found; financial-event ingest posts a journal in A only and list/get/redrive
are per-Company (redrive of POSTED event → deduped); reversal of A's journal
nets A and leaves B untouched; Test F (B's DataSource never requested) — 9/9 PASS.

**Build**: clean. **Lint**: clean (whole accounting domain). **Registry
completeness**: 2/2 after adding `ClosingWorkflowRun`.

**Full regression**: 708 tests; 707 passed first run, 1 failed — the registry
completeness case above (a real finding, fixed). Three further suites
(`purchase-order`, `supplier-invoice`, `warehouse-transactions` isolation
specs) failed only as suite-level `permission denied to terminate process`
`dropDatabase` teardown races (no test inside failed). Serial re-run of the
completeness spec + those three + the new spec: all PASS (65/65 tests; the new
spec also passes alone 9/9 — one suite-level transient seen once under
`--runInBand`, not reproducible). Effective: 708/708.

**Disclosed (not fixed here, already escalated)**: the event-bus
`onModuleInit` subscription path of `FinancialEventService` remains ambient —
§50 (Event Engine has no Company context). This controller's `redrive`/`ingest`
manual path is Company-correct; event-driven auto-posting is not until §50 is
decided. `ConfigurationEngineService` reads in the journal are installation-wide
(Gate D).

**Status (CTO-official, 2026-10-04)**: **VERIFIED (technical proof) — PENDING CTO
RATIFICATION.** *Not* formally closed; the 27/43 count is therefore NOT YET FORMALLY
CLOSED until ratified (26 ratified + general-ledger pending). Remaining 16: blocked /
decision required. Ratification package: `docs/decisions/area21/` (patch + evidence);
decision packages: `docs/decisions/area21/AREA21-DECISION-PACKAGES.md`. CTO directive
"AREA 21 — STOP CONTROLLER IMPLEMENTATION": no controller work until the five decisions
are issued. Files changed: `journal-entry.service.ts`,
`financial-event.service.ts`, `financial-reporting.service.ts`,
`currency.service.ts`, `fiscal-period.service.ts`, `gl-account.service.ts`,
`financial-dimension.service.ts`, `accounting-company-entities.ts`,
`general-ledger.controller.ts`, `general-ledger.company-isolation.spec.ts` (new).

## §53 — D10 CLOSED: Event Engine Company context (ADR-075) — resolves §50 (2026-10-04)

**Scope**: Event Engine only (CTO-authorized gate D10). Approval / Config / Tax / `sales_rep` untouched. Controller count unchanged: **27/43** (this is a foundation fix, not a controller closure).

**Executed proof before** (§50 had only a reading): real-PG, event published in Company A + dispatched with A's manager → `{dispatched 0, failed 1}`.

**Delivered** (details and verification record in `ADR-075-event-engine-company-context.md` §2/§7):
handler context `{manager, companyId}`; subscriber scope `ambient` (default) | `company`, ambient handlers never run on a Company outbox (row → `skipped`); Company dispatch with committed lease + `FOR UPDATE SKIP LOCKED`; `dispatchAfterCommit` (no-op in an active transaction); per-Company `CompanyEventDispatcherScheduler`; `CompanyConnectionManagerService.companyIdOf`. Company-scope subscribers: `FinancialEventService` (every automatic GL journal), `ShipmentService` (Fulfillment→Shipment handoff), `PriceListsService` (product → price-list). Still ambient (documented): approval callbacks (Package 1), commission, integrations, fixed-asset `JOURNAL_REVERSED`.

**Call sites changed** (closed controllers' services, `if (!manager) dispatchPending()` → `dispatchAfterCommit(manager)`): treasury ×4, payments (service + controller), deposits, delivery ×3, fulfillment, goods-receipt, supplier-invoice ×2, supplier-payment, work-order ×3. Call sites behind still-blocked controllers (`invoices`, `returns`, `payroll`, `approval-engine`) left ambient.

**Verification**: new `event-engine.company-isolation.spec.ts` (8 real-PG tests incl. identical-identifier A/B isolation, scheduler, skipped, concurrent claim, lease) + 7 unit tests; build clean; lint clean for D10 files; full regression 709/721 first run — 12 failures disposed by isolated rerun (1 real, caused by D10: `treasury.company-isolation.spec` stubbed `events={}`, fixed → 11/11; 5 transient teardown/contention flakes pass isolated); all affected closed-controller isolation specs PASS.

**Remaining effect on Area 21**: §50's blocker for Gate B is removed for the three migrated subscribers; Gate B still needs Approval callbacks (Package 1) and the commission/integrations consumers (their Decision Packages). Gate D (Config installation-wide) unchanged.

**Status**: D10 VERIFIED / CLOSED.

## §54 — D3 CLOSED: inventory movement posting policy — blast radius on closed controllers (2026-10-05)

**Scope**: D3 (inventory posting policy, `D3-INVENTORY-POSTING-POLICY-2026-10-04.md`). Foundation/accounting-side change; **controller count unchanged: 27/43**. Closed controllers whose write paths D3 touched, each re-proved with real-PG A/B isolation (no Platform/shared DataSource, write-path coverage):

| Closed controller | D3 change | Real-PG proof (green) |
|---|---|---|
| `inventory.controller` (`POST /inventory/movements` receipt → `recordManualReceipt`, new `GET /inventory/manual-receipt-reasons`, adjustment/return-in/opening publish events) | D3-A + D3-B | `inventory.company-isolation.spec.ts`, `inventory-posting.company-isolation.spec.ts` (9), `manual-receipt.company-isolation.spec.ts` (12) |
| `warehouse-transactions.controller` (receipt needs `reasonCode` + per-line `unitCostBase`; transfer via `recordTransfer`; reversal rule) | D3-A + D3-B | `warehouse-transactions.company-isolation.spec.ts`, `manual-receipt…` (document path) |
| `sales-returns`, `shipment-returns` (inventory fixtures only; return-in event now exists) | D3-A | their isolation specs (fixtures now use the real `EventBusService`) — green |

**Regression evidence (exact)**: first full run on the shared dev DB 708/760 (+1 skipped) — 51 failures = 13 tests in 2 real-PG suites (harness contention, cleared serially) + 38 tests in 15 suites that need seeded fixtures the freshly rebuilt `daii_dev` no longer had. Those 15 suites were then run on a **separate, disposable, seeded PostgreSQL** (own cluster `127.0.0.1:5656`, not `daii_dev`, not the HR instance): **15/15 suites, 97/97 tests passed** (`d3verify-15c.json`). Two earlier attempts on the same disposable DB (75/97 and an invalid first seed) failed only on missing fixtures (role ids, fiscal year covering today, second admin user, supplier, GL-mapped treasury account) and were fixed in the test environment — zero application code changed. **No D3-caused failure.**

**Status**: D3 VERIFIED / CLOSED. `daii_dev` stays out of the regression loop.

## §55 — D4 CLOSED: Returns accounting — blast radius on closed controllers (2026-10-05)

**Scope**: D4 (`D4-RETURNS-ACCOUNTING-POLICY-2026-10-05.md`). Service/foundation/accounting-side change; **controller count unchanged: 27/43**. Closed controllers whose write paths D4 touched, each re-proved with real-PG A/B isolation (no Platform/shared DataSource, write-path coverage):

| Closed controller | D4 change | Real-PG proof (green) |
|---|---|---|
| `sales-returns.controller` (`completeSalesReturn`: plan → transition → apply; financial reversal) | financial step added | `sales-returns.company-isolation.spec.ts`, `returns-accounting.company-isolation.spec.ts` (12) |
| `shipment-returns.controller` (`completeShipmentReturn`) | same shared policy | `shipment-returns.company-isolation.spec.ts`, `returns-accounting…` |
| `inventory.controller` (`return_in` now carries cost via `recordSaleReturnIn`) | D4 | `inventory.company-isolation.spec.ts` + D3 specs |
| customer-finance (`InvoiceService.getReturnBasis`, ledger credit with the caller's manager) | read-only addition | `customer-ledger`, `payments` isolation specs |
| `returns.controller` (legacy ReturnRequest) | untouched (still BLOCKED, §23) | — |

**Regression (exact)**: one full run on the isolated seeded PostgreSQL (not `daii_dev`): 786/838 (+1 skipped); 38 tests in 4 suites re-run serially → 38/38 PASS (contention); 4 `*.characterization.spec.ts` suites environment-guarded to the HR instance (not executed, unrelated); **no D4-caused failure**. Returns suites 28/28; affected batch 79/79.

**Status**: D4 VERIFIED / CLOSED.

## §56 — D5 CLOSED: Supplier invoice PPV + Input VAT — blast radius on closed controllers (2026-10-05)

**Scope**: D5 (`D5-PPV-INPUT-VAT-POLICY-2026-10-05.md`). Procurement/accounting-side change; **controller count unchanged: 27/43**. Closed controllers whose write paths D5 touched, each re-proved with real-PG A/B isolation (no Platform/shared DataSource, write-path coverage):

| Closed controller | D5 change | Real-PG proof (green) |
|---|---|---|
| `supplier-invoice.controller` (`createDraftInvoice` explicit VAT + variance snapshot; `postInvoice` pre-flight + gross ledger + PPV/VAT event; `voidInvoice` atomic incl. `quantityInvoiced`) | write paths changed | `supplier-invoice.company-isolation.spec.ts` (9), `supplier-invoice-ppv-vat.company-isolation.spec.ts` (16) |
| `supplier-payment.controller` (invoice remaining is now gross-aware) | read semantics | `supplier-payment.company-isolation.spec.ts` (6) |
| `goods-receipt`, `purchase-order`, `purchase-request`, `rfq-supplier` | untouched, re-run for blast radius | their isolation specs — green |
| accounting (`grni`, `general-ledger`, `wip`) | handler + pre-flight | `grni`/`general-ledger`/`wip` isolation specs — green |

**Regression (exact)**: one full run on the isolated seeded PostgreSQL from a stable `dist` snapshot (an earlier run was discarded: concurrent `dist` rebuilds): 840/890 (+1 skipped); 32 tests in 3 suites re-run serially → 32/32 PASS (contention); 4 `*.characterization.spec.ts` suites environment-guarded to the HR instance (not executed, unrelated); **no D5-caused failure**.

**Status**: D5 VERIFIED / CLOSED.

## §57 — AREA 21 EXECUTION CLOSED: the 16 platform-scoped controllers (2026-10-05, CTO-authorized) — **43/43**

**Authorization:** "CTO EXECUTION AUTHORIZATION — AREA 21". Full record: [`docs/acceptance/AREA21_CLOSURE_2026-10-05.md`](../acceptance/AREA21_CLOSURE_2026-10-05.md). Supersedes the blocked classifications of §23, §24, §30, §38 and §49.

**Closed in this execution** (each: service → `manager?` threading, company-scope subscribers, entities in the Company registry, controller on `JwtAuthGuard, CompanyContextGuard, RequireModuleGuard` + `@RequireModule`, real-PG two-company spec): Approval Engine (8), `hr` (6), `targets` (3), `attendance` (5), `commission` (5), `payroll` (5), `rfq`+`supplier` (4), `invoices` (4, with Tax Engine / TaxCode / TaxPeriod), `returns` (4), `sales/reps` (3), `ap`+`ar`+`cash-bank`+`inventory-accounting` (5), fixed assets (4), `accounting` — Chart of Accounts, currencies, dimensions, tax, fiscal years/periods, closing exceptions, FA-01 period close (5).

**Coverage:** `module-enforcement-coverage.js` → domain controllers 43, company-scoped **43**, platform-scoped **0** (`MODULE_ENFORCEMENT_COVERAGE.md` regenerated; `module-enforcement-coverage.spec.ts` + `company-entity-registry.completeness.spec.ts` green).

**Foundation/contract changes (all additive, optional `manager`):** `TaxEngineContract`, `FinanceInvoiceContract.getInvoice`, `SupplierLedgerContract.postEntry/listLedger`, `FinanceTreasuryContract.listTreasuryLedger`, `AuthorizationService.assignRole/revokeRole/getUserIdsForRole`, `ClosingSnapshotService.getRun/listRuns/verify`, `InvoiceService` (all reads/writes, `reverseEntry`), `CustomerLedgerService.reverseEntry`.

**Decision — ADR-073 extension (CTO-RATIFIED 2026-10-05):** every FK referencing `users(id)` is dropped in a Company database (provisioning + harness). **Applied** to the four current Company databases (Alpha, Beta, Gamma, Delta) with backups, a transaction per database, 0 FK→users verified, Platform counts unchanged — evidence in `AREA21_CLOSURE_2026-10-05.md` §7. The five pre-reset databases are untouched.

**Regression (exact, isolated PostgreSQL :5544, never `daii_dev`):** 14 ambient suites on the seeded `daii_test_ambient` run serially → 14/14 suites, 92/92 tests (`closing-exception-visibility.spec.ts` updated to pass a `companyContext`, the handler's new contract). Everything else, one parallel run: 125/127 suites, 794/808 tests (+1 skipped); the 2 failing suites were re-run on their own → `database-provisioning.service.unit.spec.ts` (a mock lacked the catalog query my extension added — fixed) and `release-migrations-endpoint.spec.ts` (load flake, passes alone): 15/15. Excluded: `work-order-phase3-e2e.spec.ts` (historical-state assertions, unchanged).

**Status:** AREA 21 CLOSED in code, in real-PG evidence and in live acceptance; the ADR-073 correction is ratified and applied.

## §57 — D6 CLOSED: RFQ award visibility (maker-checker unchanged) — blast radius (2026-10-05)

**Scope**: D6 (`D6-RFQ-AWARD-VISIBILITY-2026-10-05.md`). Additive read field + duplicate-pending guard on the (already closed) `rfq` controller/service, plus UI; **controller count unchanged: 27/43**.

| Closed controller | D6 change | Real-PG proof (green) |
|---|---|---|
| `rfq.controller` / `RfqService` (`getById.awardApproval`, one live award request per RFQ) | additive | `rfq-award-visibility.company-isolation.spec.ts` (6), `rfq-supplier.company-isolation.spec.ts` (4) |
| approval-engine (read via `listRequests`/`getRequest`, unchanged) | none | `approval-engine.company-isolation.spec.ts` (8), expiry scheduler (4) |
| `purchase-request`, `purchase-order`, `goods-receipt`, supplier invoice/payment | untouched, re-run | their isolation specs — green (71/71 across 10 suites) |

**Regression (exact)**: one full run on the isolated seeded PostgreSQL (stable `dist` snapshot): 891/914 (+1 skipped); `wip-reconciliation` (5) re-run serially → 5/5 PASS (contention); 4 `*.characterization.spec.ts` suites environment-guarded to the HR instance (not executed, unrelated); **no D6-caused failure**.

**Status**: D6 VERIFIED / CLOSED.

## §58 — D1 CLOSED: Item↔Warehouse = Default/Origin warehouse (transferable) — blast radius (2026-10-05)

**Scope**: `D1-ITEM-WAREHOUSE-ASSIGNMENT-2026-10-05.md`. New master-data table + grid scope + assign/unassign routes on the (closed) `inventory` controller; **controller count unchanged: 27/43**. Enforcement across flows is a pending CTO decision (§5 of the record) — not implemented.

| Closed controller | D1 change | Real-PG proof (green) |
|---|---|---|
| `inventory.controller` (grid `scope`, `POST/DELETE warehouses/:id/items`) | additive | `warehouse-item-assignment.company-isolation.spec.ts` (7), `inventory.company-isolation.spec.ts` (7) |
| `warehouse-transactions`, `sales-orders`, `procurement` flows | untouched (not blocked by assignment) | their isolation specs — green in the full run |

**Regression (exact)**: one full run on the isolated seeded PostgreSQL: 894/915 (+1 skipped); `wip-reconciliation` re-run 5/5; 4 characterization suites environment-guarded (HR instance) not run; one suite affected by another session's overwrite of D6 files (fixed, re-proved). **No D1-caused failure.**

**CTO decision (2026-10-05)**: assignment = Default/Origin warehouse, transferable, **no restriction mechanism**; unassign always allowed; Products screen gets an initial/default warehouse. Re-proved: `warehouse-item-assignment` 7/7 and 75/75 across 11 neighbouring suites.

**Status**: D1 VERIFIED / CLOSED.

## §59 — PRC-01 CLOSED: stock visibility in PR / RFQ / PO — blast radius (2026-10-05)

**Scope**: `PRC-01-PROCUREMENT-STOCK-VISIBILITY-2026-10-05.md`. Frontend + one additive field (`warehouseId`) on the (closed) `rfq` read route; **controller count unchanged: 27/43**. "On Order" deferred (no model; business-definition decision recorded).

| Closed controller | PRC-01 change | Real-PG proof (green) |
|---|---|---|
| `rfq.controller` (`GET rfqs/:id` + `warehouseId`) | additive read field | `rfq-award-visibility.company-isolation.spec.ts` (7, incl. per-warehouse official stock figures), `rfq-supplier` (4) |
| `inventory.controller` (`GET /inventory/stock`, unchanged, now used by procurement screens) | none | `inventory.company-isolation.spec.ts` (7), `warehouse-item-assignment` (7) |
| purchase-request / purchase-order / goods-receipt / supplier invoice+payment | untouched, re-run | 93/93 across 13 suites |

**Regression**: targeted (procurement + approval-engine + inventory-warehouse interfaces: 93/93); last full run on the isolated seeded PostgreSQL 894/915 (+1 skipped) with no stage-caused failure.

**Status**: PRC-01 VERIFIED / CLOSED.

## §60 — D8 CLOSED: fixed-asset acquisition-link workflow — blast radius (2026-10-05)

**Scope**: `D8-FIXED-ASSET-ACQUISITION-LINK-2026-10-05.md`. One additive read route on the (closed) `fixed-asset` controller + UI; **controller count unchanged: 27/43**. The manual-JE + link architecture is unchanged; a JE-creation helper is NOT built (needs a counter-account policy).

| Closed controller | D8 change | Real-PG proof (green) |
|---|---|---|
| `fixed-asset.controller` (`GET fixed-assets/:id/acquisition-candidates`, read-only) | additive | `fixed-asset-acquisition-link.company-isolation.spec.ts` (3), `fixed-asset.company-isolation.spec.ts` (4) |
| journal engine (manual create/post used by the spec), `general-ledger` | untouched | `general-ledger.company-isolation.spec.ts` (9) |

**Regression**: targeted (23/23 tests across the 4 suites; one suite-level teardown flag after its tests passed); last full run on the isolated seeded PostgreSQL 894/915 (+1 skipped) with no stage-caused failure.

**Status**: D8 VERIFIED / CLOSED.

## §61 — D9 CLOSED: supplier master edit + auto-numbered code — blast radius (2026-10-05)

**Scope**: `D9-SUPPLIER-MASTER-EDIT-AUTONUMBER-2026-10-05.md`. `supplier.controller` (closed) gains one route (`POST suppliers/:id/update`) and an optional `code` on create; **controller count unchanged: 27/43**. No per-supplier GL account (AP architecture unchanged).

| Closed controller | D9 change | Real-PG proof (green) |
|---|---|---|
| `supplier.controller` (`POST :id/update`, create `code` optional) | additive | `supplier-master.company-isolation.spec.ts` (6), `rfq-supplier.company-isolation.spec.ts` (suppliers + bank-account approval) |
| supplier-invoice / supplier-payment / purchase-order / goods-receipt / purchase-request / rfq | untouched, re-run | 10 suites, 68/68 tests serially |

**Regression**: targeted (procurement: 10/10 suites, 68/68, one serial run on the isolated seeded PostgreSQL); last full run 894/915 (+1 skipped) with no stage-caused failure.

**Status**: D9 VERIFIED / CLOSED.

## §62 — P2 UI batch (SHR-01 + COA-01) — frontend only (2026-10-05)

**Scope**: `P2-UI-BATCH-SHR01-COA01-2026-10-05.md`. Two frontend pages; **no controller touched, count unchanged: 27/43**. COA-01 uses the existing closed `accounting.controller` route `POST accounts/:id` — re-proved by `accounting.company-isolation.spec.ts` (5/5). D7 parked at its policy gate (`D7-NEW-ITEM-REQUEST-2026-10-05.md`).

## §63 — D7 CLOSED: New Item Request + product lifecycle gate — blast radius (2026-10-05)

**Scope**: `D7-NEW-ITEM-REQUEST-2026-10-05.md`. Draft Product = request; Approval Engine (1 approver, `sales.catalog.edit`); gate at PR approval, PO creation, Goods Receipt. New Company-scoped controller `procurement/item-requests` (outside the 43). **Area 21 count unchanged: 27/43.**

| Closed controller / service | D7 change | Real-PG proof (green) |
|---|---|---|
| `purchase-request.controller` (approve gate, RFQ gate) | behaviour: refuses a non-active item | `purchase-request` (6), `new-item-request` (8) |
| `purchase-order.controller` (create gate; also RFQ award → PO) | refuses a draft item | `purchase-order` (7), `rfq-supplier` (4), `rfq-award-visibility` (7) |
| `goods-receipt.controller` (post gate) | refuses a draft item | `goods-receipt` (6, incl. new D7 test) |
| `products.controller` / `ProductsService` (contract methods only) | additive | `products` (4), `price-lists` (7), `bom` (7) |
| approval engine | untouched, re-run | `approval-engine` (8), `approval-expiry` (4) |

**Regression**: one serial run on the isolated seeded PostgreSQL — 22 suites, 135 passed + 1 skipped (T0 baseline, skipped by design), 0 failed; `AppModule` boot spec (grni-reconciliation 3/3) proves DI wiring. Also in that run: D8 `fixed-asset-acquisition-link` 3/3 + `fixed-asset` 4/4 (D8 evidence).

**Status**: D7 VERIFIED / CLOSED (browser verification NOT PERFORMED).

## §64 — FA-02 CLOSED: fixed-asset disposal gain/loss accounts — blast radius (2026-10-06)

**Scope**: `FA-02-DISPOSAL-GAIN-LOSS-ACCOUNTS-2026-10-06.md`. Behaviour change inside the (closed) `fixed-asset.controller`'s disposal submit/decide path + the disposal posting handler; no route, schema or config key added. **Count unchanged: 27/43.**

| Closed controller / engine | FA-02 change | Real-PG proof (green) |
|---|---|---|
| `fixed-asset.controller` (submit / decide disposal) | rejects before mutation when the needed gain/loss account is unusable | `fixed-asset-disposal-gain-loss` (5), `fixed-asset` (4) |
| financial-event handler (disposal) / `FinancialEventService` (+ public pre-flight method) | resolves only the needed side | `event-engine` (8), `inventory-posting` (9), `manual-receipt` (12), `returns-accounting` (12), `supplier-invoice-ppv-vat` (16), `treasury-bank-leg` (7) |
| general ledger / sub-ledger controllers | untouched, re-run | `general-ledger` (9), `subledger-controllers` (5) |

**Regression**: one serial run, 17 suites, 133 passed + 1 skipped (T0 baseline, by design), 0 failed; `AppModule` boot (grni-reconciliation 3/3).

**Status**: FA-02 VERIFIED — UAT READY (Production = HOLD; not DONE). Reconciliation proof (NBV / gain / loss with real depreciation) added: 5/5 in `fixed-asset-disposal-reconciliation`; focused regression 40/60 first run, 3 infra-contention suites individually re-run 20/20 (see the FA-02 record, section 6).

## §65 — CUS-01 CLOSED: on-account / advance customer payment — blast radius (2026-10-06)

**Scope**: `CUS-01-ON-ACCOUNT-CUSTOMER-PAYMENT-2026-10-06.md`. Three additive routes on the (closed) `payments.controller`, a nullable `invoiceId`, one new ledger entry type, a guard in the ledger sweep. **Count unchanged: 27/43.** No new GL account, no AR-reconciliation change, deposits/COD untouched.

| Closed controller / service | CUS-01 change | Real-PG proof (green) |
|---|---|---|
| `payments.controller` / `PaymentsService` | additive routes + methods | `on-account-payment` (7), `payments` (5) |
| `customer-ledger` (sweep guard, new entry type) | behaviour guard | `customer-ledger` (5), `invoices` (4), `deposits` (6) |
| AR sub-ledger and GL, Treasury and GL | untouched, proved reconciled | `subledger-controllers` (5), `treasury-bank-leg` (7), `reports`, `returns-accounting` (12) |

**Regression** (worded exactly in the record, section 7): 167/201 +1 skipped first run; 4 infra failures cleared individually; 4 other-session manufacturing suites need migrations absent from the isolated DB; full run 948/981 with only other-session / guarded failures.

**Status**: CUS-01 VERIFIED / CLOSED (browser verification NOT PERFORMED).

## §66 — Company-scoped journal numbering fix — blast radius (2026-10-06)

**Scope**: `JOURNAL-COMPANY-NUMBERING-2026-10-06.md`. One private method + one call inside `JournalEntryService.postEntry` (the closed journal engine); **no controller, schema, migration or numbering-architecture change. Count unchanged: 27/43.** Per-Company lazy registration on the drawing manager; no ambient fallback; no shared sequence.

| Closed area | Effect | Real-PG proof (green) |
|---|---|---|
| journal engine / GL (`general-ledger`, `accounting.company-isolation`) | first post in a Company now self-registers its sequence | `journal-numbering` (5, reproduces the defect pre-fix), `general-ledger` (9) |
| Event Engine → GL posting | event-driven postings no longer rejected on a fresh Company | `event-engine` (8), `journal-numbering` test 3, live fresh-Company payment event POSTED |
| posting domains (inventory, returns, procurement, treasury, fixed assets, payroll) | unchanged behaviour where the sequence exists | `inventory-posting` (9), `manual-receipt` (12), `returns-accounting` (12), `supplier-invoice-ppv-vat` (16), `treasury-bank-leg` (7), `fixed-asset` ×4 |
| provisioning | a freshly provisioned Company posts journals with no manual setup | `database-provisioning` (4), `company-lifecycle-layer1` (10), live provisioning run |

**Regression**: 205/220 first run (+1 skipped); all 14 failures are four manufacturing/WIP suites missing other sessions' migrations in the isolated DB (pre-existing/infrastructure). Not a full-repository regression.

**Open**: Companies that already produced REJECTED events from this defect need a replay/data-repair decision.

## §15 — What This Document Is Not

Not an implementation. Not a decision on the 5 Mixed/Special. Not a
migration. Not a change to any guard, service, or entity. The next step
per your own sequencing is your review/correction of this Matrix, then
explicit authorization to begin `CODE → TEST → REAL-PG VERIFY → REGRESSION → DOCUMENT → NEXT`
on a first controller (or Tier 1 batch) — not all 43 at once blind.
