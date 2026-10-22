import { randomUUID } from 'crypto';
import { DeliveryService } from '../application/delivery.service';
import { ShipmentService } from '../../shipment/application/shipment.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { FulfillmentContract } from '../../../foundation/module-registry/contracts/inventory.contract';
import { SalesOrdersReadContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Vehicle Driver Workspace, Stage C / C1 (2026-10-22; D-2, D-3) - real-Postgres proof of the custody record, several collections per shipment under the "never above the expected
 * total" invariant, driver-records / someone-else-confirms, rejection with an append-only custody reversal, idempotent retries, and the preserved remittance path.
 */
describe('C1 — custody record, several collections and cashier confirmation — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let service: DeliveryService;
  let treasury: TreasuryService;
  const actor = randomUUID();
  const checker = randomUUID();
  type Key = 'A' | 'B';
  const ctx: Record<Key, { custodyAccountId: string }> = { A: { custodyAccountId: '' }, B: { custodyAccountId: '' } };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function newShipment(k: Key, cod: string | null, state = 'out_for_delivery'): Promise<string> {
    const ds = await dsOf(k);
    const sc: Array<{ id: string }> = await ds.query(`SELECT id FROM "shipping_companies" LIMIT 1`);
    const id = randomUUID();
    await ds.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","shippingCompanyId","codAmount") VALUES ($1,$2,$3,$4,$5)`, [id, randomUUID(), `WB-F2-${id.slice(0, 8)}`, sc[0].id, cod]);
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,$3)`, [randomUUID(), id, state]);
    return id;
  }
  async function fingerprint(k: Key, shipmentId?: string) {
    const ds = await dsOf(k);
    const n = async (sql: string, p: unknown[] = []) => Number((await ds.query(sql, p))[0].n);
    return {
      collections: await n(`SELECT count(*) AS n FROM "collections"`),
      outcomes: await n(`SELECT count(*) AS n FROM "delivery_outcomes"`),
      custodyTxns: await n(`SELECT count(*) AS n FROM "treasury_transactions"`),
      outbox: await n(`SELECT count(*) AS n FROM "event_outbox"`),
      state: shipmentId ? (await ds.query(`SELECT "currentState" AS s FROM "process_instances" WHERE "entityId" = $1`, [shipmentId]))[0].s : null,
    };
  }
  const collect = async (k: Key, shipmentId: string, amount: string) => service.recordCollection(shipmentId, amount, 'cash', actor, (await dsOf(k)).manager);
  const deliver = async (k: Key, shipmentId: string) => service.recordOutcome(shipmentId, 'delivered', null, actor, (await dsOf(k)).manager);

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'F2 Admin',$2) ON CONFLICT DO NOTHING`, [actor, `f2-${k}@test.local`]);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'C1 Checker',$2) ON CONFLICT DO NOTHING`, [checker, `c1-chk-${k}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), checker, role[0].id]);
    const mainCash: Array<{ id: string }> = await ds.query(`SELECT id FROM "treasury_accounts" WHERE "code" = 'MAIN-CASH'`);
    const custodyType: Array<{ id: string }> = await ds.query(`SELECT id FROM "treasury_account_types" WHERE "code" = 'custody'`);
    const custodyAccountId = randomUUID();
    await ds.query(`INSERT INTO "treasury_accounts" ("id","code","name","accountTypeId","status") VALUES ($1,$2,'Custody',$3,'active')`, [custodyAccountId, `CUST-F2-${k}`, custodyType[0].id]);
    await ds.query(`INSERT INTO "shipping_companies" ("id","code","name","custodyAccountId","treasuryAccountId","status") VALUES ($1,$2,$3,$4,$5,'active')`, [randomUUID(), `SC-F2-${k}`, `${k} Carrier`, custodyAccountId, mainCash[0].id]);
    ctx[k].custodyAccountId = custodyAccountId;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'f2_cod_integrity', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'] });
    await seed('A');
    await seed('B');
    const dsA = await dsOf('A');
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    const shipments = new ShipmentService(h.controlPlane, numbering, processEngine, authorization, audit, events, inert, inert, treasury, inert, inert, inert);
    const fulfillment = {
      getFulfillmentOrder: async (id: string) => ({ id, salesOrderId: randomUUID(), warehouseId: randomUUID(), orderNumber: null, createdAt: new Date() }),
      getFulfillmentOrderBySalesOrderId: async () => null,
    } as unknown as FulfillmentContract;
    const salesOrders = { getOrderSnapshot: async () => null } as unknown as SalesOrdersReadContract;
    const inventory = { fulfillReservationsForOrder: async () => undefined } as never;
    service = new DeliveryService(h.controlPlane, shipments, fulfillment, salesOrders, treasury, inventory, audit, events, numbering, inert, inert);
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('F2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  const rows = async (k: Key, sql: string, p: unknown[] = []) => (await dsOf(k)).query(sql, p);
  const mgr = async (k: Key) => (await dsOf(k)).manager;

  it('E1 two instalments are accepted, the one that would exceed the expected total is refused; ONE custody record (CUS-numbered) is shared by all collections', async () => {
    const s = await newShipment('A', '1000.00');
    const c1 = await collect('A', s, '400.00');
    const c2 = await collect('A', s, '500.00');
    await expect(collect('A', s, '100.01')).rejects.toThrow(/would exceed the cash-on-delivery amount 1000.00.*already collected 900.00, remaining 100.00/);
    const c3 = await collect('A', s, '100.00');
    expect([c1, c2, c3].every((c) => c.verificationStatus === 'recorded')).toBe(true);
    const cust = await rows('A', `SELECT * FROM "shipment_custodies" WHERE "shipmentId" = $1`, [s]);
    expect(cust).toHaveLength(1);
    expect(cust[0].custodyNumber).toMatch(/^CUS-/);
    expect(cust[0].expectedAmount).toBe('1000.00');
    expect(new Set([c1.custodyId, c2.custodyId, c3.custodyId])).toEqual(new Set([cust[0].id]));
    expect((await rows('A', `SELECT sum("amount")::text AS t FROM "collections" WHERE "shipmentId" = $1`, [s]))[0].t).toBe('1000.00');
  });

  it('E2 a shipment with no expected amount keeps the legacy single-collection rule', async () => {
    const s = await newShipment('A', null);
    await collect('A', s, '50.00');
    await expect(collect('A', s, '10.00')).rejects.toThrow(/already has a recorded collection/);
  });

  it('E3 a retry with the same clientKey returns the first collection and posts nothing again; the same key for another amount is refused; a malformed key is refused', async () => {
    const s = await newShipment('A', '600.00');
    const m = await mgr('A');
    const before = await fingerprint('A');
    const first = await service.recordCollection(s, '200.00', 'cash', actor, m, 'client-key-0001');
    const again = await service.recordCollection(s, '200.00', 'cash', actor, m, 'client-key-0001');
    expect(again.id).toBe(first.id);
    const after = await fingerprint('A');
    expect(after.collections - before.collections).toBe(1);
    expect(after.custodyTxns - before.custodyTxns).toBe(1);
    await expect(service.recordCollection(s, '250.00', 'cash', actor, m, 'client-key-0001')).rejects.toThrow(/already used for a different collection/);
    await expect(service.recordCollection(s, '10.00', 'cash', actor, m, 'bad key!')).rejects.toThrow(/clientKey must be/);
  });

  it('E4 concurrent instalments never exceed the expected total (serialised per shipment)', async () => {
    const s = await newShipment('A', '300.00');
    const results = await Promise.allSettled(Array.from({ length: 6 }, async () => collect('A', s, '100.00')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await rows('A', `SELECT sum("amount")::text AS t FROM "collections" WHERE "shipmentId" = $1`, [s]))[0].t).toBe('300.00');
    expect(await rows('A', `SELECT 1 FROM "shipment_custodies" WHERE "shipmentId" = $1`, [s])).toHaveLength(1);
  });

  it('E5 confirmation: the collector cannot confirm his own collection; another user can; confirming twice is idempotent and posts nothing', async () => {
    const s = await newShipment('A', '200.00');
    const c = await collect('A', s, '200.00');
    const m = await mgr('A');
    const before = await fingerprint('A');
    await expect(service.confirmCollection(c.id, actor, m)).rejects.toThrow(/someone other than the person who recorded/);
    const ok = await service.confirmCollection(c.id, checker, m);
    expect(ok.verificationStatus).toBe('confirmed');
    expect(ok.confirmedByUserId).toBe(checker);
    const again = await service.confirmCollection(c.id, checker, m);
    expect(again.verificationStatus).toBe('confirmed');
    expect(await fingerprint('A')).toEqual(before); // confirmation moved no money and published nothing
  });

  it('E6 rejection reverses the custody leg, frees the amount for a re-collection, and a rejected collection can be neither confirmed nor remitted; confirmed ones cannot be rejected', async () => {
    const s = await newShipment('A', '500.00');
    const m = await mgr('A');
    const balBefore = Number(await treasury.getAccountBalance(ctx.A.custodyAccountId, m));
    const c = await collect('A', s, '500.00');
    expect(Number(await treasury.getAccountBalance(ctx.A.custodyAccountId, m))).toBe(balBefore + 500);
    await expect(service.rejectCollection(c.id, 'x', checker, m)).rejects.toThrow(/rejection reason/);
    await expect(service.rejectCollection(c.id, 'cash was short', actor, m)).rejects.toThrow(/someone other than/);
    const rej = await service.rejectCollection(c.id, 'cash was short', checker, m);
    expect(rej.verificationStatus).toBe('rejected');
    expect(rej.rejectionReason).toBe('cash was short');
    expect(Number(await treasury.getAccountBalance(ctx.A.custodyAccountId, m))).toBe(balBefore); // the custody leg was reversed (append-only)
    await expect(service.confirmCollection(c.id, checker, m)).rejects.toThrow(/was rejected/);
    await expect(service.remitCollection(c.id, checker, null, m)).rejects.toThrow(/was rejected/);
    const redo = await collect('A', s, '500.00'); // the rejected amount left the sum
    await service.confirmCollection(redo.id, checker, m);
    await expect(service.rejectCollection(redo.id, 'too late', checker, m)).rejects.toThrow(/already confirmed or remitted/);
    expect((await service.rejectCollection(c.id, 'cash was short', checker, m)).verificationStatus).toBe('rejected'); // idempotent
  });

  it('E7 remittance still works for a collection that was only recorded: it is confirmed by the remittance itself and publishes the single GL event', async () => {
    const s = await newShipment('A', '150.00');
    const m = await mgr('A');
    const c = await collect('A', s, '150.00');
    const main: Array<{ id: string }> = await rows('A', `SELECT id FROM "treasury_accounts" WHERE "code" = 'MAIN-CASH'`);
    const count = async () => (await rows('A', `SELECT count(*)::int AS n FROM "event_outbox" WHERE "topic" = 'collection.remitted'`))[0].n;
    const before = await count();
    const r = await service.remitCollection(c.id, checker, main[0].id, m);
    expect(r.remittanceStatus).toBe('remitted');
    expect(r.verificationStatus).toBe('confirmed');
    expect(r.confirmedByUserId).toBe(checker);
    expect((await count()) - before).toBe(1);
    await expect(service.remitCollection(c.id, checker, main[0].id, m)).rejects.toThrow(/already been remitted/);
  });

  it('E8 delivery needs a collection that still counts: a rejected one does not satisfy the cash-on-delivery rule', async () => {
    const s = await newShipment('A', '120.00');
    const m = await mgr('A');
    const c = await collect('A', s, '120.00');
    await service.rejectCollection(c.id, 'not received', checker, m);
    await expect(deliver('A', s)).rejects.toThrow(/record the collection before confirming the delivery/);
    await collect('A', s, '120.00');
    expect((await deliver('A', s)).outcome).toBe('delivered');
    expect((await service.listCollectionsForShipmentUnscoped(s, m)).map((x) => x.verificationStatus)).toEqual(['rejected', 'recorded']);
  });

  it('E9 Company B is untouched', async () => {
    const b = await fingerprint('B');
    expect(b.collections).toBe(0);
    expect(await rows('B', `SELECT 1 FROM "shipment_custodies"`)).toHaveLength(0);
  });
});
