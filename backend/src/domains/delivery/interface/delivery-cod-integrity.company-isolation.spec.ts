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
 * Vehicle Driver Workspace, Stage C / F-2 (2026-10-22) — real-Postgres proof that the cash-on-delivery rules live on the SERVER (a UI restriction alone is not enough):
 *  - a cash-on-delivery shipment is never confirmed delivered without a recorded collection;
 *  - a collection must be a positive 2-decimal amount and may not exceed the cash-on-delivery amount (refused before any Treasury posting);
 *  - the recording is one transaction serialised per shipment: concurrent submits post the custody cash exactly once, and a failure leaves nothing behind;
 *  - the existing lifecycle is preserved: non-COD shipments still deliver without a collection, a COD shipment can still fail without one, the collection keeps its remittance path.
 */
describe('F-2 — cash-on-delivery integrity is enforced on the server — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let service: DeliveryService;
  let treasury: TreasuryService;
  const actor = randomUUID();
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
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
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
    service = new DeliveryService(h.controlPlane, shipments, fulfillment, salesOrders, treasury, inventory, audit, events, inert, inert);
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('F2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  it('D1 a cash-on-delivery shipment cannot be confirmed delivered without a collection — refused with a zero-side-effects fingerprint', async () => {
    const s = await newShipment('A', '1200.00');
    const before = await fingerprint('A', s);
    await expect(deliver('A', s)).rejects.toThrow(/cash on delivery.*record the collection before confirming the delivery/);
    expect(await fingerprint('A', s)).toEqual(before);
    expect(before.state).toBe('out_for_delivery');
  });

  it('D2 the collection amount is validated BEFORE any posting: zero, negative, three decimals, text and over-collection are all refused; nothing is recorded', async () => {
    const s = await newShipment('A', '500.00');
    const before = await fingerprint('A', s);
    for (const bad of ['0', '0.00', '-5', '10.123', 'abc', '']) await expect(collect('A', s, bad)).rejects.toThrow(/positive number with at most two decimals/);
    await expect(collect('A', s, '500.01')).rejects.toThrow(/exceeds the cash-on-delivery amount 500.00/);
    await expect(collect('A', s, '9999.00')).rejects.toThrow(/exceeds the cash-on-delivery amount/);
    expect(await fingerprint('A', s)).toEqual(before);
  });

  it('D3 collect the full amount, then deliver: one collection, one custody cash-in, delivered, and the collection keeps its remittance state (pending)', async () => {
    const s = await newShipment('A', '1200.00');
    const before = await fingerprint('A');
    const c = await collect('A', s, '1200.00');
    expect(c.remittanceStatus).toBe('pending');
    const o = await deliver('A', s);
    expect(o.outcome).toBe('delivered');
    const after = await fingerprint('A', s);
    expect(after.state).toBe('delivered');
    expect(after.collections - before.collections).toBe(1);
    expect(after.outcomes - before.outcomes).toBe(1);
    expect(after.custodyTxns - before.custodyTxns).toBe(1);
    expect(await treasury.getAccountBalance(ctx.A.custodyAccountId, (await dsOf('A')).manager)).toBe('1200.00'); // the only cash recorded so far in Company A's custody account
  });

  it('D4 a short collection (less than expected) is accepted and the delivery can then be confirmed (the shortfall stays a receivable — no new rule invented)', async () => {
    const s = await newShipment('A', '800.00');
    const c = await collect('A', s, '500.00');
    expect(c.amount).toBe('500.00');
    expect((await deliver('A', s)).outcome).toBe('delivered');
  });

  it('D5 the existing lifecycle is preserved: a non-COD shipment delivers without a collection; a COD shipment can still be recorded as failed without one', async () => {
    const plain = await newShipment('A', null);
    expect((await deliver('A', plain)).outcome).toBe('delivered');
    const cod = await newShipment('A', '300.00');
    const o = await service.recordOutcome(cod, 'failed', 'customer unavailable', actor, (await dsOf('A')).manager);
    expect(o.outcome).toBe('failed');
    expect((await fingerprint('A', cod)).state).toBe('failed');
  });

  it('D6 five concurrent collections for one shipment post the custody cash EXACTLY ONCE (serialised per shipment); the loser is refused, not double-posted', async () => {
    const s = await newShipment('A', '700.00');
    const before = await fingerprint('A');
    const results = await Promise.allSettled(Array.from({ length: 5 }, async () => collect('A', s, '700.00')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = await fingerprint('A');
    expect(after.collections - before.collections).toBe(1);
    expect(after.custodyTxns - before.custodyTxns).toBe(1);
    await expect(collect('A', s, '700.00')).rejects.toThrow(/already has a recorded collection/);
  });

  it('D7 atomic: a failure after the custody cash-in (at the event publish) rolls the cash-in back too — no orphan custody movement, and a retry then succeeds once', async () => {
    const s = await newShipment('A', '250.00');
    const before = await fingerprint('A');
    const spy = jest.spyOn(EventBusService.prototype, 'publish').mockRejectedValueOnce(new Error('injected failure at publish'));
    await expect(collect('A', s, '250.00')).rejects.toThrow(/injected failure/);
    spy.mockRestore();
    expect(await fingerprint('A')).toEqual(before);
    const c = await collect('A', s, '250.00');
    expect(c.amount).toBe('250.00');
    const after = await fingerprint('A');
    expect(after.collections - before.collections).toBe(1);
    expect(after.custodyTxns - before.custodyTxns).toBe(1);
  });

  it('D8 Company B is untouched by all of the above', async () => {
    const b = await fingerprint('B');
    expect(b.collections).toBe(0);
    expect(b.outcomes).toBe(0);
    expect(b.custodyTxns).toBe(0);
  });
});
