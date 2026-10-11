import { randomUUID } from 'crypto';
import { ShipmentService } from '../../domains/shipment/application/shipment.service';
import { TreasuryService } from '../../domains/treasury/application/treasury.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { NumberingService } from '../numbering/numbering.service';
import { BizEnv, abortBiz, attempt, finishBiz, receive, record, result, seedProduct, seedWarehouse, setUpBiz, tally, widePool } from './biz-support';

/**
 * T-25 — H5 shipment-transition fixture and measurement (WP-INV-07; spec: DAII-N02-SIBLING-PROBES-AND-H5-FIXTURE-TEST-SPECIFICATION §3, cases H5-1…H5-6).
 * TEST-ONLY. It measures `ShipmentService.transitionShipment` and fixes nothing: a PASS is a measurement of the tested shape, a FAIL-DEFECT is an observation that needs a
 * separate authorization to change product code. Real: ShipmentService, ProcessEngine, InventoryService, Numbering, Audit, Authorization, and the company database.
 * Test doubles (declared, not hidden): the fulfilment order / sales-order read contracts (fixed answers, no order chain), customers/users/treasury (unused on these paths),
 * and an event bus that RECORDS the topics it is asked to publish (the real outbox is not exercised here). The custody warehouse and vehicle are inserted by SQL
 * (createVehicle would need the full treasury chain; that path is covered by the shipment isolation spec).
 */
describe('T-25 — H5 shipment transitions (measurement, not a fix)', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('measures concurrent / failing / rolled-back shipment transitions without changing product behaviour', async () => {
    try {
      env = await setUpBiz('T-25', 'biz_t25', { tags: ['sales', 'inventory', 'finance', 'procurement', 'accounting', 'logistics'] });
      const e = env;
      const W = e.warehouseId;
      const wide = await widePool(e, 30);
      const inert = {} as never;

      // ---- test doubles ----
      const published: Array<{ topic: string; shipmentId?: string }> = [];
      const events = { publish: async (_m: unknown, topic: string, payload: Record<string, unknown>) => { published.push({ topic, shipmentId: payload.shipmentId as string | undefined }); }, subscribe: () => undefined } as never;
      const foIndex = new Map<string, { id: string; salesOrderId: string; warehouseId: string }>();
      const orderLines = new Map<string, Array<{ id: string; productId: string; unitPrice: string }>>();
      const fulfillment = {
        getFulfillmentOrder: async (id: string) => { const fo = foIndex.get(id); if (!fo) throw new Error(`fixture: unknown fulfilment order ${id}`); return fo; },
        getFulfillmentOrderBySalesOrderId: async () => null,
      } as never;
      const salesOrders = {
        getOrderSnapshot: async (soId: string) => ({ orderNumber: `SO-${soId.slice(0, 6)}`, salesRepUserId: null }),
        getOrderLines: async (soId: string) => orderLines.get(soId) ?? [],
        getOrder: async () => ({}),
      } as never;
      const numbering = new NumberingService(e.h.controlPlane);
      const authorization = new AuthorizationService(e.dsA.getRepository(Role), e.dsA.getRepository(UserRole));
      const treasury = new TreasuryService(e.h.controlPlane, numbering, e.audit, inert, inert);
      const svc = new ShipmentService(e.h.controlPlane, numbering, e.processEngine, authorization, e.audit, events, e.inventory, fulfillment, treasury, salesOrders, inert, inert);

      // ---- actors ----
      const driver = randomUUID();
      const stranger = randomUUID();
      for (const [id, nm] of [[driver, 'Driver'], [stranger, 'Stranger']]) {
        await e.dsA.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3)`, [id, nm, `${nm.toLowerCase()}-${id}@test.local`]);
      }

      // ---- fixture builder ----
      let seq = 0;
      const customerId = randomUUID();
      await e.dsA.query(`INSERT INTO "customers" ("id","code","name","creditLimit","paymentTermsDays") VALUES ($1,'CUST-T25','T25 Customer','100000.00',30)`, [customerId]);
      const build = async (opts: { custody?: 'ok' | 'missing-warehouse'; products?: number } = {}) => {
        seq += 1;
        const salesOrderId = randomUUID();
        await e.dsA.query(`INSERT INTO "sales_orders" ("id","orderNumber","customerId","salesRepUserId","totalAmount","repSequenceNumber","createdByUserId") VALUES ($1,$2,$3,$4,'60.00',$5,$4)`, [salesOrderId, `SO-T25-${seq}`, customerId, e.actor, seq]);
        const lines: Array<{ id: string; productId: string; unitPrice: string }> = [];
        const products: string[] = [];
        for (let i = 0; i < (opts.products ?? 2); i += 1) {
          const p = await seedProduct(e.dsA, `T25-${seq}-${i}`);
          await receive(e, W, p, 50);
          await e.inventory.reserveStock(W, p, 3, salesOrderId, e.actor, 'active', e.manager);
          const lineId = randomUUID();
          await e.dsA.query(`INSERT INTO "sales_order_lines" ("id","salesOrderId","productId","quantity","unitPrice","listPrice","discountAmount","lineTotal") VALUES ($1,$2,$3,3,'10.00','10.00','0.00','30.00')`, [lineId, salesOrderId, p]);
          lines.push({ id: lineId, productId: p, unitPrice: '10.00' });
          products.push(p);
        }
        orderLines.set(salesOrderId, lines);
        const fulfillmentOrderId = randomUUID();
        foIndex.set(fulfillmentOrderId, { id: fulfillmentOrderId, salesOrderId, warehouseId: W });
        const custodyWarehouseId = opts.custody === 'missing-warehouse' ? randomUUID() : await seedWarehouse(e.dsA, `CUST-${seq}`);
        const vehicleId = randomUUID();
        await e.dsA.query(`INSERT INTO "vehicles" ("id","code","plateNumber","warehouseId","status") VALUES ($1,$2,$3,$4,'active')`, [vehicleId, `VH-${seq}`, `PL-${seq}`, custodyWarehouseId]);
        const shipment = await svc.createShipment(fulfillmentOrderId, e.actor, null, null, vehicleId, e.manager);
        await svc.assignDriver(shipment.id, driver, e.actor, e.manager);
        return { shipmentId: shipment.id, salesOrderId, products, custodyWarehouseId };
      };
      const advanceTo = async (id: string, actions: string[]) => { for (const a of actions) await svc.transitionShipment(id, a, driver, e.manager); };
      const observe = async (f: { shipmentId: string; salesOrderId: string; custodyWarehouseId: string }) => {
        const q = (sql: string, p: unknown[]) => e.dsA.query(sql, p);
        return {
          state: await svc.getStatus(f.shipmentId, e.manager),
          trackingEvents: (await q(`SELECT "eventType", count(*)::int AS n FROM tracking_events WHERE "shipmentId" = $1 GROUP BY "eventType" ORDER BY "eventType"`, [f.shipmentId])).map((r: { eventType: string; n: number }) => `${r.eventType}=${r.n}`),
          transitionRecords: Number((await q(`SELECT count(*)::int AS n FROM process_transition_records r JOIN process_instances i ON i.id = r."processInstanceId" WHERE i."entityId" = $1`, [f.shipmentId]))[0].n),
          relocationMovements: Number((await q(`SELECT count(*)::int AS n FROM stock_movements WHERE "referenceId" = $1`, [f.shipmentId]))[0].n),
          activeReservationsAtMain: Number((await q(`SELECT count(*)::int AS n FROM stock_reservations WHERE "salesOrderId" = $1 AND "warehouseId" = $2 AND status = 'active'`, [f.salesOrderId, W]))[0].n),
          activeReservationsAtCustody: Number((await q(`SELECT count(*)::int AS n FROM stock_reservations WHERE "salesOrderId" = $1 AND "warehouseId" = $2 AND status = 'active'`, [f.salesOrderId, f.custodyWarehouseId]))[0].n),
        };
      };
      const detail: Record<string, unknown> = {};

      // ---- H5-1: concurrent identical pickup, plain manager (as controllers pass it) and transaction manager ----
      for (const style of ['plain', 'transaction'] as const) {
        const f = await build();
        const outs = await Promise.all(Array.from({ length: 8 }, () => attempt(() => (style === 'plain'
          ? svc.transitionShipment(f.shipmentId, 'pickup', driver, wide.manager)
          : wide.manager.transaction((tx) => svc.transitionShipment(f.shipmentId, 'pickup', driver, tx))))));
        const obs = await observe(f);
        const ok = outs.filter((o) => o.ok).length;
        detail[`H5-1-${style}`] = { successes: ok, tally: tally(outs), ...obs };
        const good = ok === 1 && obs.state === 'picked_up' && obs.relocationMovements === 2 * 2 /* a transfer writes an out and an in movement per product */ && obs.activeReservationsAtCustody === 2 && obs.activeReservationsAtMain === 0 && obs.trackingEvents.includes('pickup=1');
        result(e, `H5-1-${style}-concurrent-pickup`, good ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail[`H5-1-${style}`]));
      }

      // ---- H5-2: concurrent identical deliver ----
      for (const style of ['plain', 'transaction'] as const) {
        const f = await build();
        await advanceTo(f.shipmentId, ['pickup', 'depart', 'arrive_for_delivery']);
        const before = published.filter((p) => p.topic === 'shipment.delivered' && p.shipmentId === f.shipmentId).length;
        const outs = await Promise.all(Array.from({ length: 8 }, () => attempt(() => (style === 'plain'
          ? svc.transitionShipment(f.shipmentId, 'deliver', driver, wide.manager)
          : wide.manager.transaction((tx) => svc.transitionShipment(f.shipmentId, 'deliver', driver, tx))))));
        const obs = await observe(f);
        const ok = outs.filter((o) => o.ok).length;
        const delivered = published.filter((p) => p.topic === 'shipment.delivered' && p.shipmentId === f.shipmentId).length - before;
        detail[`H5-2-${style}`] = { successes: ok, tally: tally(outs), deliveredEventsPublished: delivered, ...obs };
        result(e, `H5-2-${style}-concurrent-deliver`, ok === 1 && delivered === 1 && obs.state === 'delivered' && obs.trackingEvents.includes('deliver=1') ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail[`H5-2-${style}`]));
      }

      // ---- H5-3: pickup whose custody transfer fails (custody warehouse does not exist) ----
      for (const style of ['plain', 'transaction'] as const) {
        const f = await build({ custody: 'missing-warehouse' });
        const before = await observe(f);
        const out = await attempt(() => (style === 'plain'
          ? svc.transitionShipment(f.shipmentId, 'pickup', driver, wide.manager)
          : wide.manager.transaction((tx) => svc.transitionShipment(f.shipmentId, 'pickup', driver, tx))));
        const after = await observe(f);
        detail[`H5-3-${style}`] = { call: out, before, after };
        const unchanged = !out.ok && after.state === before.state && after.relocationMovements === 0 && after.activeReservationsAtMain === before.activeReservationsAtMain && after.trackingEvents.join() === before.trackingEvents.join() && after.transitionRecords === before.transitionRecords;
        result(e, `H5-3-${style}-pickup-custody-failure-all-or-nothing`, unchanged ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail[`H5-3-${style}`]));
      }

      // ---- H5-4: pickup inside an outer transaction, then rollback ----
      {
        const f = await build();
        const before = await observe(f);
        const pubBefore = published.length;
        const rolled = await attempt(() => wide.manager.transaction(async (tx) => { await svc.transitionShipment(f.shipmentId, 'pickup', driver, tx); throw new Error('outer rollback'); }));
        const after = await observe(f);
        detail['H5-4'] = { outerRolledBack: !rolled.ok && rolled.message === 'outer rollback', before, after, eventsPublishedDuringRolledBackCall: published.length - pubBefore };
        const same = after.state === before.state && after.relocationMovements === 0 && after.activeReservationsAtMain === before.activeReservationsAtMain && after.transitionRecords === before.transitionRecords && after.trackingEvents.join() === before.trackingEvents.join();
        result(e, 'H5-4-outer-rollback-restores-state', same && (detail['H5-4'] as { outerRolledBack: boolean }).outerRolledBack ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['H5-4']));
      }

      // ---- H5-5: legal path end to end, single caller ----
      {
        const f = await build();
        const steps: string[] = [];
        for (const a of ['pickup', 'depart', 'arrive_for_delivery', 'deliver']) steps.push(await svc.transitionShipment(f.shipmentId, a, driver, e.manager));
        const obs = await observe(f);
        detail['H5-5'] = { steps, ...obs };
        const good = steps.join() === 'picked_up,in_transit,out_for_delivery,delivered' && obs.relocationMovements === 4 && obs.activeReservationsAtCustody === 2 && obs.transitionRecords === 5;
        result(e, 'H5-5-legal-path-end-to-end', good ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['H5-5']));
      }

      // ---- H5-6: illegal transition and unauthorized actor ----
      {
        const f = await build();
        const before = await observe(f);
        const illegal = await attempt(() => svc.transitionShipment(f.shipmentId, 'deliver', driver, e.manager)); // assigned -> deliver is not a legal edge
        const unauth = await attempt(() => svc.transitionShipment(f.shipmentId, 'pickup', stranger, e.manager));
        const nonDriverAction = await attempt(() => svc.transitionShipment(f.shipmentId, 'return_to_sender', stranger, e.manager));
        const after = await observe(f);
        detail['H5-6'] = { illegal, unauthorizedDriverAction: unauth, unauthorizedNonDriverAction: nonDriverAction, before, after };
        const good = !illegal.ok && !unauth.ok && unauth.kind.startsWith('ForbiddenException') && !nonDriverAction.ok && nonDriverAction.kind.startsWith('ForbiddenException') && JSON.stringify(before) === JSON.stringify(after);
        result(e, 'H5-6-illegal-and-unauthorized-refused-without-side-effects', good ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['H5-6']));
      }

      record(e, 'T-25-detail.json', detail);
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
