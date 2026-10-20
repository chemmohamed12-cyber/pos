import { InventoryService } from './inventory.service';

/**
 * `referenceNumbers`: the movements report shows the human document number (GR-... / warehouse transaction number) instead of a short id. Database-free: a fake manager records the SQL it is given.
 */
describe('InventoryService.referenceNumbers', () => {
  const GR = '20c65ae9-4948-42b6-be7b-815b04cc3b85';
  const TXN = '11111111-1111-4111-8111-111111111111';
  const build = (rows: Record<string, Array<{ id: string; number: string | null }>>, failFor?: string) => {
    const calls: Array<{ sql: string; ids: string[] }> = [];
    const manager = {
      query: async (sql: string, params: string[][]) => {
        calls.push({ sql, ids: params[0] });
        if (failFor && sql.includes(`"${failFor}"`)) throw new Error('relation does not exist');
        const table = /FROM "([a-z_]+)"/.exec(sql)![1];
        return rows[table] ?? [];
      },
    };
    const svc = Object.create(InventoryService.prototype) as InventoryService;
    return { svc, manager: manager as never, calls };
  };

  it('resolves a goods receipt and a warehouse transaction to their numbers, one query per type, ids de-duplicated', async () => {
    const { svc, manager, calls } = build({ goods_receipts: [{ id: GR, number: 'GR-2026-000001' }], warehouse_transactions: [{ id: TXN, number: 'WT-2026-000007' }] });
    const map = await svc.referenceNumbers(
      [
        { referenceType: 'goods_receipt', referenceId: GR },
        { referenceType: 'goods_receipt', referenceId: GR },
        { referenceType: 'warehouse_transaction', referenceId: TXN },
        { referenceType: 'sales_order', referenceId: '22222222-2222-4222-8222-222222222222' },
        { referenceType: null, referenceId: null },
      ],
      manager,
    );
    expect(map.get(`goods_receipt:${GR}`)).toBe('GR-2026-000001');
    expect(map.get(`warehouse_transaction:${TXN}`)).toBe('WT-2026-000007');
    expect(map.size).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].ids).toEqual([GR]); // de-duplicated
  });

  it('a missing record, a null number or an absent module leaves the reference unnumbered and never throws', async () => {
    const none = build({ goods_receipts: [{ id: GR, number: null }] });
    expect((await none.svc.referenceNumbers([{ referenceType: 'goods_receipt', referenceId: GR }], none.manager)).size).toBe(0);
    const absent = build({}, 'goods_receipts');
    expect((await absent.svc.referenceNumbers([{ referenceType: 'goods_receipt', referenceId: GR }], absent.manager)).size).toBe(0);
  });

  it('makes no query when no movement has a resolvable reference', async () => {
    const { svc, manager, calls } = build({});
    await svc.referenceNumbers([{ referenceType: 'excel_import', referenceId: null }], manager);
    expect(calls).toHaveLength(0);
  });
});
