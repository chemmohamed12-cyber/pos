import { randomUUID } from 'crypto';
import { CreateInventoryOpeningBatches1790018000000 } from '../../../database/migrations/inventory/1790018000000-CreateInventoryOpeningBatches';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Inventory lifecycle C4 - the Opening Balance Batch migration on a real Company database: up -> down -> up (idempotent), the CHECK constraints and the partial unique
 * index that guarantees one ACTIVE opening line per (warehouse, product) pair, the Numbering series seed, and `down` removing exactly what `up` created.
 */
describe('Inventory lifecycle C4 migration - up/down/up on a real Company database', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_c4_mig', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
  });
  afterAll(async () => {
    await h.teardown().catch(() => undefined);
  });

  it('creates the two tables, the guarantees and the numbering series; down removes exactly those; up again is idempotent', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const qr = ds.createQueryRunner();
    try {
      const mig = new CreateInventoryOpeningBatches1790018000000();
      const tables = async () => (await ds.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'inventory_opening_batch%' ORDER BY 1`)).map((r: { table_name: string }) => r.table_name);
      const series = async () => Number((await ds.query(`SELECT count(*) AS n FROM numbering_sequences WHERE "documentType" = 'inventory_opening_batch'`))[0].n);
      expect(await tables()).toEqual(['inventory_opening_batch_lines', 'inventory_opening_batches']);
      expect(await series()).toBe(1);

      await mig.down(qr);
      expect(await tables()).toEqual([]);
      expect(await series()).toBe(0);
      await mig.down(qr); // idempotent down

      await mig.up(qr);
      await mig.up(qr); // idempotent up
      expect(await tables()).toEqual(['inventory_opening_batch_lines', 'inventory_opening_batches']);
      expect(await series()).toBe(1);

      const batch = randomUUID();
      const wh = randomUUID();
      const product = randomUUID();
      const insertBatch = (id: string, kind: string, number: string) =>
        ds.query(`INSERT INTO inventory_opening_batches ("id","batchNumber","kind","warehouseId","cutOffDate","createdByUserId") VALUES ($1,$2,$3,$4,CURRENT_DATE,$5)`, [id, number, kind, wh, randomUUID()]);
      await insertBatch(batch, 'opening', 'OB-T-1');
      await expect(insertBatch(randomUUID(), 'bogus', 'OB-T-2')).rejects.toThrow(); // kind CHECK
      await expect(insertBatch(randomUUID(), 'opening', 'OB-T-1')).rejects.toThrow(); // unique batch number
      const insertLine = (active: boolean, quantity = 1, cost: string | null = '1.0000') =>
        ds.query(`INSERT INTO inventory_opening_batch_lines ("batchId","warehouseId","productId","quantity","unitCostBase","lineValueBase","isActive") VALUES ($1,$2,$3,$4,$5,'1.0000',$6)`, [batch, wh, product, quantity, cost, active]);
      await insertLine(true);
      await expect(insertLine(true)).rejects.toThrow(/duplicate key|UQ_inv_opening_line_active_pair/); // second ACTIVE line for the pair
      await insertLine(false); // inactive lines (history, reversal, correction) are unconstrained
      await insertLine(false);
      await expect(insertLine(false, 0)).rejects.toThrow(); // quantity <> 0
      await expect(insertLine(false, 1, '0')).rejects.toThrow(); // cost > 0
      await expect(ds.query(`INSERT INTO inventory_opening_batch_lines ("batchId","warehouseId","productId","quantity","lineValueBase") VALUES ($1,$2,$3,1,'1.0000')`, [randomUUID(), wh, randomUUID()])).rejects.toThrow(); // FK to the batch
    } finally {
      await qr.release();
    }
  });
});
