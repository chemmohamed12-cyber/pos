import { randomUUID } from 'crypto';
import { DeliveryService } from '../application/delivery.service';
import { LineDeliveryService } from '../application/line-delivery.service';
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
 * Vehicle Driver Workspace, Stage C / C2 (2026-10-22; D-1) - real-Postgres proof of the per-line partial-delivery events: never above the shipped quantity, derived progress, only while
 * out for delivery, idempotent retries, serialised per shipment, the final delivered outcome gated on every line being accounted for, and no change to the legacy whole-shipment flow.
 */
describe('C2 — per-line partial-delivery events — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let service: DeliveryService;
  let lines: LineDeliveryService;
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
    lines = new LineDeliveryService(h.controlPlane, shipments, audit);
    service = new DeliveryService(h.controlPlane, shipments, fulfillment, salesOrders, treasury, inventory, audit, events, numbering, inert, inert);
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('F2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  let baseRefs: { customerId: string; warehouseId: string } | null = null;
  async function addLines(shipmentId: string, qtys: number[]): Promise<string[]> {
    const ds = await dsOf('A');
    if (!baseRefs) {
      baseRefs = { customerId: randomUUID(), warehouseId: randomUUID() };
      await ds.query(`INSERT INTO "customers" ("id","code","name") VALUES ($1,'CUST-C2','C2 Customer')`, [baseRefs.customerId]);
      await ds.query(`INSERT INTO "warehouses" ("id","code","name","status") VALUES ($1,'WH-C2','C2 Warehouse','active')`, [baseRefs.warehouseId]);
    }
    const ids: string[] = [];
    for (const q of qtys) {
      const id = randomUUID();
      const productId = randomUUID();
      const orderId = randomUUID();
      const orderLineId = randomUUID();
      const tag = id.slice(0, 8);
      ids.push(id);
      await ds.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'10.00','active')`, [productId, `SKU-C2-${tag}`, `C2 Product ${tag}`]);
      await ds.query(`INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","warehouseId") VALUES ($1,$2,$3,$4,$5,$6)`, [orderId, `SO-C2-${tag}`, baseRefs.customerId, actor, (q * 10).toFixed(2), baseRefs.warehouseId]);
      await ds.query(`INSERT INTO "sales_order_lines" ("id","salesOrderId","productId","quantity","unitPrice","listPrice","lineTotal") VALUES ($1,$2,$3,$4,'10.00','10.00',$5)`, [orderLineId, orderId, productId, q, (q * 10).toFixed(2)]);
      await ds.query(`INSERT INTO "shipment_lines" ("id","shipmentId","salesOrderLineId","productId","quantity","unitPrice","lineTotal") VALUES ($1,$2,$3,$4,$5,'10.00',$6)`, [id, shipmentId, orderLineId, productId, q, (q * 10).toFixed(2)]);
    }
    return ids;
  }
  const mgr = async (k: Key) => (await dsOf(k)).manager;
  const ev = async (shipmentId: string, lineId: string, kind: 'delivered' | 'returned', quantity: number, reason?: string, clientKey?: string) =>
    lines.record({ shipmentId, shipmentLineId: lineId, kind, quantity, reason, clientKey }, actor, await mgr('A'));
  const count = async () => Number((await (await dsOf('A')).query(`SELECT count(*) AS n FROM "shipment_line_deliveries"`))[0].n);

  it('G1 per-line events: delivered + returned never exceed the shipped quantity of a line; progress is derived (none -> in_progress -> partial / complete)', async () => {
    const s = await newShipment('A', null);
    const [l1, l2] = await addLines(s, [5, 3]);
    expect((await lines.getProgress(s, actor, await mgr('A'))).status).toBe('none');
    await ev(s, l1, 'delivered', 3);
    await expect(ev(s, l1, 'delivered', 3)).rejects.toThrow(/Only 2 unit\(s\) of this line are still outstanding/);
    await ev(s, l1, 'returned', 2, 'customer refused two');
    await ev(s, l2, 'delivered', 1);
    let p = await lines.getProgress(s, actor, await mgr('A'));
    expect(p.status).toBe('in_progress');
    expect(p.lines.find((x) => x.shipmentLineId === l2)).toMatchObject({ shipped: 3, delivered: 1, returned: 0, outstanding: 2 });
    await ev(s, l2, 'delivered', 2);
    p = await lines.getProgress(s, actor, await mgr('A'));
    expect(p.status).toBe('partial'); // every line accounted for, some units came back
    expect(p.events).toHaveLength(4);
  });

  it('G2 validation: whole quantity >= 1, a reason is mandatory for returned units, a foreign line is "not found", nothing is recorded on refusal', async () => {
    const s = await newShipment('A', null);
    const other = await newShipment('A', null);
    const [l1] = await addLines(s, [4]);
    const [foreign] = await addLines(other, [4]);
    const before = await count();
    await expect(ev(s, l1, 'delivered', 0)).rejects.toThrow(/whole number of at least 1/);
    await expect(ev(s, l1, 'delivered', 1.5)).rejects.toThrow(/whole number/);
    await expect(ev(s, l1, 'returned', 1)).rejects.toThrow(/reason of 3-255/);
    await expect(ev(s, foreign, 'delivered', 1)).rejects.toThrow(/does not belong to this shipment/);
    expect(await count()).toBe(before);
  });

  it('G3 events are recorded only while the shipment is out for delivery', async () => {
    const s = await newShipment('A', null, 'in_transit');
    const [l1] = await addLines(s, [2]);
    await expect(ev(s, l1, 'delivered', 1)).rejects.toThrow(/while the shipment is out for delivery \(it is "in_transit"\)/);
  });

  it('G4 a retry with the same clientKey returns the first event and records nothing again; a different payload under the same key is refused', async () => {
    const s = await newShipment('A', null);
    const [l1] = await addLines(s, [6]);
    const before = await count();
    const a = await ev(s, l1, 'delivered', 2, undefined, 'line-key-0001');
    const b = await ev(s, l1, 'delivered', 2, undefined, 'line-key-0001');
    expect(b.id).toBe(a.id);
    expect((await count()) - before).toBe(1);
    await expect(ev(s, l1, 'delivered', 3, undefined, 'line-key-0001')).rejects.toThrow(/already used for a different line event/);
  });

  it('G5 concurrent events for one line cannot exceed it (serialised per shipment)', async () => {
    const s = await newShipment('A', null);
    const [l1] = await addLines(s, [5]);
    const results = await Promise.allSettled(Array.from({ length: 8 }, async () => ev(s, l1, 'delivered', 1)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect((await lines.getProgress(s, actor, await mgr('A'))).lines[0].outstanding).toBe(0);
  });

  it('G6 the final delivered outcome needs every line accounted for once events exist; with no events the legacy flow is unchanged; the final outcome follows', async () => {
    const legacy = await newShipment('A', null);
    await addLines(legacy, [2]);
    expect((await deliver('A', legacy)).outcome).toBe('delivered'); // no events: whole-shipment flow as before

    const s = await newShipment('A', null);
    const [l1, l2] = await addLines(s, [3, 2]);
    await ev(s, l1, 'delivered', 3);
    await expect(deliver('A', s)).rejects.toThrow(/still has 1 line\(s\) not accounted for/);
    expect((await fingerprint('A', s)).state).toBe('out_for_delivery');
    await ev(s, l2, 'returned', 2, 'wrong item');
    expect((await deliver('A', s)).outcome).toBe('delivered');
    expect((await fingerprint('A', s)).state).toBe('delivered');
  });

  it('G7 only the assigned driver or an admin may record; a stranger is refused; Company B is untouched', async () => {
    const s = await newShipment('A', null);
    const [l1] = await addLines(s, [2]);
    const stranger = randomUUID();
    await (await dsOf('A')).query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'Stranger','g7-stranger@test.local')`, [stranger]);
    await expect(lines.record({ shipmentId: s, shipmentLineId: l1, kind: 'delivered', quantity: 1 }, stranger, await mgr('A'))).rejects.toThrow(/assigned driver/);
    expect(Number((await (await dsOf('B')).query(`SELECT count(*) AS n FROM "shipment_line_deliveries"`))[0].n)).toBe(0);
  });
});
