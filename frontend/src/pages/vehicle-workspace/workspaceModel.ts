/**
 * Vehicle Driver Workspace — Stage B read model (2026-10-22). PURE functions only (no React, no network): they classify and count what the existing read APIs returned.
 * Nothing here computes money. Amounts are passed through exactly as the backend returned them; a figure the backend did not return is `null` ("not available"), never 0.
 */

/** The canonical shipment states of `SHIPMENT_PROCESS` (backend `shipment-process.ts`). The UI never invents another state. */
export type ShipmentState = 'created' | 'assigned' | 'picked_up' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'failed' | 'returned';

export const SHIPMENT_STATES: readonly ShipmentState[] = ['created', 'assigned', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned'];

export interface WsShipment {
  id: string;
  waybillNumber: string;
  rshNumber: string | null;
  salesOrderNumber: string | null;
  state: string;
  customerName: string | null;
  governorate: string | null;
  totalAmount: string | null;
  codAmount: string | null;
  driverUserId: string | null;
  vehicleId: string | null;
  createdAt: string;
}

export type TabKey = 'all' | 'new' | 'ready' | 'received' | 'on_the_way' | 'delivered' | 'failed' | 'returned';

export interface TabDef {
  key: TabKey;
  /** null = every shipment of the vehicle. */
  states: readonly ShipmentState[] | null;
  ar: string;
  en: string;
}

/** Display label -> canonical backend state(s). "Partially delivered" has NO canonical state or data source (decision D-1), so it is deliberately not a tab with a count. */
export const TABS: readonly TabDef[] = [
  { key: 'all', states: null, ar: 'الكل', en: 'All' },
  { key: 'new', states: ['created'], ar: 'جديدة', en: 'New' },
  { key: 'ready', states: ['assigned'], ar: 'جاهزة للاستلام', en: 'Ready for pickup' },
  { key: 'received', states: ['picked_up'], ar: 'تم الاستلام', en: 'Picked up' },
  { key: 'on_the_way', states: ['in_transit', 'out_for_delivery'], ar: 'في الطريق', en: 'On the way' },
  { key: 'delivered', states: ['delivered'], ar: 'تم التسليم', en: 'Delivered' },
  { key: 'failed', states: ['failed'], ar: 'تعذر التسليم', en: 'Delivery failed' },
  { key: 'returned', states: ['returned'], ar: 'مرتجعات', en: 'Returned' },
];

const KNOWN = new Set<string>(SHIPMENT_STATES);

export function isKnownState(state: string): state is ShipmentState {
  return KNOWN.has(state);
}

/** Terminal in the shipment machine: nothing is left to do for the driver. `failed` is NOT terminal (it can be retried). */
export function isOpen(state: string): boolean {
  return state !== 'delivered' && state !== 'returned';
}

export function filterByTab(shipments: readonly WsShipment[], key: TabKey): WsShipment[] {
  const tab = TABS.find((t) => t.key === key);
  if (!tab || tab.states === null) return [...shipments];
  const states = tab.states as readonly string[];
  return shipments.filter((s) => states.includes(s.state));
}

export function tabCounts(shipments: readonly WsShipment[]): Record<TabKey, number> {
  const out = {} as Record<TabKey, number>;
  for (const t of TABS) out[t.key] = filterByTab(shipments, t.key).length;
  return out;
}

/** Shipments whose state is not one of the eight canonical states (data drift): surfaced to the user, never silently dropped from "All". */
export function unknownStateCount(shipments: readonly WsShipment[]): number {
  return shipments.filter((s) => !isKnownState(s.state)).length;
}

export type ActionKey = 'pickup' | 'depart' | 'arrive_for_delivery' | 'deliver' | 'fail_delivery';

export interface ActionAvailability {
  key: ActionKey;
  enabled: boolean;
  /** Why a shown action is disabled (never hide an action the state allows without saying why). */
  disabledReason?: 'cash_on_delivery' | 'not_permitted';
}

/**
 * The existing supported driver actions per state (same table as the existing Shipments screen): assigned -> pickup, picked_up -> depart, in_transit -> arrive_for_delivery,
 * out_for_delivery -> deliver | fail_delivery. `pickup/depart/arrive` go through `POST /shipments/:id/transition`; `deliver/fail` through `POST /delivery/outcomes`.
 * The server re-validates state, assignment and permission on every call — this only decides what to show.
 * A shipment with cash on delivery keeps its delivery in the existing Shipments screen in Stage B: that screen records the collection together with the delivery, and the
 * workspace has no collection write yet (Stage C), so offering a bare "delivered" here would create a delivered shipment without its collection.
 */
export function availableActions(input: { state: string; isMine: boolean; canActAny: boolean; codAmount: string | null }): ActionAvailability[] {
  const permitted = input.isMine || input.canActAny;
  const cod = input.codAmount !== null && Number(input.codAmount) > 0;
  const plan: ActionKey[] =
    input.state === 'assigned' ? ['pickup'] : input.state === 'picked_up' ? ['depart'] : input.state === 'in_transit' ? ['arrive_for_delivery'] : input.state === 'out_for_delivery' ? ['deliver', 'fail_delivery'] : [];
  return plan.map((key) => {
    if (!permitted) return { key, enabled: false, disabledReason: 'not_permitted' as const };
    if (key === 'deliver' && cod) return { key, enabled: false, disabledReason: 'cash_on_delivery' as const };
    return { key, enabled: true };
  });
}

/** The shape of an existing `collections` row (`GET /delivery/collections?shipmentId=`). */
export interface WsCollection {
  id: string;
  shipmentId: string;
  amount: string;
  method: string;
  remittanceStatus: 'pending' | 'remitted';
  remittedAt: string | null;
  custodyAccountId: string | null;
  occurredAt: string;
}

export type CustodyRowStatus = 'no_collection' | 'recorded_pending_remittance' | 'remitted';

/** Factual status of one shipment's cash from the existing collection record only (no balance arithmetic). */
export function custodyRowStatus(collection: WsCollection | null): CustodyRowStatus {
  if (!collection) return 'no_collection';
  return collection.remittanceStatus === 'remitted' ? 'remitted' : 'recorded_pending_remittance';
}

export function isCashOnDelivery(s: WsShipment): boolean {
  return s.codAmount !== null && Number(s.codAmount) > 0;
}

export interface TripSummary {
  assigned: number;
  open: number;
  delivered: number;
  failed: number;
  returned: number;
  /** Shipments of this vehicle with a cash-on-delivery amount. */
  cashOnDelivery: number;
  /** null = the collection records could not be read (permission or error): "not available", never 0. */
  collectionsRecorded: number | null;
  collectionsPendingRemittance: number | null;
  collectionsRemitted: number | null;
}

export function tripSummary(shipments: readonly WsShipment[], collections: ReadonlyMap<string, WsCollection | null> | null): TripSummary {
  const count = (state: string) => shipments.filter((s) => s.state === state).length;
  let recorded: number | null = null;
  let pending: number | null = null;
  let remitted: number | null = null;
  if (collections) {
    const rows = [...collections.values()].filter((c): c is WsCollection => c !== null);
    recorded = rows.length;
    pending = rows.filter((c) => c.remittanceStatus === 'pending').length;
    remitted = rows.filter((c) => c.remittanceStatus === 'remitted').length;
  }
  return {
    assigned: shipments.length,
    open: shipments.filter((s) => isOpen(s.state)).length,
    delivered: count('delivered'),
    failed: count('failed'),
    returned: count('returned'),
    cashOnDelivery: shipments.filter(isCashOnDelivery).length,
    collectionsRecorded: recorded,
    collectionsPendingRemittance: pending,
    collectionsRemitted: remitted,
  };
}

/** "Current trip" is derived, not stored: the vehicle's open shipments, oldest first (the next one to work on). */
export function currentTrip(shipments: readonly WsShipment[]): WsShipment[] {
  return shipments.filter((s) => isOpen(s.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** One stock row of `GET /shipments/vehicles/:id/overview`. */
export interface StockRow {
  productId: string;
  onHand: number;
  reserved: number;
  available: number;
}

/** Quantity currently available in the vehicle for a shipment line: the vehicle's own stock row, or null when the vehicle has no stock row for that product (not "0"). */
export function vehicleAvailability(stock: readonly StockRow[] | null, productId: string): StockRow | null {
  if (!stock) return null;
  return stock.find((r) => r.productId === productId) ?? null;
}

/**
 * The collection of one shipment from the server's batched, permission-checked read: `undefined` = this user may not see it ("not available" - never shown as none or zero),
 * `null` = visible and none recorded, otherwise the record.
 */
export function collectionOf(map: ReadonlyMap<string, WsCollection | null> | null, shipmentId: string): WsCollection | null | undefined {
  if (!map || !map.has(shipmentId)) return undefined;
  return map.get(shipmentId) ?? null;
}
