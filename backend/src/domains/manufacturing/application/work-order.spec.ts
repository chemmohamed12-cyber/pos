import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { WorkOrderService } from './work-order.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';

/**
 * ADR-061 (Manufacturing Production & Costing Integration Contract). Live,
 * real-DB E2E proof of the full Work Order chain: create -> release
 * (BOM snapshot + reservation + WIP sub-warehouse) -> Material Issue
 * (partial, twice, at two different real-warehouse costs) -> Material
 * Return (costed at WIP's own current average, §5 corrected rule) ->
 * partial Finished Goods Output -> a THIRD Material Issue occurring
 * AFTER the partial output (§7's costing-policy clarification) ->
 * final Finished Goods Output driving WIP to exactly zero -> completion.
 *
 * Uses freshly created, dedicated products/warehouse (never shared/
 * pre-existing test fixtures) so this test's numbers are exact and
 * reproducible regardless of what other work has touched the dev DB.
 *
 * A `wip` control-function GL account must exist for the Financial
 * Events to post (not `dispatchPending`-rejected) — created once,
 * idempotently, by this test if missing.
 */
describe('Manufacturing Work Order (ADR-061)', () => {
  let moduleRef: TestingModule;
  let workOrders: WorkOrderService;
  let inventory: InventoryService;
  let dataSource: DataSource;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    workOrders = moduleRef.get(WorkOrderService);
    inventory = moduleRef.get(InventoryService);
    dataSource = moduleRef.get(DataSource);

    const existingWip = await dataSource.query(`SELECT id FROM accounting_gl_accounts WHERE "controlFunction" = 'wip' LIMIT 1`);
    if (existingWip.length === 0) {
      const [parent] = await dataSource.query(`SELECT id FROM accounting_gl_accounts WHERE code = '1120'`);
      await dataSource.query(
        `INSERT INTO accounting_gl_accounts
           (id, code, name, "accountType", "normalBalance", "isContra", "parentAccountId", "isPostable", "controlFunction", "currencyMode", "allowManualJournal", "isActive", "nameAr", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), '1125', 'Work In Process', 'asset', 'debit', false, $1, true, 'wip', 'functional_only', false, true, 'تحت التصنيع', now(), now())`,
        [parent?.id ?? null],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  async function createFixtures(): Promise<{ finishedProductId: string; componentProductId: string; warehouseId: string }> {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [finishedProduct] = await dataSource.query(
      `INSERT INTO products (id, sku, name, "unitPrice", status) VALUES (gen_random_uuid(), $1, $2, 100, 'active') RETURNING id`,
      [`E2E-FG-${suffix}`, `E2E Finished Good ${suffix}`],
    );
    const [component] = await dataSource.query(
      `INSERT INTO products (id, sku, name, "unitPrice", status) VALUES (gen_random_uuid(), $1, $2, 10, 'active') RETURNING id`,
      [`E2E-C-${suffix}`, `E2E Component ${suffix}`],
    );
    const [warehouse] = await dataSource.query(
      `INSERT INTO warehouses (id, code, name, kind, status) VALUES (gen_random_uuid(), $1, $2, 'main', 'active') RETURNING id`,
      [`E2E-WH-${suffix}`, `E2E Warehouse ${suffix}`],
    );
    const [{ id: bomId }] = await dataSource.query('INSERT INTO bill_of_materials ("finishedProductId") VALUES ($1) RETURNING id', [finishedProduct.id]);
    await dataSource.query('INSERT INTO bom_components ("billOfMaterialId", "componentProductId", "quantityPerUnit") VALUES ($1, $2, $3)', [bomId, component.id, 3]);
    return { finishedProductId: finishedProduct.id, componentProductId: component.id, warehouseId: warehouse.id };
  }

  it('runs the full lifecycle with every guard, reaches WIP = 0 at completion, and balances the GL', async () => {
    const { finishedProductId, componentProductId, warehouseId } = await createFixtures();

    // Seed 30 units (== quantityRequired) up front so the full reservation at release succeeds.
    await inventory.recordMovement(warehouseId, componentProductId, 30, 'receipt', 'e2e_seed', 'seed-0', null, undefined, '5.00');

    const [{ c: reservationsBefore }] = await dataSource.query(`SELECT COUNT(*) AS c FROM stock_reservations WHERE "salesOrderId" IS NOT NULL`);

    const wo = await workOrders.createWorkOrder(finishedProductId, 10, warehouseId, null);
    await workOrders.release(wo.id, null);

    await workOrders.materialIssue(wo.id, componentProductId, 12, null, 'req-issue-1');
    expect(await workOrders.computeWipValue(wo.id)).toBeCloseTo(60.0, 4);

    // Price change: 10 more units arrive @ $8.00.
    await inventory.recordMovement(warehouseId, componentProductId, 10, 'receipt', 'e2e_seed', 'seed-1', null, undefined, '8.00');
    await workOrders.materialIssue(wo.id, componentProductId, 8, null, 'req-issue-2');

    // Return, costed at WIP's OWN current average (§5, corrected rule) — re-reserves the quantity.
    await workOrders.materialReturn(wo.id, componentProductId, 2, null, 'req-return-1');

    // Partial FG Output #1.
    await workOrders.finishedGoodsOutput(wo.id, 6, null, 'req-output-1');
    const wipAfterOutput1 = await workOrders.computeWipValue(wo.id);

    // Guards.
    await expect(workOrders.materialIssue(wo.id, componentProductId, 13, null, 'req-overissue')).rejects.toThrow();
    await expect(workOrders.finishedGoodsOutput(wo.id, 4, null, 'req-output-2-premature')).rejects.toThrow();

    // A THIRD Material Issue occurring AFTER a partial FG output — §7's costing-policy clarification.
    await workOrders.materialIssue(wo.id, componentProductId, 12, null, 'req-issue-3');
    const wipAfterIssue3 = await workOrders.computeWipValue(wo.id);
    expect(wipAfterIssue3).toBeGreaterThan(wipAfterOutput1);

    // Final FG Output — must drive WIP to exactly zero.
    await workOrders.finishedGoodsOutput(wo.id, 4, null, 'req-output-2');
    expect(await workOrders.computeWipValue(wo.id)).toBeCloseTo(0, 4);

    // Idempotent retry must fail closed, never double-post.
    await expect(workOrders.materialIssue(wo.id, componentProductId, 12, null, 'req-issue-1')).rejects.toThrow();

    // Completion requires WIP === 0; must now succeed.
    await workOrders.complete(wo.id, null);
    expect(await workOrders.getWorkOrderState(wo.id)).toBe('completed');

    // Physical conservation.
    const wipWarehouseId = (await workOrders.getWorkOrderOrThrow(wo.id)).wipWarehouseId!;
    expect(await inventory.getOnHandQuantityInTransaction(dataSource.manager, wipWarehouseId, componentProductId)).toBe(0);
    expect(await inventory.getOnHandQuantityInTransaction(dataSource.manager, warehouseId, componentProductId)).toBe(10); // 40 received - 30 consumed

    // Financial Events — all posted (no manual outbox drain needed; the service dispatches itself).
    const events: Array<{ eventType: string; payload: { totalValueBase: string }; status: string }> = await dataSource.query(
      `SELECT "eventType", payload, status FROM accounting_financial_events WHERE "idempotencyKey" LIKE $1 ORDER BY "receivedAt"`,
      [`manufacturing:work_order:${wo.id}:%`],
    );
    expect(events).toHaveLength(6); // 3 issues + 1 return + 2 outputs
    expect(events.every((e) => e.status.toUpperCase() === 'POSTED')).toBe(true);

    // GL journals balance, and touch only WIP/Inventory (no P&L).
    const journalLines: Array<{ journalEntryId: string; debitBase: string; creditBase: string; controlFunction: string | null }> = await dataSource.query(
      `SELECT jl."journalEntryId", jl."debitBase", jl."creditBase", a."controlFunction"
       FROM accounting_journal_lines jl
       JOIN accounting_gl_accounts a ON a.id = jl."accountId"
       WHERE jl."journalEntryId" IN (
         SELECT "journalEntryId" FROM accounting_financial_events WHERE "idempotencyKey" LIKE $1 AND "journalEntryId" IS NOT NULL
       )`,
      [`manufacturing:work_order:${wo.id}:%`],
    );
    const byJournal = new Map<string, { debit: number; credit: number }>();
    for (const l of journalLines) {
      const e = byJournal.get(l.journalEntryId) ?? { debit: 0, credit: 0 };
      e.debit += Number(l.debitBase || 0);
      e.credit += Number(l.creditBase || 0);
      byJournal.set(l.journalEntryId, e);
    }
    expect(byJournal.size).toBe(6);
    for (const totals of byJournal.values()) expect(Math.abs(totals.debit - totals.credit)).toBeLessThan(0.0001);
    expect(journalLines.every((l) => l.controlFunction === 'wip' || l.controlFunction === 'inventory')).toBe(true);

    // Monetary conservation: total value in (net of return) === total value out.
    const sum = (type: string) => events.filter((e) => e.eventType === type).reduce((s, e) => s + Number(e.payload.totalValueBase), 0);
    const totalIn = sum('manufacturing.work_order.material_issued') - sum('manufacturing.work_order.material_returned');
    const totalOut = sum('manufacturing.work_order.finished_goods_received');
    expect(totalIn).toBeCloseTo(totalOut, 4);

    // Sales Order reservation regression — untouched by any of the above.
    const [{ c: reservationsAfter }] = await dataSource.query(`SELECT COUNT(*) AS c FROM stock_reservations WHERE "salesOrderId" IS NOT NULL`);
    expect(Number(reservationsAfter)).toBe(Number(reservationsBefore));
    const [{ c: xorViolations }] = await dataSource.query(
      `SELECT COUNT(*) AS c FROM stock_reservations WHERE NOT (("salesOrderId" IS NOT NULL AND "referenceType" IS NULL) OR ("salesOrderId" IS NULL AND "referenceType" IS NOT NULL))`,
    );
    expect(Number(xorViolations)).toBe(0);
  }, 60_000);

  it('cancels a released Work Order with zero material issued and releases its full reservation', async () => {
    const { finishedProductId, componentProductId, warehouseId } = await createFixtures();
    await inventory.recordMovement(warehouseId, componentProductId, 30, 'receipt', 'e2e_seed', 'seed-cancel', null, undefined, '5.00');

    const wo = await workOrders.createWorkOrder(finishedProductId, 10, warehouseId, null);
    await workOrders.release(wo.id, null);
    const available = await dataSource.transaction((m) => inventory.getAvailableInTransaction(m, warehouseId, componentProductId));
    expect(available).toBe(0); // fully reserved

    await workOrders.cancel(wo.id, null);
    expect(await workOrders.getWorkOrderState(wo.id)).toBe('cancelled');

    const availableAfterCancel = await dataSource.transaction((m) => inventory.getAvailableInTransaction(m, warehouseId, componentProductId));
    expect(availableAfterCancel).toBe(30); // reservation fully released back
  }, 60_000);
});
