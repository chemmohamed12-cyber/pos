import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS, availableActions, collectionOf, currentTrip, custodyRowStatus, filterByTab, isOpen, tabCounts, tripSummary, unknownStateCount, vehicleAvailability } from '../src/pages/vehicle-workspace/workspaceModel';
import type { WsCollection, WsShipment } from '../src/pages/vehicle-workspace/workspaceModel';

const mk = (id: string, state: string, extra: Partial<WsShipment> = {}): WsShipment => ({
  id, waybillNumber: `WB-${id}`, rshNumber: null, salesOrderNumber: null, state, customerName: 'C', governorate: null, totalAmount: null, codAmount: null,
  driverUserId: 'u1', vehicleId: 'v1', createdAt: `2026-10-2${id.length}T00:00:00Z`, ...extra,
});
const col = (shipmentId: string, status: 'pending' | 'remitted'): WsCollection => ({ id: `c-${shipmentId}`, shipmentId, amount: '10.00', method: 'cash', remittanceStatus: status, remittedAt: null, custodyAccountId: 'a', occurredAt: '2026-10-22T00:00:00Z' });

const ALL = [mk('1', 'created'), mk('2', 'assigned'), mk('3', 'picked_up'), mk('4', 'in_transit'), mk('5', 'out_for_delivery'), mk('6', 'delivered'), mk('7', 'failed'), mk('8', 'returned')];

test('every tab maps to canonical states and the counts add up; there is no partial-delivery tab', () => {
  const counts = tabCounts(ALL);
  assert.equal(counts.all, 8);
  assert.equal(counts.new + counts.ready + counts.received + counts.on_the_way + counts.delivered + counts.failed + counts.returned, 8);
  assert.equal(counts.on_the_way, 2);
  assert.ok(!TABS.some((t) => /partial|جزئي/i.test(t.key + t.en + t.ar)));
});

test('filterByTab returns exactly the matching states', () => {
  assert.deepEqual(filterByTab(ALL, 'on_the_way').map((s) => s.state), ['in_transit', 'out_for_delivery']);
  assert.equal(filterByTab(ALL, 'all').length, 8);
});

test('failed is still open (retry), delivered and returned are terminal', () => {
  assert.equal(isOpen('failed'), true);
  assert.equal(isOpen('delivered'), false);
  assert.equal(isOpen('returned'), false);
});

test('an unknown state stays visible in All and is counted as drift, never dropped', () => {
  const odd = [...ALL, mk('9', 'weird_state')];
  assert.equal(tabCounts(odd).all, 9);
  assert.equal(unknownStateCount(odd), 1);
});

test('actions follow the existing machine; cash-on-delivery delivery and a non-assigned driver are disabled WITH a reason', () => {
  assert.deepEqual(availableActions({ state: 'assigned', isMine: true, canActAny: false, codAmount: null }), [{ key: 'pickup', enabled: true }]);
  assert.deepEqual(availableActions({ state: 'picked_up', isMine: true, canActAny: false, codAmount: null }).map((a) => a.key), ['depart']);
  assert.deepEqual(availableActions({ state: 'in_transit', isMine: true, canActAny: false, codAmount: null }).map((a) => a.key), ['arrive_for_delivery']);
  const out = availableActions({ state: 'out_for_delivery', isMine: true, canActAny: false, codAmount: '500.00' });
  assert.deepEqual(out, [{ key: 'deliver', enabled: false, disabledReason: 'cash_on_delivery' }, { key: 'fail_delivery', enabled: true }]);
  assert.equal(availableActions({ state: 'out_for_delivery', isMine: true, canActAny: false, codAmount: '0' })[0].enabled, true);
  assert.deepEqual(availableActions({ state: 'assigned', isMine: false, canActAny: false, codAmount: null }), [{ key: 'pickup', enabled: false, disabledReason: 'not_permitted' }]);
  assert.equal(availableActions({ state: 'assigned', isMine: false, canActAny: true, codAmount: null })[0].enabled, true);
  for (const s of ['created', 'delivered', 'failed', 'returned']) assert.deepEqual(availableActions({ state: s, isMine: true, canActAny: true, codAmount: null }), []);
});

test('custody row status comes only from the existing collection record', () => {
  assert.equal(custodyRowStatus(null), 'no_collection');
  assert.equal(custodyRowStatus(col('1', 'pending')), 'recorded_pending_remittance');
  assert.equal(custodyRowStatus(col('1', 'remitted')), 'remitted');
});

test('trip summary: counts are exact; unreadable collections are null (not zero)', () => {
  const withCod = [mk('1', 'delivered', { codAmount: '100.00' }), mk('2', 'delivered', { codAmount: '0' }), mk('3', 'out_for_delivery', { codAmount: '50.00' }), mk('4', 'failed'), mk('5', 'returned')];
  const none = tripSummary(withCod, null);
  assert.equal(none.assigned, 5);
  assert.equal(none.open, 2);
  assert.equal(none.delivered, 2);
  assert.equal(none.failed, 1);
  assert.equal(none.returned, 1);
  assert.equal(none.cashOnDelivery, 2);
  assert.equal(none.collectionsRecorded, null);
  assert.equal(none.collectionsPendingRemittance, null);
  const known = tripSummary(withCod, new Map([['1', col('1', 'remitted')], ['3', null], ['2', null]]));
  assert.equal(known.collectionsRecorded, 1);
  assert.equal(known.collectionsRemitted, 1);
  assert.equal(known.collectionsPendingRemittance, 0);
});

test('current trip = open shipments, oldest first; availability is null when the vehicle has no stock row', () => {
  const trip = currentTrip([mk('22', 'assigned'), mk('1', 'delivered'), mk('3', 'picked_up')]);
  assert.deepEqual(trip.map((s) => s.id), ['3', '22']);
  assert.equal(vehicleAvailability(null, 'p1'), null);
  assert.equal(vehicleAvailability([{ productId: 'p2', onHand: 1, reserved: 0, available: 1 }], 'p1'), null);
  assert.equal(vehicleAvailability([{ productId: 'p1', onHand: 4, reserved: 1, available: 3 }], 'p1')?.available, 3);
});

test('collectionOf distinguishes "not visible" (undefined) from "visible, none recorded" (null) and a record', () => {
  const m = new Map<string, WsCollection | null>([['a', col('a', 'pending')], ['b', null]]);
  assert.equal(collectionOf(m, 'a')?.remittanceStatus, 'pending');
  assert.equal(collectionOf(m, 'b'), null);
  assert.equal(collectionOf(m, 'hidden'), undefined);
  assert.equal(collectionOf(null, 'a'), undefined);
});
