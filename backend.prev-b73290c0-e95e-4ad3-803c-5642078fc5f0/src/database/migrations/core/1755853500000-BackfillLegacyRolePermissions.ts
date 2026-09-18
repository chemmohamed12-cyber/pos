import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P4 Tranche-2 (ERP Foundation) — SAFETY PREREQUISITE for the domain guard
 * swap (`@RequireRole` → `@RequireModule`/`@RequireFeature`/
 * `@RequirePermission`).
 *
 * The Permission Engine has NO role bypass (`permission.service.ts`
 * `resolve()` — deny-by-default, purely `role_permissions` rows). The new
 * P4-F2 module role templates (`inventory.manager`, `sales.manager`, …)
 * are ADDITIONAL roles seeded by `ModuleRoleTemplateSeeder` — they do
 * NOT grant anything to the SIX pre-existing legacy roles
 * (`admin`, `finance`, `inventory_controller`, `sales_manager`,
 * `sales_rep`, `warehouse_worker`) that every current `@RequireRole(...)`
 * call site actually names.
 *
 * Swapping a guard without this migration would silently 403/404 every
 * real user holding one of these six roles — a genuine, undocumented
 * regression. This migration grants each legacy role EXACTLY the
 * permission nodes needed to reproduce its current, already-shipped
 * effective access — derived by reading every `@RequireRole(...)` call
 * site across all 14 domains (evidence:
 * `planning/erp-foundation/evidence/P4/legacy-role-mapping.md`), not
 * guessed. `admin` appears in every gated route in the codebase, so it
 * gets `editable` at all 5 module top-level nodes (exact match for its
 * current de-facto universal access — not an over-grant, since it
 * already had it). The other five roles get precise, narrower grants
 * matching only the specific routes they are currently named on.
 */
export class BackfillLegacyRolePermissions1755853500000 implements MigrationInterface {
  name = 'BackfillLegacyRolePermissions1755853500000';

  private readonly grants: Array<{ role: string; node: string; access: 'read-only' | 'editable' }> = [
    // admin — every @RequireRole call site in the codebase names 'admin'.
    // Top-level 'editable' per module = exact match for current universal access.
    { role: 'admin', node: 'sales', access: 'editable' },
    { role: 'admin', node: 'inventory', access: 'editable' },
    { role: 'admin', node: 'logistics', access: 'editable' },
    { role: 'admin', node: 'finance', access: 'editable' },
    { role: 'admin', node: 'reporting', access: 'editable' },

    // finance — treasury.controller (whole-controller gate) + specific
    // finance-touching routes in otherwise non-finance domains.
    { role: 'finance', node: 'finance', access: 'editable' }, // treasury (whole controller) + customer-finance (invoices/payments)
    { role: 'finance', node: 'logistics.collection', access: 'editable' }, // delivery: pending-remittance, remit
    { role: 'finance', node: 'sales.deposit', access: 'editable' }, // deposit-control: approve/reject
    { role: 'finance', node: 'reporting.finance', access: 'editable' }, // reports: custody-cod (view+export)
    { role: 'finance', node: 'logistics.return', access: 'editable' }, // returns: apply-credit-to-invoice
    // P4 Tranche-2 (2026-09-06) — CORRECTED to the `.edit` leaf, not the
    // coarse `logistics.carrier`/`logistics.vehicle` parent: a grant at
    // the parent node would, via the Permission Engine's ancestor-walk,
    // ALSO unlock every other descendant action under it — including
    // `logistics.carrier.create`/`logistics.vehicle.create`, which
    // `finance` was never granted under the pre-P4-T2 `@RequireRole`
    // gates (those two routes were `@RequireRole('admin')` only). Found
    // by `shipment.controller.authz.spec.ts`'s legacy-role-equivalence
    // test — the coarse grant would have been a real, undocumented
    // access-widening regression, not a workaround-free fix.
    { role: 'finance', node: 'logistics.carrier.edit', access: 'editable' }, // shipment: set shipping-company treasury account
    { role: 'finance', node: 'logistics.vehicle.edit', access: 'editable' }, // shipment: set vehicle settlement account

    // sales_manager — commerce/price-lists.controller (7 CRUD routes) +
    // crm: assign/workflow-policy/price-list/classification (NOT
    // status/financial-settings, which stay admin-only — see the 2 new
    // sales.customer.status/financial_settings leaf nodes added below).
    { role: 'sales_manager', node: 'sales.price_list', access: 'editable' },
    { role: 'sales_manager', node: 'sales.customer.edit', access: 'editable' },
    { role: 'sales_manager', node: 'sales.customer.assign', access: 'editable' },

    // sales_rep — inventory-warehouse: reserveStock only (existing node).
    { role: 'sales_rep', node: 'inventory.reservation.create', access: 'editable' }, // node added to inventory.manifest.ts this phase

    // warehouse_worker — inventory-warehouse: opening-stock import, record
    // movement, assemble, release reservation.
    { role: 'warehouse_worker', node: 'inventory.movement.create', access: 'editable' },
    { role: 'warehouse_worker', node: 'inventory.assembly.create', access: 'editable' },
    { role: 'warehouse_worker', node: 'inventory.reservation.release', access: 'editable' }, // node added to inventory.manifest.ts this phase
    // P4 Tranche-2 (2026-09-06, remaining-9-domains pass) — warehouse-
    // transactions.controller.ts's 3 sites, read directly (not inherited
    // from this file's own earlier, now-corrected comment below):
    // `create` is (warehouse_worker, admin) only — a distinct parent
    // (`inventory.transaction`) from stock-count, so its own leaf grant.
    { role: 'warehouse_worker', node: 'inventory.transaction.create', access: 'editable' },
    // `startCount`/`recordCountResults` share the IDENTICAL 3-role set
    // (warehouse_worker, inventory_controller, admin) on sibling leaves
    // (`.create`/`.adjust`) under the same parent — coarse parent grant is
    // safe here (no third, narrower-role route under `inventory.stock_count`
    // to over-grant into), matching the existing `inventory_controller`
    // grant below.
    { role: 'warehouse_worker', node: 'inventory.stock_count', access: 'editable' },

    // inventory_controller — stock-count routes (Warehouse & Inventory
    // Control UX/UI V1 directive). CORRECTED (2026-09-06, remaining-9-
    // domains pass): this file's original comment claimed "no
    // @RequireRole('inventory_controller') call site exists yet" — that
    // was true when this migration was first written, but is no longer
    // true: `warehouse-transactions.controller.ts`'s `startCount`/
    // `recordCountResults` both name it directly (confirmed by direct
    // read, 2026-09-06). The grant below already matches what those two
    // routes need — no widening required, just this comment correction.
    { role: 'inventory_controller', node: 'inventory.stock_count', access: 'editable' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const g of this.grants) {
      const role = await queryRunner.query(`SELECT "id" FROM "roles" WHERE "key" = $1`, [g.role]);
      if (role.length === 0) {
        // Role doesn't exist in this environment (e.g. a fresh/minimal
        // install) — skip rather than fail; nothing to backfill for a
        // role nobody holds.
        continue;
      }
      await queryRunner.query(
        `INSERT INTO "role_permissions" ("roleId", "nodeKey", "access") VALUES ($1, $2, $3)
         ON CONFLICT ("roleId", "nodeKey") DO UPDATE SET "access" = EXCLUDED."access"`,
        [role[0].id, g.node, g.access],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const g of this.grants) {
      const role = await queryRunner.query(`SELECT "id" FROM "roles" WHERE "key" = $1`, [g.role]);
      if (role.length === 0) continue;
      await queryRunner.query(`DELETE FROM "role_permissions" WHERE "roleId" = $1 AND "nodeKey" = $2`, [role[0].id, g.node]);
    }
  }
}
