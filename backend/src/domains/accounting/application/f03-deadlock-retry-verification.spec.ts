import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { WorkOrderService } from '../../manufacturing/application/work-order.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';

/**
 * F03 GL Posting Concurrency RCA (`docs/studies/
 * F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md`) — Option B verification
 * (CTO-approved 2026-09-21). Reproduces the RCA's own §3 finding: two
 * Financial Events posting at genuinely overlapping times can deadlock on
 * the domain-agnostic `numbering_sequences`/`audit_records` lock pair
 * inside `JournalEntryService.createEntry`/`postEntry` — the RCA's own
 * §5 item 4 explicitly establishes this requires no Manufacturing-
 * specific setup, no shared control account, and no reversed journal
 * line order; "two Financial Events posting at overlapping times" is
 * the entire trigger. This suite reuses Manufacturing Work Orders only
 * because they are this codebase's cheapest, already-proven way to
 * produce two independent, concurrently-postable Financial Events
 * (`work-order.spec.ts`'s own fixture shape) — it proves nothing
 * Manufacturing-specific and changes no Manufacturing file.
 *
 * Per the RCA's own §12 verification protocol: repeated rounds of
 * genuinely concurrent posting, asserting that Option B's bounded,
 * deadlock-specific retry (`financial-event.service.ts`'s
 * `runHandlerThroughPosting`) makes a `40P01` self-heal transparently —
 * the caller never observes a terminal `REJECTED` for this failure
 * class, every journal stays balanced, and no idempotencyKey ever
 * produces a duplicate journal.
 */
describe('F03 GL Posting Concurrency — Option B deadlock-retry verification (RCA, CTO-approved 2026-09-21)', () => {
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
      [`F03V-FG-${suffix}`, `F03 Verify Finished Good ${suffix}`],
    );
    const [component] = await dataSource.query(
      `INSERT INTO products (id, sku, name, "unitPrice", status) VALUES (gen_random_uuid(), $1, $2, 10, 'active') RETURNING id`,
      [`F03V-C-${suffix}`, `F03 Verify Component ${suffix}`],
    );
    const [warehouse] = await dataSource.query(
      `INSERT INTO warehouses (id, code, name, kind, status) VALUES (gen_random_uuid(), $1, $2, 'main', 'active') RETURNING id`,
      [`F03V-WH-${suffix}`, `F03 Verify Warehouse ${suffix}`],
    );
    const [{ id: bomId }] = await dataSource.query('INSERT INTO bill_of_materials ("finishedProductId") VALUES ($1) RETURNING id', [finishedProduct.id]);
    await dataSource.query('INSERT INTO bom_components ("billOfMaterialId", "componentProductId", "quantityPerUnit") VALUES ($1, $2, $3)', [bomId, component.id, 1]);
    return { finishedProductId: finishedProduct.id, componentProductId: component.id, warehouseId: warehouse.id };
  }

  async function makeReleasedWorkOrder(): Promise<{ workOrderId: string; componentProductId: string; warehouseId: string }> {
    const { finishedProductId, componentProductId, warehouseId } = await createFixtures();
    await inventory.recordMovement(warehouseId, componentProductId, 100, 'receipt', 'f03_verify_seed', `seed-${Date.now()}-${Math.random()}`, null, undefined, '5.00');
    const wo = await workOrders.createWorkOrder(finishedProductId, 10, warehouseId, null);
    await workOrders.release(wo.id, null);
    return { workOrderId: wo.id, componentProductId, warehouseId };
  }

  it('repeated rounds of two genuinely concurrent, independent Work Order material-issue postings all resolve POSTED — never a terminal deadlock rejection, no duplicate journals, every journal balanced', async () => {
    const ROUNDS = 15;

    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await Promise.all([makeReleasedWorkOrder(), makeReleasedWorkOrder()]);

      // The actual race: two independent Financial Events posting at genuinely overlapping
      // times — the RCA's own §5 item 4 finding is that this alone is sufficient to
      // (probabilistically) trigger the numbering/audit AB-BA deadlock; no shared account,
      // no reversed line order required.
      await Promise.all([
        workOrders.materialIssue(a.workOrderId, a.componentProductId, 3, null, `f03-verify-${round}-a`),
        workOrders.materialIssue(b.workOrderId, b.componentProductId, 3, null, `f03-verify-${round}-b`),
      ]);

      for (const wo of [a, b]) {
        const events: Array<{ id: string; status: string; rejectionReason: string | null; journalEntryId: string | null; idempotencyKey: string }> = await dataSource.query(
          `SELECT id, status, "rejectionReason", "journalEntryId", "idempotencyKey" FROM accounting_financial_events WHERE "idempotencyKey" LIKE $1`,
          [`manufacturing:work_order:${wo.workOrderId}:material_issue:%`],
        );
        expect(events).toHaveLength(1); // exactly one Financial Event for this posting, no duplicate
        // The single most important assertion: Option B's retry means a transient 40P01 never
        // surfaces as this event's final status — if a deadlock occurred during this round, the
        // bounded retry already resolved it before `ingest()` returned.
        expect(events[0].status).toBe('POSTED');
        expect(events[0].rejectionReason).toBeNull();

        const journalLines: Array<{ debitBase: string; creditBase: string }> = await dataSource.query(
          `SELECT "debitBase", "creditBase" FROM accounting_journal_lines WHERE "journalEntryId" = $1`,
          [events[0].journalEntryId],
        );
        const debit = journalLines.reduce((s, l) => s + Number(l.debitBase || 0), 0);
        const credit = journalLines.reduce((s, l) => s + Number(l.creditBase || 0), 0);
        expect(Math.abs(debit - credit)).toBeLessThan(0.0001); // balanced, even on a retried posting
      }
    }
  }, 300_000);
});
