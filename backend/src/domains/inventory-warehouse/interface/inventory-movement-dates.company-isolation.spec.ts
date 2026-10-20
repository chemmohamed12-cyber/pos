import { randomUUID } from 'crypto';
import { WarehouseTransactionsService } from '../application/warehouse-transactions.service';
import { InventoryService } from '../application/inventory.service';
import { ProductsService } from '../../commerce/application/products.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * CR-2026-10-15 — Warehouse Movements report dates, real Postgres (evidence-2026-10-15-cr-review/probe2-results.json).
 *
 * Two separate behaviours:
 *  M-1 (REPORT DEFECT, fixed): `dateTo` arrives date-only from `<input type="date">`; it was compared as `createdAt <= 'YYYY-MM-DD'`
 *      (midnight at the START of the day), so every movement of the selected end day — "today" included — was dropped.
 *  M-2 (LEDGER-DATE POLICY, unchanged, decision D-CR7): a warehouse document's business date (`warehouse_transactions.movementDate`,
 *      settable to a past day) is not carried onto `stock_movements`, which only has the posting time `createdAt`; the report filters by
 *      posting time. Pinned here so any policy change is a deliberate, reviewed change.
 * Running balance: the report (createdAt DESC) read oldest-first per warehouse reproduces on-hand after every movement.
 */
describe('CR-2026-10-15 inventory movement dates — real-Postgres', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let wt: WarehouseTransactionsService;
  let inv: InventoryService;
  const maker = randomUUID();
  const checker = randomUUID();
  const ids = { raw: randomUUID(), prod: randomUUID(), item: randomUUID(), boundaryItem: randomUUID() };
  let today = '';
  let year = '';
  let backdatedReceiptId = '';

  async function m() {
    return (await h.connections.getDataSource(h.companyAId)).manager;
  }
  async function post(type: 'receipt' | 'transfer' | 'issue', from: string, to: string | null, productId: string, quantity: number, movementDate?: Date) {
    const manager = await m();
    const txn = await wt.createTransaction(
      type,
      from,
      to,
      [{ productId, quantity, ...(type === 'receipt' ? { unitCostBase: '2.00' } : {}) }],
      null,
      null,
      null,
      maker,
      movementDate,
      manager,
      type === 'receipt' ? 'FOUND_STOCK' : undefined,
    );
    await wt.transition(txn.id, 'submit', maker, manager);
    if (type !== 'receipt') await wt.transition(txn.id, 'approve', checker, manager);
    return txn.id;
  }
  const count = async (f: { dateFrom?: string; dateTo?: string; productId?: string }) =>
    (await inv.listMovements({ productId: ids.item, ...f }, await m())).length;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'mv_dates', extraCompanyTags: ['sales', 'inventory'] });
    const ds = await h.connections.getDataSource(h.companyAId);
    for (const u of [maker, checker]) await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Dates',$2)`, [u, `dates-${u}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    for (const u of [maker, checker]) await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), u, role[0].id]);
    await ds.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,'RAW','Raw','active','main'), ($2,'PROD','Production','active','main')`, [ids.raw, ids.prod]);
    await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'SKU-MV','Movement item','10.00','active'), ($2,'SKU-BD','Boundary item','10.00','active')`, [
      ids.item,
      ids.boundaryItem,
    ]);

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const policyRegistry = new InventoryPostingPolicyRegistry();
    policyRegistry.bind({
      assertManualReceiptReason: async () => ({ glAccountCode: 'stub' }),
      listManualReceiptReasons: () => ['FOUND_STOCK'],
      assertSaleReturnPostable: async () => undefined,
      assertSupplierInvoicePostable: async () => undefined,
    });
    inv = new InventoryService(h.controlPlane, audit, inert, inert, numbering, { publish: async () => undefined } as never, undefined, policyRegistry);
    wt = new WarehouseTransactionsService(
      h.controlPlane,
      numbering,
      new ProcessEngineService(h.controlPlane),
      new AuthorizationService(ds.getRepository(Role), ds.getRepository(UserRole)),
      audit,
      new ProductsService(h.controlPlane, audit, inert),
      inv,
      policyRegistry,
    );

    // "Today" as the database session sees it — the same calendar the date filters use.
    today = (await ds.query(`SELECT current_date::text AS d`))[0].d;
    year = today.slice(0, 4);
    backdatedReceiptId = await post('receipt', ids.raw, null, ids.item, 100, new Date(`${year}-01-10T09:00:00Z`));
    await post('transfer', ids.raw, ids.prod, ids.item, 30);
    await post('issue', ids.raw, null, ids.item, 5);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("M-1: today's movements are returned when the range ends today (dateTo = today, and dateFrom = dateTo = today)", async () => {
    expect(await count({})).toBe(4); // receipt, transfer_out, transfer_in, dispatch
    expect(await count({ dateTo: today })).toBe(4);
    expect(await count({ dateFrom: today, dateTo: today })).toBe(4);
    expect(await count({ dateFrom: today })).toBe(4);
  });

  it('M-1: day boundaries — 23:59:59.999 of the end day is in, 00:00:00 of the next day is out; the start day begins at 00:00:00', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    // Four ledger rows for a separate item, stamped (session time zone, as the filter is) around one day D = 2 March.
    const D = `${year}-03-02`;
    const stamps = [`${year}-03-01 23:59:59.999`, `${D} 00:00:00`, `${D} 23:59:59.999`, `${year}-03-03 00:00:00`];
    for (const s of stamps) {
      await ds.query(
        `INSERT INTO stock_movements ("id","warehouseId","productId","quantity","movementType","referenceType","referenceId","createdByUserId","createdAt")
         VALUES ($1,$2,$3,1,'adjustment','boundary_test',NULL,$4,($5::timestamp)::timestamptz)`,
        [randomUUID(), ids.raw, ids.boundaryItem, maker, s],
      );
    }
    const at = async (f: { dateFrom?: string; dateTo?: string }) =>
      (await inv.listMovements({ productId: ids.boundaryItem, ...f }, ds.manager)).map((r) => Number(new Date(r.createdAt)));
    const expected = async (...i: number[]) =>
      Promise.all(i.map(async (k) => Number(new Date((await ds.query(`SELECT ($1::timestamp)::timestamptz AS t`, [stamps[k]]))[0].t))));

    expect((await at({ dateFrom: D, dateTo: D })).sort()).toEqual((await expected(1, 2)).sort());
    expect((await at({ dateTo: D })).sort()).toEqual((await expected(0, 1, 2)).sort());
    expect((await at({ dateFrom: D })).sort()).toEqual((await expected(1, 2, 3)).sort());
    // A full timestamp keeps its exact, inclusive meaning (unchanged behaviour for any caller sending one).
    const exact = (await ds.query(`SELECT ($1::timestamp)::timestamptz AS t`, [`${D} 00:00:00`]))[0].t as Date;
    expect((await at({ dateTo: new Date(exact).toISOString() })).sort()).toEqual((await expected(0, 1)).sort());
  });

  it('M-2 (policy pinned, D-CR7): a backdated document keeps its business date on the document; the ledger and the report use posting time', async () => {
    const ds = await h.connections.getDataSource(h.companyAId);
    const [row] = await ds.query(
      `SELECT t."movementDate"::date::text AS document_date, sm."createdAt"::date::text AS ledger_date
         FROM warehouse_transactions t JOIN stock_movements sm ON sm."referenceId" = t.id::text WHERE t.id = $1`,
      [backdatedReceiptId],
    );
    expect(row.document_date).toBe(`${year}-01-10`);
    expect(row.ledger_date).toBe(today);
    expect(await count({ dateFrom: `${year}-01-01`, dateTo: `${year}-01-31` })).toBe(0);
    expect(await count({ dateFrom: today, dateTo: today })).toBe(4);
  });

  it('running balance per warehouse, read oldest-first from the report, equals on-hand after every movement', async () => {
    const manager = await m();
    const walk = async (warehouseId: string) => {
      const rows = (await inv.listMovements({ warehouseId, productId: ids.item }, manager)).reverse();
      let balance = 0;
      return rows.map((r) => ({ type: r.movementType, in: Math.max(Number(r.quantity), 0), out: Math.max(-Number(r.quantity), 0), balance: (balance += Number(r.quantity)) }));
    };
    expect(await walk(ids.raw)).toEqual([
      { type: 'receipt', in: 100, out: 0, balance: 100 },
      { type: 'transfer_out', in: 0, out: 30, balance: 70 },
      { type: 'dispatch', in: 0, out: 5, balance: 65 },
    ]);
    expect(await walk(ids.prod)).toEqual([{ type: 'transfer_in', in: 30, out: 0, balance: 30 }]);
    expect(await inv.getOnHandQuantityInTransaction(manager, ids.raw, ids.item)).toBe(65);
    expect(await inv.getOnHandQuantityInTransaction(manager, ids.prod, ids.item)).toBe(30);
    // The item's total across warehouses is the receipt minus the issue — the transfer moves stock, it never creates or loses any.
    expect(65 + 30).toBe(100 - 5);
  });

  it('a date window ending before today plus one ending today reproduce the full running balance (no movement lost or double counted)', async () => {
    const manager = await m();
    const all = await inv.listMovements({ warehouseId: ids.raw, productId: ids.item }, manager);
    const yesterday = (await (await h.connections.getDataSource(h.companyAId)).query(`SELECT (current_date - 1)::text AS d`))[0].d as string;
    const before = await inv.listMovements({ warehouseId: ids.raw, productId: ids.item, dateTo: yesterday }, manager);
    const onToday = await inv.listMovements({ warehouseId: ids.raw, productId: ids.item, dateFrom: today, dateTo: today }, manager);
    expect(before.length + onToday.length).toBe(all.length);
    const sum = (rows: Array<{ quantity: number }>) => rows.reduce((s, r) => s + Number(r.quantity), 0);
    expect(sum(before) + sum(onToday)).toBe(await inv.getOnHandQuantityInTransaction(manager, ids.raw, ids.item));
  });
});
