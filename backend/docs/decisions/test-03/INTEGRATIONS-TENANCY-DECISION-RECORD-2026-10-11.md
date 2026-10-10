# R4 — Integrations module tenancy: evidence and decision record (2026-10-11)

**Status: EVIDENCE RECORDED — DECISION PENDING. No migration, routing or ownership change has been made or prepared in code.** (CTO directive §3: document the decision and supporting evidence before changing migration ownership or database routing.) This record connects TEST-03 finding D-03 to the existing, still-open Area 21 decision for `integration-order-intake.controller.ts` and `integrations.controller.ts` (`docs/decisions/AREA21-RETROFIT-MATRIX.md` §2.1 and §2.4: "Escalate as an architecture decision, not an implementation default").

## 1. Evidence (all VERIFIED unless marked)
| # | Fact | Where |
|---|---|---|
| 1 | The four integration tables (`integration_connectors`, `integration_credentials`, `integration_product_mappings`, `integration_sync_logs`) are created by a migration in the **`sales`** tag (a Company-database tag): `src/database/migrations/sales/1755846200000-CreateIntegrationTables.ts` | migration scan |
| 2 | A control-plane database migrated with the `core` tag does **not** contain them: the schema builder reports 4 pending `CREATE TABLE` statements for the integration entities (T-18) | `evidence-2026-10-10-biz/T-18/T-18-20261010T212835Z-998e9a/T-18-control-plane-drift.json` |
| 3 | `IntegrationsModule` registers the four entities with `TypeOrmModule.forFeature` — the **ambient** DataSource — and `IntegrationsService`, `IntegrationAuthGuard` use `this.dataSource` (ambient) for every connector/credential/mapping/log query | `integrations.module.ts:35`, `integrations.service.ts` (lines 126–560), `interface/integration-auth.guard.ts:43` |
| 4 | The same service calls Company-owned domain services **without a manager**: `products.getProductSnapshot/listAllProducts`, `inventory.getTotalAvailable`, `salesOrders.getOrderStatus`, `customers.findByPhone/createCustomer/assignSalesRep` — i.e. against the ambient connection, not a Company connection | `integrations.service.ts:316,350,396,445–447,490,529,556–559` |
| 5 | `IntegrationConnector` has no Company-binding column; the order-intake request carries no Company identifier; there is no `req.user`/membership on that path | Area 21 matrix §2.1 (entity column list confirmed again here via the entity metadata in T-18) |
| 6 | `foundation/integrations` imports four domain services directly (layering inversion A-02) | `evidence/arch-graph.json` |
| 7 | Controller scan: `integrations.controller.ts` (15 routes) has JWT + roles but neither `CompanyContextGuard` nor a platform guard; `integration-order-intake.controller.ts` uses only `IntegrationAuthGuard` | `evidence/controller-guard-scan.json` |
| 8 | No spec references `IntegrationsService` by name (reference map) | `evidence/test-reference-map.json` (INFERRED: name-based) |

## 2. What this means (INFERRED where it depends on the deployment)
- In a **multi-Company** installation (control-plane DB + one DB per Company) the module cannot work as written: its own tables are missing from the control plane and the Company data it reads/writes lives in Company databases it never connects to. In the **legacy single-database** installation (ambient DB carries every tag) it works, which is presumably why it has not failed in use. Whether any production installation currently has integrations enabled is **UNVERIFIED** (needs D-9-style read access; the module is gated by entitlement).
- Security: an integration credential has no Company boundary to enforce (Area 21 §2.1 "most severe of the 5").

## 3. Options (for the CTO; none implemented)
| Option | Shape | Pros | Cons / risks | Needs |
|---|---|---|---|---|
| **A. Company-scoped integrations** | Connector, credential, mapping, log become Company data (already in the `sales` tag). Add a fixed `companyId` binding for the *route to the Company database*, resolved from the connector record in a small **platform-level connector directory** (control plane: connector id → Company), then the service runs with that Company's manager | Matches the data's real owner; every domain call gets a Company manager; credentials live with the Company's data; fits Area 21 | New control-plane table + provisioning flow; guard must resolve Company before any Company query; migration of existing connectors; new test fixture (connector identity instead of user) | Architecture decision; migration plan; tests |
| **B. Platform-scoped integrations** | Move the four tables' creation to the `core` tag (control plane); keep `companyId` on the connector as a **column** and route each call to that Company's manager | One place for connector admin; fewer moving parts for the guard | Credentials and product mappings (which reference Company products) live outside the Company database → backup/restore and data-ownership split; Company deletion must clean platform rows | Architecture decision; core migration; data move |
| C. Keep as is (single-DB installations only) | Declare the module unsupported in multi-Company mode and block enablement | No change | Feature unavailable to new installations; the open security gap remains for legacy ones | Policy decision |
Recommendation (engineering, non-binding): **A**, because every business table the connector touches is already Company-owned, and it closes Area 21 §2.1/§2.4 with one binding; it needs a connector→Company directory in the control plane.

## 4. Acceptance criteria for whichever option is chosen (to be tested before release)
1. Connector authentication resolves exactly one Company from server-side data, never from the request; a connector of Company A cannot read or create anything in Company B (A/B fixture with connector identity).
2. `T-18` control-plane structural check PASS (no entity without its table in the database that owns it).
3. All domain calls made by `IntegrationsService` receive the Company manager (no ambient reads of Company data); covered by a spec that runs with the control plane lacking Company tables.
4. Existing connectors migrated without credential loss; rollback documented.
5. Entitlement gate and audit records preserved.

## 5. Decision log
| Date | Decision | By |
|---|---|---|
| 2026-10-11 | Evidence recorded; **decision pending**; migration ownership and DB routing unchanged | — |
