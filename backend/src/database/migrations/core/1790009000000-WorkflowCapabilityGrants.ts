import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization Foundation F5 (Map -> Dual-check -> Migrate -> Retire) — the MIGRATE step's data. ADDITIVE and idempotent: every Company role that the pre-F5 call
 * sites named receives the workflow capability (`wf.*`) that replaces that role-list check, and `admin` receives all of them. After this migration the capability
 * decision equals the legacy role-list decision for every existing user (the Capability Diff is empty); from then on a Company can grant the same capabilities to
 * any role it designs. Nothing is removed; a role that does not exist in a database is simply skipped. The snapshot below is frozen on purpose (a migration must
 * not depend on code that can change): `workflow-rules.ts` is the living map, this is its state at 2026-10-07.
 */
export class WorkflowCapabilityGrants1790009000000 implements MigrationInterface {
  name = 'WorkflowCapabilityGrants1790009000000';

  /** [node, legacy roles that held the decision] — `admin` is added for every node. */
  private readonly rules: Array<[string, string[]]> = [
    ['wf.sales.order.submit', ['sales_rep']],
    ['wf.sales.order.resubmit', ['sales_rep']],
    ['wf.sales.order.supervisor_approve', ['sales_supervisor']],
    ['wf.sales.order.supervisor_reject', ['sales_supervisor']],
    ['wf.sales.order.manager_approve', ['sales_manager']],
    ['wf.sales.order.manager_reject', ['sales_manager']],
    ['wf.sales.order.list_all', ['sales_supervisor', 'sales_manager', 'warehouse_worker']],
    ['wf.sales.order.read_any', ['sales_supervisor', 'sales_manager', 'warehouse_worker', 'finance']],
    ['wf.sales.order.edit_supervisor_review', ['sales_supervisor']],
    ['wf.sales.order.edit_manager_approval', ['sales_manager']],
    ['wf.sales.order.edit_released', ['finance']],
    ['wf.sales.order.set_manager_price', ['sales_manager']],
    ['wf.sales.order.edit_any_draft', []],
    ['wf.sales.order.delete_any_draft', []],
    ['wf.sales.rep.list', ['sales_manager']],
    ['wf.sales.rep.act', ['sales_rep']],
    ['wf.sales.customer.read_any', ['sales_supervisor', 'sales_manager', 'finance']],
    ['wf.logistics.shipment.assign_driver', []],
    ['wf.logistics.shipment.set_route', []],
    ['wf.logistics.shipment.act_any', []],
    ['wf.logistics.shipment.read_any', ['finance']],
    ['wf.logistics.shipment.manage_non_driver_actions', []],
    ['wf.logistics.shipment.board_all', ['warehouse_worker']],
    ['wf.logistics.shipment.custody_query', ['warehouse_worker', 'sales_supervisor']],
    ['wf.logistics.return.request', ['warehouse_worker', 'sales_supervisor']],
    ['wf.logistics.return.authorize', ['sales_supervisor']],
    ['wf.logistics.return.reject', ['sales_supervisor']],
    ['wf.logistics.return.receive', ['warehouse_worker']],
    ['wf.logistics.return.inspect', ['warehouse_worker']],
    ['wf.logistics.return.disposition', ['warehouse_worker']],
    ['wf.inventory.fulfillment.worker', ['warehouse_worker']],
    ['wf.inventory.warehouse_tx.submit', ['warehouse_worker', 'inventory_controller']],
    ['wf.inventory.warehouse_tx.recall', ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller']],
    ['wf.inventory.warehouse_tx.approve', ['warehouse_supervisor', 'inventory_controller']],
    ['wf.inventory.warehouse_tx.post', ['warehouse_supervisor', 'inventory_controller']],
    ['wf.inventory.warehouse_tx.reverse', ['warehouse_supervisor']],
    ['wf.core.scope.unrestricted', []],
    ['wf.core.organization.manage', []],
    ['wf.inventory.nav.warehouse', ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller']],
    ['wf.inventory.nav.fulfillment', ['warehouse_worker']],
    ['wf.logistics.nav.shipments', ['driver']],
    ['wf.logistics.nav.shipping_methods', []],
    ['wf.logistics.nav.custody_returns', ['warehouse_worker', 'sales_supervisor']],
    ['wf.logistics.nav.collection_settlements', ['finance']],
    ['wf.sales.nav.price_lists', ['sales_manager']],
    ['wf.sales.nav.bom', []],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasRoles = await queryRunner.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'roles'`);
    const hasGrants = await queryRunner.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'role_permissions'`);
    if (!hasRoles.length || !hasGrants.length) return;
    for (const [node, legacyRoles] of this.rules) {
      const keys = [...new Set([...legacyRoles, 'admin'])];
      await queryRunner.query(
        `INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
         SELECT r."id", $1, 'editable' FROM "roles" r WHERE r."key" = ANY($2::text[])
         ON CONFLICT ("roleId", "nodeKey") DO NOTHING`,
        [node, keys],
      );
    }
  }

  public async down(): Promise<void> {
    // Additive-only (Blueprint §25): the grants are inert unless a call site reads them; removing them would silently demote the legacy roles.
  }
}
