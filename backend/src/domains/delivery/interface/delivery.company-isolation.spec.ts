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
import { DeliveryOutcome } from '../infrastructure/delivery-outcome.entity';
import { Collection } from '../infrastructure/collection.entity';
import {
  setUpTwoCompanyHarness,
  TwoCompanyHarness,
  assertDataSourceNeverRequestedFor,
} from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized).
 * Real-Postgres proof that `delivery.controller.ts`'s reads/writes are
 * genuinely Company-scoped after this retrofit — two real, separately
 * provisioned Company databases, each with its own distinct shipment,
 * shipping company, and custody treasury account, never mocked.
 *
 * `recordCollection` against a custodian shipment is the deep-chain
 * proof: it transitively exercises `ShipmentService.getCustodianForShipment`
 * (the concrete gap this retrofit found and fixed, one level into an
 * already-closed §29 controller's own service) and
 * `TreasuryService.cashIn` against each Company's own custody account.
 * `FulfillmentContract`/`SalesOrdersReadContract` are stubbed (their own
 * Company-isolation is proven by §31's and a future controller's own
 * specs respectively) — this spec's job is `DeliveryService`'s own
 * tables and its own Shipment/Treasury integration, not re-proving
 * every transitive domain.
 */
describe('DeliveryController Area 21 retrofit — real-Postgres Company isolation (2026-09-28)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let service: DeliveryService;
  const actorUserId = randomUUID();

  const seeded: Record<'A' | 'B', { shipmentId: string; custodyAccountId: string; settlementAccountId: string }> = {
    A: { shipmentId: '', custodyAccountId: '', settlementAccountId: '' },
    B: { shipmentId: '', custodyAccountId: '', settlementAccountId: '' },
  };

  async function seedCompanyData(companyId: string, key: 'A' | 'B', code: string) {
    const ds = await h.connections.getDataSource(companyId);

    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      actorUserId,
      'Isolation Test Admin',
      `iso-admin-${companyId}@test.local`,
    ]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      randomUUID(),
      actorUserId,
      role[0].id,
    ]);

    // `MAIN-CASH` — the migration-seeded default settlement account (same
    // "rely on the migration default" precedent as `payments.company-isolation.spec.ts`).
    const mainCash: Array<{ id: string }> = await ds.query(`SELECT id FROM "treasury_accounts" WHERE "code" = 'MAIN-CASH'`);
    const custodyType: Array<{ id: string }> = await ds.query(`SELECT id FROM "treasury_account_types" WHERE "code" = 'custody'`);
    const custodyAccountId = randomUUID();
    await ds.query(`INSERT INTO "treasury_accounts" ("id","code","name","accountTypeId","status") VALUES ($1,$2,'Custody',$3,'active')`, [
      custodyAccountId,
      `CUST-${code}`,
      custodyType[0].id,
    ]);

    const shippingCompanyId = randomUUID();
    await ds.query(
      `INSERT INTO "shipping_companies" ("id","code","name","custodyAccountId","treasuryAccountId","status") VALUES ($1,$2,$3,$4,$5,'active')`,
      [shippingCompanyId, `SC-${code}`, `${code} Shipping Co`, custodyAccountId, mainCash[0].id],
    );

    const shipmentId = randomUUID();
    await ds.query(
      `INSERT INTO "shipments" ("id","fulfillmentOrderId","waybillNumber","shippingCompanyId") VALUES ($1,$2,$3,$4)`,
      [shipmentId, randomUUID(), `WB-${code}`, shippingCompanyId],
    );
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'shipment_lifecycle','shipment',$2,'out_for_delivery')`,
      [randomUUID(), shipmentId],
    );

    seeded[key] = { shipmentId, custodyAccountId, settlementAccountId: mainCash[0].id };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'delivery_isolation', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'] });
    await seedCompanyData(h.companyAId, 'A', 'A');
    await seedCompanyData(h.companyBId, 'B', 'B');

    const dsA = await h.connections.getDataSource(h.companyAId);
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    const events = new EventBusService(inert);
    const processEngine = new ProcessEngineService(h.controlPlane);
    // Fallback-only construction (every call below supplies its own
    // manager, which always wins) — same precedent as
    // `customer-ledger.company-isolation.spec.ts`/`payments.company-isolation.spec.ts`.
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    const shipments = new ShipmentService(h.controlPlane, numbering, processEngine, authorization, audit, events, inert, inert, treasury, inert, inert, inert);

    // Stubs — `FulfillmentOrder`/`SalesOrder` Company-isolation is proven by
    // §31's own spec and a future controller's own spec respectively; this
    // spec's job is `DeliveryService`'s own tables and its real Shipment/
    // Treasury integration, not re-deriving two more domains' full setup.
    const fulfillment = {
      getFulfillmentOrder: async (fulfillmentOrderId: string) => ({
        id: fulfillmentOrderId,
        salesOrderId: randomUUID(),
        warehouseId: randomUUID(),
        orderNumber: null,
        createdAt: new Date(),
      }),
      getFulfillmentOrderBySalesOrderId: async () => null,
    } as unknown as FulfillmentContract;
    const salesOrders = { getOrderSnapshot: async () => null } as unknown as SalesOrdersReadContract;

    service = new DeliveryService(h.controlPlane, shipments, fulfillment, salesOrders, treasury, inert, audit, events, inert, inert);
  });

  afterAll(async () => {
    await h.teardown();
  });

  it("recordOutcome ('failed') for Company A transitions its own shipment and writes the outcome inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const outcome = await service.recordOutcome(seeded.A.shipmentId, 'failed', 'customer unavailable', actorUserId, dsA.manager);
    expect(outcome.shipmentId).toBe(seeded.A.shipmentId);

    const row = await dsA.getRepository(DeliveryOutcome).findOne({ where: { id: outcome.id } });
    expect(row).toBeTruthy();
  });

  it("recordOutcome for Company B transitions independently in Company B's own database", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const outcome = await service.recordOutcome(seeded.B.shipmentId, 'failed', null, actorUserId, dsB.manager);
    expect(outcome.shipmentId).toBe(seeded.B.shipmentId);

    const rowInB = await dsB.getRepository(DeliveryOutcome).findOne({ where: { shipmentId: seeded.A.shipmentId } });
    expect(rowInB).toBeNull();
  });

  it("recordCollection for Company A posts custody cash-in against Company A's own custody account — never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const collection = await service.recordCollection(seeded.A.shipmentId, '300.00', 'cash', actorUserId, dsA.manager);
    expect(collection.custodyAccountId).toBe(seeded.A.custodyAccountId);

    const row = await dsA.getRepository(Collection).findOne({ where: { id: collection.id } });
    expect(row).toBeTruthy();
    expect(row!.remittanceStatus).toBe('pending');
  });

  it("recordCollection for Company B posts independently against Company B's own custody account", async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    const collection = await service.recordCollection(seeded.B.shipmentId, '450.00', 'cash', actorUserId, dsB.manager);
    expect(collection.custodyAccountId).toBe(seeded.B.custodyAccountId);
    expect(collection.custodyAccountId).not.toBe(seeded.A.custodyAccountId);
  });

  it("listPendingRemittances via Company A resolves only Company A's own collection — never Company B's", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const pending = await service.listPendingRemittances(dsA.manager);
    expect(pending).toHaveLength(1);
    expect(pending[0].amount).toBe('300.00');
  });

  it("remitCollection for Company A transfers custody -> settlement inside Company A's own database", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const pending = await service.listPendingRemittances(dsA.manager);
    const remitted = await service.remitCollection(pending[0].id, actorUserId, undefined, dsA.manager);
    expect(remitted.remittanceStatus).toBe('remitted');
    expect(remitted.treasuryTransactionId).toBeTruthy();

    const stillPending = await service.listPendingRemittances(dsA.manager);
    expect(stillPending).toHaveLength(0);
  });

  it("Test F — resolving Company A's delivery data never even requests Company B's DataSource", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await service.getOutcomeForShipment(seeded.A.shipmentId, actorUserId, dsA.manager);
      await service.getCollectionForShipmentUnscoped(seeded.A.shipmentId, dsA.manager);
      await service.listPendingRemittances(dsA.manager);
    });
  });
});
