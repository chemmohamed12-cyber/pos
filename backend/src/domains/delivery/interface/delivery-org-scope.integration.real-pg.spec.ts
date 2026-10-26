import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DeliveryController } from './delivery.controller';
import { DeliveryOrgScopeService } from '../application/delivery-org-scope.service';
import { OrganizationService } from '../../../foundation/organization/organization.service';
import { AccessScope, AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { OrgContextService } from '../../../foundation/scope/org-context.service';
import { CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Integration of the vehicle-workspace routes with the org-structure engine (CTO 2026-10-26): EVERY route that addresses a shipment (by shipmentId), a collection, an expense, a handover or a
 * vehicle keeps the branch scope - a record of a branch outside the caller's scope answers 404 and the underlying service is NEVER called; an in-scope record and a legacy (unlinked) record
 * pass through to the service (whose own driver-assignment / ownership / permission rules are covered by the delivery specs); a missing record is left to the service's own 404. Real PostgreSQL,
 * real branch data; the controller's collaborators are call-recording fakes so that "the service was not reached" is observable.
 */
describe('Delivery routes keep the org branch scope (shipmentId / collection / expense / handover / vehicle) — real-Postgres', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let dsA: DataSource;
  let scope: AccessScope;
  const userId = randomUUID();
  const ids: Record<string, string> = {};
  const calls: string[] = [];
  const rec = (name: string) => async () => {
    calls.push(name);
    return { ok: name };
  };
  const fake = (names: string[]) => Object.fromEntries(names.map((n) => [n, rec(n)]));
  let controller: DeliveryController;

  const req = () => ({ user: { id: userId, email: 'x@test.local', companyId: 'c' }, companyContext: { companyId: 'c', dataSource: dsA } }) as unknown as CompanyScopedRequest;
  const unrestricted = (): AccessScope => ({ userId, unrestricted: true, unitIds: new Set<string>() });
  const restrictedTo = (...units: string[]): AccessScope => ({ userId, unrestricted: false, unitIds: new Set(units) });
  const q = (sql: string, p: unknown[] = []) => dsA.query(sql, p);

  // one record per branch for each addressable kind: cairo / tanta / legacy (no org link)
  const rows: Record<'cairo' | 'tanta' | 'legacy', { shipment: string; collection: string; expense: string; handover: string; vehicle: string }> = {
    cairo: { shipment: '', collection: '', expense: '', handover: '', vehicle: '' },
    tanta: { shipment: '', collection: '', expense: '', handover: '', vehicle: '' },
    legacy: { shipment: '', collection: '', expense: '', handover: '', vehicle: '' },
  };

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'dlv_scope', extraCompanyTags: ['sales', 'inventory', 'finance', 'logistics'] });
    dsA = await h.connections.getDataSource(h.companyAId);
    const org = new OrganizationService(dsA);
    ids.root = (await org.createUnit('company', 'Mother')).id;
    ids.cairo = (await org.createUnit('branch', 'Cairo', ids.root)).id;
    ids.tanta = (await org.createUnit('branch', 'Tanta', ids.root)).id;
    await q(`INSERT INTO users (id,"fullName",email) VALUES ($1,'scope user',$2)`, [userId, `scope-${userId.slice(0, 6)}@t.local`]);
    for (const key of ['cairo', 'tanta', 'legacy'] as const) {
      const unit = key === 'legacy' ? null : ids[key];
      const v = randomUUID();
      const s = randomUUID();
      const c = randomUUID();
      const e = randomUUID();
      const hd = randomUUID();
      await q(`INSERT INTO vehicles (id,code,"plateNumber","orgUnitId",status) VALUES ($1,$2,$2,$3,'active')`, [v, `V-${key}`, unit]);
      await q(`INSERT INTO shipments (id,"fulfillmentOrderId","waybillNumber","vehicleId","branchOrgUnitId") VALUES ($1,$2,$3,$4,$5)`, [s, randomUUID(), `WB-${key}`, v, unit]);
      await q(`INSERT INTO collections (id,"shipmentId",amount,method,"collectorUserId") VALUES ($1,$2,'10.00','cash',$3)`, [c, s, userId]);
      await q(`INSERT INTO custody_expenses (id,"expenseNumber","custodyId","shipmentId","vehicleId","floatAccountId",category,amount,reason,"incurredOn","claimedByUserId") VALUES ($1,$2,$3,$4,$5,$6,'custody_fuel','5.00','test','2026-10-26',$7)`, [e, `CEX-${key}`, randomUUID(), s, v, randomUUID(), userId]);
      await q(`INSERT INTO custody_handovers (id,"handoverNumber","vehicleId","driverUserId",amount) VALUES ($1,$2,$3,$4,'1.00')`, [hd, `CHO-${key}`, v, userId]);
      rows[key] = { shipment: s, collection: c, expense: e, handover: hd, vehicle: v };
    }
    const inert = {} as never;
    const scopes = new AccessScopeService(inert, inert);
    jest.spyOn(scopes, 'forRequest').mockImplementation(async () => scope);
    controller = new DeliveryController(
      fake(['recordOutcome', 'recordCollection', 'getOutcomeForShipment', 'listCollectionsForShipment', 'getCollectionForShipment', 'getCollectionForShipmentUnscoped', 'confirmCollection', 'rejectCollection', 'remitCollection']) as never,
      fake(['record', 'getProgress']) as never,
      fake(['claim', 'listForShipment', 'decide', 'post', 'reverse', 'cancel', 'listCategories']) as never,
      fake(['declare', 'decide', 'getReconciliation']) as never,
      new DeliveryOrgScopeService(new OrgContextService(scopes)),
    );
  });
  afterAll(async () => h.teardown());
  beforeEach(() => {
    calls.length = 0;
  });

  type Kind = 'shipment' | 'collection' | 'expense' | 'handover' | 'vehicle';
  const routes: Array<{ name: string; kind: Kind; mock: string; call: (id: string) => Promise<unknown> }> = [
    { name: 'POST outcomes', kind: 'shipment', mock: 'recordOutcome', call: (id) => controller.recordOutcome(req(), { shipmentId: id, outcome: 'delivered' } as never) },
    { name: 'POST collections', kind: 'shipment', mock: 'recordCollection', call: (id) => controller.recordCollection(req(), { shipmentId: id, amount: '1.00', method: 'cash' } as never) },
    { name: 'POST line-events', kind: 'shipment', mock: 'record', call: (id) => controller.recordLineEvent(req(), { shipmentId: id, shipmentLineId: randomUUID(), kind: 'delivered', quantity: 1 } as never) },
    { name: 'GET line-events', kind: 'shipment', mock: 'getProgress', call: (id) => controller.lineEvents(req(), id) },
    { name: 'POST custody-expenses', kind: 'shipment', mock: 'claim', call: (id) => controller.claimExpense(req(), { shipmentId: id, category: 'custody_fuel', amount: '1.00', reason: 'x' } as never) },
    { name: 'GET custody-expenses', kind: 'shipment', mock: 'listForShipment', call: (id) => controller.listExpenses(req(), id) },
    { name: 'GET outcomes', kind: 'shipment', mock: 'getOutcomeForShipment', call: (id) => controller.getOutcome(req(), id) },
    { name: 'GET collections/all', kind: 'shipment', mock: 'listCollectionsForShipment', call: (id) => controller.listCollections(req(), id) },
    { name: 'GET collections', kind: 'shipment', mock: 'getCollectionForShipment', call: (id) => controller.getCollection(req(), id) },
    { name: 'GET collections/by-shipment/:id', kind: 'shipment', mock: 'getCollectionForShipmentUnscoped', call: (id) => controller.getCollectionForShipmentAsFinance(req(), id) },
    { name: 'POST collections/:id/confirm', kind: 'collection', mock: 'confirmCollection', call: (id) => controller.confirmCollection(req(), id) },
    { name: 'POST collections/:id/reject', kind: 'collection', mock: 'rejectCollection', call: (id) => controller.rejectCollection(req(), id, { reason: 'short count' } as never) },
    { name: 'POST collections/:id/remit', kind: 'collection', mock: 'remitCollection', call: (id) => controller.remitCollection(req(), id, {} as never) },
    { name: 'POST custody-expenses/:id/decide', kind: 'expense', mock: 'decide', call: (id) => controller.decideExpense(req(), id, { decision: 'approved' } as never) },
    { name: 'POST custody-expenses/:id/post', kind: 'expense', mock: 'post', call: (id) => controller.postExpense(req(), id) },
    { name: 'POST custody-expenses/:id/reverse', kind: 'expense', mock: 'reverse', call: (id) => controller.reverseExpense(req(), id, { reason: 'wrong' } as never) },
    { name: 'POST custody-expenses/:id/cancel', kind: 'expense', mock: 'cancel', call: (id) => controller.cancelExpense(req(), id, { reason: 'oops' } as never) },
    { name: 'POST custody-handovers/:id/decide', kind: 'handover', mock: 'decide', call: (id) => controller.decideHandover(req(), id, { decision: 'confirmed' } as never) },
    { name: 'POST custody-handovers (vehicleId)', kind: 'vehicle', mock: 'declare', call: (id) => controller.declareHandover(req(), { vehicleId: id, amount: '1.00' } as never) },
    { name: 'GET custody-reconciliation/:vehicleId', kind: 'vehicle', mock: 'getReconciliation', call: (id) => controller.reconciliation(req(), id) },
  ];

  it('S1 a caller scoped to Cairo: every route reaches the service for a Cairo record and for a legacy (unlinked) record', async () => {
    scope = restrictedTo(ids.cairo);
    for (const r of routes) {
      for (const which of ['cairo', 'legacy'] as const) {
        calls.length = 0;
        await r.call(rows[which][r.kind]);
        expect({ route: r.name, which, reached: calls }).toEqual({ route: r.name, which, reached: [r.mock] });
      }
    }
  });

  it('S2 the same caller: every route answers 404 for a Tanta record and the service is NEVER reached', async () => {
    scope = restrictedTo(ids.cairo);
    for (const r of routes) {
      calls.length = 0;
      await expect(r.call(rows.tanta[r.kind])).rejects.toThrow(NotFoundException);
      expect({ route: r.name, reached: calls }).toEqual({ route: r.name, reached: [] });
    }
  });

  it('S3 an unrestricted caller reaches the service for every branch; a caller with no branch at all reaches only legacy records', async () => {
    scope = unrestricted();
    for (const r of routes) {
      for (const which of ['cairo', 'tanta', 'legacy'] as const) {
        calls.length = 0;
        await r.call(rows[which][r.kind]);
        expect(calls).toEqual([r.mock]);
      }
    }
    scope = restrictedTo();
    for (const r of routes) {
      calls.length = 0;
      await expect(r.call(rows.cairo[r.kind])).rejects.toThrow(NotFoundException);
      expect(calls).toEqual([]);
      await r.call(rows.legacy[r.kind]);
      expect(calls).toEqual([r.mock]);
    }
  });

  it('S4 a record that does not exist is not decided by the scope check (the service raises its own 404): existence is not revealed by a different answer', async () => {
    scope = restrictedTo(ids.cairo);
    for (const r of routes) {
      calls.length = 0;
      await r.call(randomUUID());
      expect(calls).toEqual([r.mock]);
    }
  });

  it('S5 the list of routes is complete: every route of the controller that takes a shipment, collection, expense, handover or vehicle id is in the table', () => {
    const proto = Object.getOwnPropertyNames(DeliveryController.prototype).filter((n) => n !== 'constructor');
    const covered = new Set(['recordOutcome', 'recordCollection', 'recordLineEvent', 'lineEvents', 'claimExpense', 'listExpenses', 'getOutcome', 'listCollections', 'getCollection', 'getCollectionForShipmentAsFinance', 'confirmCollection', 'rejectCollection', 'remitCollection', 'decideExpense', 'postExpense', 'reverseExpense', 'cancelExpense', 'decideHandover', 'declareHandover', 'reconciliation']);
    // routes that address no single record: the category list (no data), the company-wide pending-remittance queue (filtering a list by branch is the org engine's list rule - see the report)
    const notRecordScoped = new Set(['expenseCategories', 'listPendingRemittances']);
    expect(proto.filter((n) => !covered.has(n) && !notRecordScoped.has(n))).toEqual([]);
  });
});
