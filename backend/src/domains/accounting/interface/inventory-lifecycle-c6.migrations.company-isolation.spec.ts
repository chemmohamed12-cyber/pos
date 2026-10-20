import { randomUUID } from 'crypto';
import { AllowRevaluationValuationKind1790018200000 } from '../../../database/migrations/inventory/1790018200000-AllowRevaluationValuationKind';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Inventory lifecycle C6 migration - the valuation history `kind` CHECK gains `revaluation`: up -> down -> up on a real Company database; a revaluation row is refused before and
 * accepted after; `down` restores the original list; every other kind keeps working and an unknown kind is still refused.
 */
describe('Inventory lifecycle C6 migration - revaluation kind: up/down/up on a real Company database', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_c6_mig', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
  });
  afterAll(async () => {
    await h.teardown().catch(() => undefined);
  });

  it('allows kind revaluation after up, refuses it after down (no rows), and stays idempotent', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const qr = ds.createQueryRunner();
    try {
      const mig = new AllowRevaluationValuationKind1790018200000();
      const insert = (kind: string) =>
        ds.query(
          `INSERT INTO inventory_valuation_movements ("id","productId","warehouseId","kind","quantity","quantityBeforeValueBase","valueDeltaBase","quantityAfterValueBase","idempotencyKey") VALUES ($1,$2,$3,$4,0,10,-1,9,$5)`,
          [randomUUID(), randomUUID(), randomUUID(), kind, `mig:${kind}:${randomUUID()}`],
        );
      const check = async () => (await ds.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'CHK_inventory_valuation_movements_kind'`))[0].def as string;

      expect(await check()).toContain("'revaluation'"); // applied by the harness migration run
      await insert('revaluation');
      await insert('receipt');
      await expect(insert('bogus')).rejects.toThrow(/CHK_inventory_valuation_movements_kind|check constraint/);

      await ds.query(`DELETE FROM inventory_valuation_movements WHERE kind = 'revaluation'`); // a rollback is possible only without revaluation rows (history is append-only)
      await mig.down(qr);
      expect(await check()).not.toContain("'revaluation'");
      await expect(insert('revaluation')).rejects.toThrow(/CHK_inventory_valuation_movements_kind|check constraint/);
      await insert('issue');

      await mig.up(qr);
      await mig.up(qr); // idempotent
      expect(await check()).toContain("'revaluation'");
      await insert('revaluation');
    } finally {
      await qr.release();
    }
  });
});
