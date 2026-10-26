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
 * Integration proof (trial branch integration/vw-on-1.1.12, 2026-10-26): the rules of feature/direct-sale-shipping (a direct sale is handed over at the counter: only the `delivered`
 * outcome, action `direct_handover`, no driver/custody) AND the rules of the vehicle workspace work (a cash-on-delivery shipment is never delivered without a collection that still
 * counts; per-item events gate only shipments that have them) hold TOGETHER in `DeliveryService.recordOutcome` - neither side's behaviour was dropped to resolve the conflict.
 */
describe('INT — direct sale + cash-on-delivery/per-item rules together in recordOutcome — real-Postgres', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let service: DeliveryService;
  let treasury: TreasuryService;
  const actor = randomUUID();
  const checker = randomUUID();
  const directOrders = new Set<string>();
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
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'INT Checker',$2) ON CONFLICT DO NOTHING`, [checker, `int-chk-${k}@test.local`]);
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
    const shipments = new ShipmentService(h.controlPlane, numbering, processEngine, authorization, audit, events, inert, inert, treasury, { getOrderSnapshot: async (id: string) => ({ id, customerId: null, totalAmount: '0.00', shippingMethod: directOrders.has(id) ? 'direct_sale' : 'delivery' }) } as never, inert, inert);
    const fulfillment = {
      getFulfillmentOrder: async (id: string) => ({ id, salesOrderId: randomUUID(), warehouseId: randomUUID(), orderNumber: null, createdAt: new Date() }),
      getFulfillmentOrderBySalesOrderId: async () => null,
    } as unknown as FulfillmentContract;
    const salesOrders = { getOrderSnapshot: async (id: string) => ({ id, customerId: null, totalAmount: '0.00', shippingMethod: directOrders.has(id) ? 'direct_sale' : 'delivery' }) } as unknown as SalesOrdersReadContract;
    const inventory = { fulfillReservationsForOrder: async () => undefined } as never;
    service = new DeliveryService(h.controlPlane, shipments, fulfillment, salesOrders, treasury, inventory, audit, events, numbering, inert, inert);
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('F2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  async function directShipment(cod: string | null, state = 'created'): Promise<{ shipmentId: string; orderId: string }> {
    const ds = await dsOf('A');
    const id = randomUUID();
    const orderId = randomUUID();
    directOrders.add(orderId);
    await ds.query(`INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","codAmount","salesOrderId") VALUES ($1,$2,$3,$4,$5)`, [id, randomUUID(), `WB-INT-${id.slice(0, 8)}`, cod, orderId]);
    await ds.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,$3)`, [randomUUID(), id, state]);
    return { shipmentId: id, orderId };
  }

  it('X1 direct sale: only the hand-over ("delivered") is accepted - failed / refused / returned are refused by the direct-sale rule and change nothing', async () => {
    const { shipmentId } = await directShipment(null);
    const before = await fingerprint('A', shipmentId);
    for (const outcome of ['failed', 'refused', 'returned'] as const) {
      await expect(service.recordOutcome(shipmentId, outcome, 'x', actor, (await dsOf('A')).manager)).rejects.toThrow(/direct sale from the company - only a hand-over/);
    }
    expect(await fingerprint('A', shipmentId)).toEqual(before);
  });

  it('X2 direct sale WITHOUT cash on delivery: handed over in one step created -> delivered (action direct_handover), no collection needed', async () => {
    const { shipmentId } = await directShipment(null);
    const o = await service.recordOutcome(shipmentId, 'delivered', null, actor, (await dsOf('A')).manager);
    expect(o.outcome).toBe('delivered');
    expect((await fingerprint('A', shipmentId)).state).toBe('delivered');
  });

  it('X3 direct sale WITH a cash amount: the vehicle-workspace collection rule still applies at the counter - refused until a collection is recorded, then handed over', async () => {
    const { shipmentId } = await directShipment('450.00');
    const before = await fingerprint('A', shipmentId);
    await expect(service.recordOutcome(shipmentId, 'delivered', null, actor, (await dsOf('A')).manager)).rejects.toThrow(/cash on delivery.*record the collection before confirming the delivery/);
    expect(await fingerprint('A', shipmentId)).toEqual(before);
    const c = await service.recordCollection(shipmentId, '450.00', 'cash', actor, (await dsOf('A')).manager);
    expect(c.verificationStatus).toBe('recorded');
    const o = await service.recordOutcome(shipmentId, 'delivered', null, actor, (await dsOf('A')).manager);
    expect(o.outcome).toBe('delivered');
    const after = await fingerprint('A', shipmentId);
    expect(after.state).toBe('delivered');
    expect(after.collections - before.collections).toBe(1);
  });

  it('X4 the rejected-collection rule holds for a direct sale too: a rejected collection does not satisfy the hand-over', async () => {
    const { shipmentId } = await directShipment('120.00');
    const m = (await dsOf('A')).manager;
    const c = await service.recordCollection(shipmentId, '120.00', 'cash', actor, m);
    await service.rejectCollection(c.id, 'counted short at the counter', checker, m);
    await expect(service.recordOutcome(shipmentId, 'delivered', null, actor, m)).rejects.toThrow(/record the collection before confirming the delivery/);
  });

  it('X5 a normal (non-direct) shipment is unchanged by the integration: failed outcome allowed, delivered needs its collection and its items', async () => {
    const plain = await newShipment('A', '200.00');
    expect((await service.recordOutcome(plain, 'failed', 'customer away', actor, (await dsOf('A')).manager)).outcome).toBe('failed');
    const cod = await newShipment('A', '300.00');
    await expect(deliver('A', cod)).rejects.toThrow(/record the collection before confirming the delivery/);
    await collect('A', cod, '300.00');
    expect((await deliver('A', cod)).outcome).toBe('delivered');
  });
});
