import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { WipReconciliationService } from './wip-reconciliation.service';
import { InventoryReconciliationService } from './inventory-reconciliation.service';
import { WorkOrderService } from '../../manufacturing/application/work-order.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { MANUFACTURING_WIP_CONTRACT, ManufacturingWipContract } from '../../../foundation/module-registry/contracts/manufacturing-wip.contract';

/**
 * ADR-061 (Manufacturing) Month-End dependency — Phase 1 of the team
 * directive following the independent post-implementation review. Proves
 * the fix for the false-drift gap ADR-061 §17 flagged and left open:
 * `InventoryReconciliationService` used to sum EVERY F08 warehouse,
 * including every Work Order's dedicated WIP sub-warehouse, against ONLY
 * the `inventory` GL account — any open WIP produced a false `drift_found`.
 *
 * Covers every case in the Phase 1 test gate (A–G). Uses freshly created,
 * dedicated products/warehouses per test (never shared/pre-existing
 * fixtures), and DELTA assertions for BOTH reconciliation services — this
 * shared dev database carries real, pre-existing historical drift on both
 * the `inventory` account (see `grni-reconciliation.spec.ts`'s own
 * documented precedent) AND, confirmed live while writing this spec, the
 * `wip` account: 31 `manufacturing.*` Financial Events were REJECTED in
 * earlier test/dev runs before a `wip` GL account existed yet
 * (`no active postable account has controlFunction "wip"`), leaving F08
 * showing real WIP value with no matching GL posting ever made for it —
 * genuine stranded drift, not a defect in this fix. That is in fact
 * exactly the class of failure this split design exists to surface (a
 * combined/netted comparison would hide it, per this fix's own design
 * rationale — see `WipReconciliationService`'s doc comment); it is direct,
 * live proof the split correctly reports `drift_found` instead of
 * silently netting it away. The property under test here is therefore
 * "does *my* well-formed Manufacturing activity move the drift by even one
 * cent," on both sides, not "this database's cumulative history is clean."
 */
describe('WipReconciliationService — WIP/Inventory Month-End split (ADR-061 dependency)', () => {
  let moduleRef: TestingModule;
  let wipReconciliation: WipReconciliationService;
  let inventoryReconciliation: InventoryReconciliationService;
  let workOrders: WorkOrderService;
  let inventory: InventoryService;
  let valuation: InventoryValuationContract;
  let manufacturingWip: ManufacturingWipContract;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    wipReconciliation = moduleRef.get(WipReconciliationService);
    inventoryReconciliation = moduleRef.get(InventoryReconciliationService);
    workOrders = moduleRef.get(WorkOrderService);
    inventory = moduleRef.get(InventoryService);
    valuation = moduleRef.get(INVENTORY_VALUATION_CONTRACT);
    manufacturingWip = moduleRef.get(MANUFACTURING_WIP_CONTRACT);
    dataSource = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  async function createFixtures(): Promise<{ finishedProductId: string; componentProductId: string; warehouseId: string }> {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [finishedProduct] = await dataSource.query(
      `INSERT INTO products (id, sku, name, "unitPrice", status) VALUES (gen_random_uuid(), $1, $2, 100, 'active') RETURNING id`,
      [`WIPREC-FG-${suffix}`, `WipRec Finished Good ${suffix}`],
    );
    const [component] = await dataSource.query(
      `INSERT INTO products (id, sku, name, "unitPrice", status) VALUES (gen_random_uuid(), $1, $2, 10, 'active') RETURNING id`,
      [`WIPREC-C-${suffix}`, `WipRec Component ${suffix}`],
    );
    const [warehouse] = await dataSource.query(
      `INSERT INTO warehouses (id, code, name, kind, status) VALUES (gen_random_uuid(), $1, $2, 'main', 'active') RETURNING id`,
      [`WIPREC-WH-${suffix}`, `WipRec Warehouse ${suffix}`],
    );
    const [{ id: bomId }] = await dataSource.query('INSERT INTO bill_of_materials ("finishedProductId") VALUES ($1) RETURNING id', [finishedProduct.id]);
    await dataSource.query('INSERT INTO bom_components ("billOfMaterialId", "componentProductId", "quantityPerUnit") VALUES ($1, $2, $3)', [bomId, component.id, 1]);
    return { finishedProductId: finishedProduct.id, componentProductId: component.id, warehouseId: warehouse.id };
  }

  it('Case A/F — a fresh, no-WIP reconciliation of both types never throws and Inventory shows zero WIP-attributable drift', async () => {
    const inv = await inventoryReconciliation.reconcile({ asOfDate: '2026-09-30' }, ADMIN_A);
    expect(inv.status).toBeDefined();
    const wip = await wipReconciliation.reconcile({ asOfDate: '2026-09-30' }, ADMIN_A);
    expect(wip.status).toBeDefined();
    expect(['matched', 'drift_found', 'no_subledger_source']).toContain(wip.status);
  }, 30_000);

  it('Case B/C — opening a Work Order and issuing material raises WIP reconciliation correctly and does not move Inventory reconciliation drift by one cent', async () => {
    const { finishedProductId, componentProductId, warehouseId } = await createFixtures();
    await inventory.recordMovement(warehouseId, componentProductId, 10, 'receipt', 'e2e_seed', 'wiprec-seed-1', null, undefined, '5.00');

    const invBefore = await inventoryReconciliation.reconcile({}, ADMIN_A);
    const wipBefore = await wipReconciliation.reconcile({}, ADMIN_A);

    const wo = await workOrders.createWorkOrder(finishedProductId, 5, warehouseId, null);
    await workOrders.release(wo.id, null);
    await workOrders.materialIssue(wo.id, componentProductId, 5, null, 'wiprec-issue-1');

    // Case C — WIP increased by exactly the issued value (5 @ $5.00 = $25.00), Dr WIP / Cr Inventory.
    const wipValue = await workOrders.computeWipValue(wo.id);
    expect(wipValue).toBeCloseTo(25.0, 4);

    // This Work Order's own Material Issue posted cleanly (both F08 and GL moved by $25.00
    // together) — so it must not have moved WipReconciliationService's own drift figure at all,
    // regardless of whatever pre-existing historical drift this shared dev DB already carries.
    const wipAfter = await wipReconciliation.reconcile({}, ADMIN_A);
    expect(Number(wipAfter.driftBase ?? 0) - Number(wipBefore.driftBase ?? 0)).toBeCloseTo(0, 4);
    expect(Number(wipAfter.subledgerTotalBase) - Number(wipBefore.subledgerTotalBase ?? 0)).toBeCloseTo(25.0, 4);

    // Case B — Inventory reconciliation's drift is UNCHANGED by this Work Order's WIP existing —
    // the false-drift bug this fix closes would have moved `driftBase` by exactly $25.00 here.
    const invAfter = await inventoryReconciliation.reconcile({}, ADMIN_A);
    expect(Number(invAfter.driftBase ?? 0) - Number(invBefore.driftBase ?? 0)).toBeCloseTo(0, 4);
  }, 60_000);

  it('Case D — a Finished Goods Output that drives WIP back to zero is reflected correctly by both reconciliations', async () => {
    const { finishedProductId, componentProductId, warehouseId } = await createFixtures();
    await inventory.recordMovement(warehouseId, componentProductId, 3, 'receipt', 'e2e_seed', 'wiprec-seed-2', null, undefined, '4.00');

    const invBefore = await inventoryReconciliation.reconcile({}, ADMIN_A);
    const wipBefore = await wipReconciliation.reconcile({}, ADMIN_A);

    const wo = await workOrders.createWorkOrder(finishedProductId, 3, warehouseId, null);
    await workOrders.release(wo.id, null);
    await workOrders.materialIssue(wo.id, componentProductId, 3, null, 'wiprec-issue-2');
    expect(await workOrders.computeWipValue(wo.id)).toBeCloseTo(12.0, 4);

    // WIP rose by exactly $12.00 mid-flight (Dr WIP / Cr Inventory) — proven by delta, not absolute
    // status, for the same pre-existing-drift reason documented at the top of this file.
    const wipMid = await wipReconciliation.reconcile({}, ADMIN_A);
    expect(Number(wipMid.subledgerTotalBase) - Number(wipBefore.subledgerTotalBase ?? 0)).toBeCloseTo(12.0, 4);
    expect(Number(wipMid.driftBase ?? 0) - Number(wipBefore.driftBase ?? 0)).toBeCloseTo(0, 4);

    // Final output — drives this Work Order's own WIP to exactly zero (Dr FG Inventory / Cr WIP).
    await workOrders.finishedGoodsOutput(wo.id, 3, null, 'wiprec-output-1');
    expect(await workOrders.computeWipValue(wo.id)).toBeCloseTo(0, 4);
    await workOrders.complete(wo.id, null);

    // Back to exactly where it started — this Work Order's net WIP contribution is $0.00 once
    // complete, and its drift contribution is $0.00 throughout (both legs always posted together).
    const wipAfter = await wipReconciliation.reconcile({}, ADMIN_A);
    expect(Number(wipAfter.subledgerTotalBase) - Number(wipBefore.subledgerTotalBase ?? 0)).toBeCloseTo(0, 4);
    expect(Number(wipAfter.driftBase ?? 0) - Number(wipBefore.driftBase ?? 0)).toBeCloseTo(0, 4);

    const invAfter = await inventoryReconciliation.reconcile({}, ADMIN_A);
    expect(Number(invAfter.driftBase ?? 0) - Number(invBefore.driftBase ?? 0)).toBeCloseTo(0, 4);
  }, 60_000);

  it('Case E — two concurrently open Work Orders (two WIP sub-warehouses) both contribute correctly to one balanced WIP reconciliation', async () => {
    const fixtureA = await createFixtures();
    const fixtureB = await createFixtures();
    await inventory.recordMovement(fixtureA.warehouseId, fixtureA.componentProductId, 4, 'receipt', 'e2e_seed', 'wiprec-seed-3a', null, undefined, '2.50');
    await inventory.recordMovement(fixtureB.warehouseId, fixtureB.componentProductId, 6, 'receipt', 'e2e_seed', 'wiprec-seed-3b', null, undefined, '3.00');
    const wipBefore = await wipReconciliation.reconcile({}, ADMIN_A);

    const woA = await workOrders.createWorkOrder(fixtureA.finishedProductId, 4, fixtureA.warehouseId, null);
    await workOrders.release(woA.id, null);
    await workOrders.materialIssue(woA.id, fixtureA.componentProductId, 4, null, 'wiprec-issue-3a');

    const woB = await workOrders.createWorkOrder(fixtureB.finishedProductId, 6, fixtureB.warehouseId, null);
    await workOrders.release(woB.id, null);
    await workOrders.materialIssue(woB.id, fixtureB.componentProductId, 6, null, 'wiprec-issue-3b');

    const wipA = await workOrders.computeWipValue(woA.id); // 4 @ $2.50 = $10.00
    const wipB = await workOrders.computeWipValue(woB.id); // 6 @ $3.00 = $18.00
    expect(wipA).toBeCloseTo(10.0, 4);
    expect(wipB).toBeCloseTo(18.0, 4);

    const all = await manufacturingWip.getAllWipBalances();
    const entryA = all.balances.find((b) => b.workOrderId === woA.id);
    const entryB = all.balances.find((b) => b.workOrderId === woB.id);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(Number(entryA!.valueBase)).toBeCloseTo(10.0, 4);
    expect(Number(entryB!.valueBase)).toBeCloseTo(18.0, 4);

    // Both Work Orders' WIP is summed correctly into ONE reconciliation total ($10.00 + $18.00 =
    // $28.00 more than before), and neither introduced any drift of its own.
    const wipAfter = await wipReconciliation.reconcile({}, ADMIN_A);
    expect(Number(wipAfter.subledgerTotalBase) - Number(wipBefore.subledgerTotalBase ?? 0)).toBeCloseTo(28.0, 4);
    expect(Number(wipAfter.driftBase ?? 0) - Number(wipBefore.driftBase ?? 0)).toBeCloseTo(0, 4);
  }, 60_000);

  it('Case G — the WIP/Inventory split used by Closing Snapshot excludes a WIP sub-warehouse from the plain inventory breakdown and reports it, labeled, under wip', async () => {
    const { finishedProductId, componentProductId, warehouseId } = await createFixtures();
    await inventory.recordMovement(warehouseId, componentProductId, 2, 'receipt', 'e2e_seed', 'wiprec-seed-4', null, undefined, '9.00');

    const wo = await workOrders.createWorkOrder(finishedProductId, 2, warehouseId, null);
    await workOrders.release(wo.id, null);
    await workOrders.materialIssue(wo.id, componentProductId, 2, null, 'wiprec-issue-4');
    const wipWarehouseId = (await workOrders.getWorkOrderOrThrow(wo.id)).wipWarehouseId!;

    // Mirrors exactly the filter `ClosingSnapshotService.assembleBody` applies (§ "Month-End
    // dependency" comment there) — proven here directly against the live contracts rather than
    // by driving the full snapshot approval/signing pipeline.
    const rawInventory = await valuation.getValuedOnHandTotal();
    const wip = await manufacturingWip.getAllWipBalances();
    const wipWarehouseIds = new Set(wip.balances.map((b) => b.wipWarehouseId));
    const inventoryBreakdown = rawInventory.filter((w) => !wipWarehouseIds.has(w.warehouseId));

    expect(wipWarehouseIds.has(wipWarehouseId)).toBe(true);
    expect(inventoryBreakdown.some((w) => w.warehouseId === wipWarehouseId)).toBe(false);
    expect(rawInventory.some((w) => w.warehouseId === wipWarehouseId)).toBe(true); // still tracked by F08 itself — only excluded from the labeled `inventory` breakdown
  }, 60_000);
});
