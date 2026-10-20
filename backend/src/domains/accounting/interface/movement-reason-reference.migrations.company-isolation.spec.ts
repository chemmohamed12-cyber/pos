import { randomUUID } from 'crypto';
import { AddWarehouseTransactionReference1790018300000 } from '../../../database/migrations/inventory/1790018300000-AddWarehouseTransactionReference';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * ADR-INV-04 migration - warehouse_transactions gains the nullable referenceType / referenceId columns and their index: applied by the harness run, down removes them without touching
 * any existing row (legacy documents keep NULLs), up again is idempotent.
 */
describe('ADR-INV-04 migration - document reference columns: up/down/up on a real Company database', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_ref_mig', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
  });
  afterAll(async () => {
    await h.teardown().catch(() => undefined);
  });

  it('adds the columns and index, preserves legacy rows through down/up, and is idempotent', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const qr = ds.createQueryRunner();
    try {
      const mig = new AddWarehouseTransactionReference1790018300000();
      const cols = async () => ((await ds.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'warehouse_transactions' AND column_name IN ('referenceType','referenceId') ORDER BY 1`)) as Array<{ column_name: string }>).map((r) => r.column_name);
      const idx = async () => Number((await ds.query(`SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'IDX_wh_txn_reference'`))[0].n);

      expect(await cols()).toEqual(['referenceId', 'referenceType']);
      expect(await idx()).toBe(1);

      const wh = randomUUID();
      const txn = randomUUID();
      await ds.query(`INSERT INTO warehouses ("id","code","name") VALUES ($1,$2,'W')`, [wh, `W-${wh.slice(0, 6)}`]);
      await ds.query(`INSERT INTO warehouse_transactions ("id","transactionNumber","type","warehouseId","movementDate","createdByUserId","referenceType","referenceId") VALUES ($1,$2,'receipt',$3,now(),$5,'warehouse_transaction',$4)`, [txn, `T-${txn.slice(0, 6)}`, wh, randomUUID(), randomUUID()]);

      await mig.down(qr);
      expect(await cols()).toEqual([]);
      expect(await idx()).toBe(0);
      expect(Number((await ds.query(`SELECT count(*) AS n FROM warehouse_transactions WHERE id = $1`, [txn]))[0].n)).toBe(1); // the document itself survives

      await mig.up(qr);
      await mig.up(qr); // idempotent
      expect(await cols()).toEqual(['referenceId', 'referenceType']);
      expect(await idx()).toBe(1);
      expect((await ds.query(`SELECT "referenceType" AS t FROM warehouse_transactions WHERE id = $1`, [txn]))[0].t).toBeNull(); // the dropped values do not come back; legacy NULL semantics
    } finally {
      await qr.release();
    }
  });
});
