# D-04 — Integrations become Company-scoped: implementation plan, migration implications and test specification (2026-10-11)

**Decision D-04: COMPANY-SCOPED.** Company-specific integration configuration, credentials and operational data are accessed through the correct Company context and database; genuinely platform-wide control-plane metadata is separated explicitly; isolation tests must prove that one Company cannot reach another Company's integration data; no destructive migration, no silent relocation of existing data; **plan and migration implications are documented here BEFORE any schema or routing change.**
**Status of this document: PLAN + TEST SPECIFICATION. No code, migration or routing has been changed.** It follows `INTEGRATIONS-TENANCY-DECISION-RECORD-2026-10-11.md` (evidence) and replaces its "decision pending" with option A, refined below. Open items for review are marked **[REVIEW]**.

## 1. Inspection of the current paths (VERIFIED by reading the code; `integrations.service.ts` 626 lines, guard 72, controllers 197+69)
| Concern | Today | Problem for a Company-scoped model |
|---|---|---|
| Tables | `integration_connectors`, `integration_credentials`, `integration_product_mappings`, `integration_sync_logs` are created by the **`sales` Company tag** (`migrations/sales/1755846200000-CreateIntegrationTables.ts`) → they already live in every Company database | fine — the data is already placed correctly; the code addresses the wrong database |
| Access | `IntegrationsService`, `IntegrationAuthGuard` use the **ambient** `DataSource` for every connector, credential, mapping and log query | in a multi-Company installation the ambient database has no such tables (T-18) |
| Domain calls | `products.getProductSnapshot/listAllProducts`, `inventory.getTotalAvailable/listWarehouses`, `salesOrders.createOrder/getOrderStatus`, `customers.findByPhone/createCustomer/assignSalesRep` are called **without a manager** | they run on the ambient connection, not the Company's. `getProductSnapshot`, `listAllProducts`, `createCustomer`, `assignSalesRep`, `createOrder`, `getOrderStatus` already accept `manager?`; **`customers.findByPhone(phone)` and `inventory.getTotalAvailable(productId)` do not** |
| Event fan-out | `onModuleInit` subscribes (ambient scope) to four `commerce.product.*` topics and pushes to every *connected* connector of the ambient DB | Company outbox events are never delivered to ambient-scope handlers (row → `skipped`, ADR-075 §5) — product changes cannot reach a Company's connectors |
| Admin routes | `integrations.controller.ts`: 15 routes, `JwtAuthGuard` + `RolesGuard`, no Company context; `publish/order-status` accepts a client-supplied `salesOrderId` | confused-deputy: an id from any Company reaches the service (Area 21 §2.4) |
| Partner intake | `integration-order-intake.controller.ts` + `IntegrationAuthGuard`: headers `X-Daii-Connector-Id` + `Authorization: Bearer <secret>`; no user, no membership, no Company id in the payload | the guard has no way to know which Company's database holds the connector |
| Credentials | encrypted by `CredentialCipherService` (`encrypt` at creation, `decrypt` in the guard); stored in `integration_credentials` | key handling is installation-level; unaffected |
| Platform-wide metadata that is NOT Company data | `integration_providers` (catalog, created by core migration `1790008000000-IntegrationProviderCatalog`) | stays in the control plane; read-only reference |

## 2. Target design (option A of the evidence record, refined)
1. **Connector directory (control plane, new, additive):** table `integration_connector_directory (connector_id uuid PK, company_id uuid NOT NULL, created_at)` in the `core` tag. It holds **only** the routing fact "connector X belongs to Company Y" — no secrets, no configuration. It is written in the same operation that creates a connector inside a Company; removing a connector removes its row. **[REVIEW]** alternative: derive the Company from a prefix embedded in the connector id (rejected: forgeable naming, no revocation).
2. **Guard (`IntegrationAuthGuard`):** (a) read `X-Daii-Connector-Id` and the bearer token; (b) resolve `company_id` from the directory (control plane); unknown id → the same generic 401 as today; (c) obtain that Company's DataSource through `CompanyConnectionManagerService`; (d) load connector + latest non-revoked credential **from the Company database**, constant-time compare after decrypt; (e) attach `req.companyContext = { companyId, dataSource }` and `req.connector`. The Company is never taken from the request body or any other client-supplied field.
3. **Service:** every method takes the Company `manager` (additive trailing parameter, like the rest of Area 21) and uses it for all repository access and all domain calls; domain calls receive the same manager. `findByPhone` and `getTotalAvailable` get an additive optional `manager` (no behaviour change for existing callers).
4. **Admin controller:** `JwtAuthGuard` + `CompanyContextGuard` + `PermissionGuard` with a Company-level permission node for integrations (to be registered in the module manifest); `publish/order-status` validates that the `salesOrderId` exists in the caller's Company database (404 otherwise) before use. Platform administrators keep their separate platform surface only for the provider catalog.
5. **Events:** the product-change fan-out subscribes with `{ scope: 'company' }` and uses `ctx.manager` / `ctx.companyId` to read **that Company's** connected connectors; ambient subscription removed.
6. **Ambient (legacy single-database) installations:** the single database plays both roles; the directory row is created from the existing connector rows by an **additive back-fill** (insert missing rows only), so existing installations keep working without moving any data.

## 3. Migration implications (nothing applied)
| Step | Kind | Destructive? | Notes |
|---|---|---|---|
| M1 | `CREATE TABLE integration_connector_directory` in `core` | no (additive) | one table, one unique index; reversible by `DROP TABLE` (empty) |
| M2 | Back-fill the directory from existing `integration_connectors` rows of each Company database (and of the legacy single database) | no (insert-only, idempotent) | executed by the release engine per Company; a connector whose Company cannot be determined is **reported, not guessed** |
| M3 | Remove the ambient registration of the four integration entities from `IntegrationsModule` | code only | after M1–M2 and the tests below pass |
| — | **No table is moved or dropped. No data is relocated.** The four tables stay where they already are (Company database). | | |
Pre-flight (read-only, operator): count rows in the integration tables of the ambient/control-plane database of each real installation — expected 0 in multi-Company installations; any non-zero count must be reviewed before M3. **[REVIEW]** whether any installation currently has connectors (UNVERIFIED; needs the D-02-class operator).
Rollback: M3 is a code revert; M1 is a drop of an empty table; M2 deletes only directory rows it created (marked by a `source` column **[REVIEW]**).

## 4. Test specification (to be implemented together with the change, on the guarded local cluster; two-Company harness `setUpTwoCompanyHarness`)
Fixture: Company A and Company B, each with a connector (own credential), products, warehouse, customers; a connector-identity helper replaces the user fixture.
| # | Case | Expected |
|---|---|---|
| I-01 | A's connector authenticates with its own credential on the intake endpoint | 201; order created in **A's** database only; B unchanged (table fingerprints) |
| I-02 | A's connector id with **B's** credential | 401 (generic), no Company query executed against B |
| I-03 | B's connector id with A's credential | 401 |
| I-04 | Unknown connector id; revoked credential; disconnected connector | 401, no information leak (same body for all) |
| I-05 | Intake payload carrying a foreign `companyId`/`salesOrderId`/`customerId` field | ignored or 400 (whitelist); never used for routing |
| I-06 | A's connector replays the same `externalOrderId` | `duplicate: true`, one order |
| I-07 | Admin `GET /integrations/connectors` as A's admin | only A's connectors; as B's admin only B's; as a user of neither → 404/403 |
| I-08 | Admin `publish/order-status` with an `salesOrderId` belonging to B, called in A's context | 404, nothing published |
| I-09 | Product change in A | pushes only to A's connected connectors; B's connectors untouched (company-scope subscriber) |
| I-10 | Control-plane database lacking Company tables (T-18 setup) | the module starts and answers; no query against missing tables (T-18 control-plane structural check PASS) |
| I-11 | Ambient/legacy single-database install | existing connectors keep working after the back-fill; directory rows = connector rows |
| I-12 | Directory row deleted/missing for an existing connector | intake returns the generic 401; admin shows the connector as "unrouted" **[REVIEW]** |
| I-13 | Cross-Company concurrency: 20 parallel intake calls (A and B interleaved) | each order lands in the right database; no duplicate numbers (N-01 fix in place); audit chains valid in both |
| I-14 | Credential encryption: A's credential cannot be decrypted into B's context (different connector rows) | n/a by design; verify ciphertext rows differ and decrypt only through the owning connector |
| I-15 | Regression: existing integration specs, intake contract (request/response shapes, headers) | unchanged |
Acceptance for closing D-04: I-01…I-15 PASS from a clean snapshot; T-18 control-plane structural PASS; business suite and isolation specs unchanged; the directory back-fill proven on a copy of a legacy single-database fixture.

## 5. Risks and unknowns
- Whether any real installation holds connector rows in the ambient database (UNVERIFIED, needs read access) — decides how much of M2 is needed in practice.
- The permission node and manifest change touch the authorization model (Area 21/Authorization tracks) — review with their owners.
- Partner-facing contract (headers, payload) is deliberately unchanged; external partners need no change.
- Estimated work: service + guard + controller + one core migration + eleven spec cases; no domain behaviour change beyond two additive optional parameters.

## 6. Decision log
| Date | Item | State |
|---|---|---|
| 2026-10-11 | D-04 scope Company-scoped | decided (CTO) |
| 2026-10-11 | Plan, migration implications and test specification | **documented — awaiting review of the [REVIEW] items before implementation** |
