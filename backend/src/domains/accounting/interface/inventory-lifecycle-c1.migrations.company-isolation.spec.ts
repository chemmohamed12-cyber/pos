import { randomUUID } from 'crypto';
import { AddValuationMovementBusinessDate1790017000000 } from '../../../database/migrations/inventory/1790017000000-AddValuationMovementBusinessDate';
import { AddInventoryReconciliationExplanation1790017100000 } from '../../../database/migrations/accounting/1790017100000-AddInventoryReconciliationExplanation';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Inventory lifecycle C1 - the two additive migrations on a real Company database: up -> down -> up (idempotent), the backfill touches only NULLs and uses the
 * UTC date of createdAt, the default stamps today (UTC), the CHECK constraints reject unknown values, and down removes exactly what up added.
 */
describe('Inventory lifecycle C1 migrations - up/down/up on a real Company database', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_c1_mig', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
  });
  afterAll(async () => {
    await h.teardown().catch(() => undefined);
  });

  const cols = async (ds: { query: (q: string, p?: unknown[]) => Promise<Array<{ column_name: string }>> }, table: string) =>
    (await ds.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table])).map((r) => r.column_name as string);

  it('valuation movement businessDate: up is idempotent, backfills only NULLs from the UTC createdAt date, defaults to today, down removes it', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const qr = ds.createQueryRunner();
    try {
      const mig = new AddValuationMovementBusinessDate1790017000000();
      expect(await cols(ds, 'inventory_valuation_movements')).toContain('businessDate');
      await mig.down(qr);
      expect(await cols(ds, 'inventory_valuation_movements')).not.toContain('businessDate');
      await mig.down(qr); // down is idempotent too

      // legacy rows exist before the column does
      const wh = randomUUID();
      const p = randomUUID();
      await ds.query(`INSERT INTO "warehouses" ("id","code","name") VALUES ($1,'MW','Mig WH') ON CONFLICT DO NOTHING`, [wh]).catch(() => undefined);
      const insert = async (key: string, createdAt: string) =>
        ds.query(
          `INSERT INTO inventory_valuation_movements ("id","productId","warehouseId","idempotencyKey","kind","quantity","quantityBeforeValueBase","valueDeltaBase","quantityAfterValueBase","createdAt") VALUES ($1,$2,$3,$4,'receipt',1,0,1,1,$5)`,
          [randomUUID(), p, wh, key, createdAt],
        );
      await insert('mig:old', '2026-03-05T23:30:00Z');

      await mig.up(qr);
      const [old] = await ds.query(`SELECT "businessDate"::text AS d FROM inventory_valuation_movements WHERE "idempotencyKey" = 'mig:old'`);
      expect(old.d).toBe('2026-03-05'); // UTC date of createdAt

      await ds.query(`UPDATE inventory_valuation_movements SET "businessDate" = '2026-01-01' WHERE "idempotencyKey" = 'mig:old'`);
      await mig.up(qr); // second up: nothing changes, an explicit date is never overwritten
      const [again] = await ds.query(`SELECT "businessDate"::text AS d FROM inventory_valuation_movements WHERE "idempotencyKey" = 'mig:old'`);
      expect(again.d).toBe('2026-01-01');

      await insert('mig:new', new Date().toISOString());
      const [fresh] = await ds.query(`SELECT "businessDate"::text AS d FROM inventory_valuation_movements WHERE "idempotencyKey" = 'mig:new'`);
      expect(fresh.d).toBe(new Date().toISOString().slice(0, 10));
    } finally {
      await qr.release();
    }
  });

  it('reconciliation explanation columns: up/down/up, CHECK constraints enforce the vocabulary, existing status values untouched', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const qr = ds.createQueryRunner();
    try {
      const mig = new AddInventoryReconciliationExplanation1790017100000();
      const added = ['explainedBase', 'unexplainedBase', 'basis', 'classification'];
      for (const c of added) expect(await cols(ds, 'accounting_inventory_reconciliation_runs')).toContain(c);
      await mig.down(qr);
      for (const c of added) expect(await cols(ds, 'accounting_inventory_reconciliation_runs')).not.toContain(c);
      await mig.up(qr);
      await mig.up(qr); // idempotent
      for (const c of added) expect(await cols(ds, 'accounting_inventory_reconciliation_runs')).toContain(c);

      const user = randomUUID();
      await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Mig','mig@test.local') ON CONFLICT DO NOTHING`, [user]);
      const run = (extra: string, status = 'matched') =>
        ds.query(
          `INSERT INTO accounting_inventory_reconciliation_runs ("id","asOfDate","status","subledgerTotalBase","glBalanceBase","driftBase","runByUserId"${extra ? ', ' + extra.split('=')[0] : ''})
           VALUES ($1, CURRENT_DATE, $2, 0, 0, 0, $3${extra ? ', ' + extra.split('=')[1] : ''})`,
          [randomUUID(), status, user],
        );
      await run('classification=\'explained\'');
      await run('basis=\'as_of\'', 'drift_found');
      await expect(run('classification=\'bogus\'')).rejects.toThrow();
      await expect(run('basis=\'bogus\'')).rejects.toThrow();
      await expect(run('', 'not_a_status')).rejects.toThrow(); // the original status CHECK still holds
    } finally {
      await qr.release();
    }
  });
});
