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

/** Display label -> canonical backend state(s). "Partially delivered" is NOT a canonical state (decision D-1): it is a derived filter over the server-computed per-item progress, not part of TABS. */
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

export function filterByTab<T extends WsShipment>(shipments: readonly T[], key: TabKey): T[] {
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
  disabledReason?: 'cash_on_delivery' | 'not_permitted' | 'lines_outstanding';
}

/**
 * The existing supported driver actions per state (same table as the existing Shipments screen): assigned -> pickup, picked_up -> depart, in_transit -> arrive_for_delivery,
 * out_for_delivery -> deliver | fail_delivery. `pickup/depart/arrive` go through `POST /shipments/:id/transition`; `deliver/fail` through `POST /delivery/outcomes`.
 * The server re-validates state, assignment and permission on every call — this only decides what to show.
 * A shipment with cash on delivery keeps its delivery in the existing Shipments screen in Stage B: that screen records the collection together with the delivery, and the
 * workspace has no collection write yet (Stage C), so offering a bare "delivered" here would create a delivered shipment without its collection.
 */
export function availableActions(input: {
  state: string;
  isMine: boolean;
  canActAny: boolean;
  codAmount: string | null;
  /** Stage C: true when at least one collection that still counts exists for this cash-on-delivery shipment (undefined/false = none). */
  codCollected?: boolean;
  /** Stage C / C2: true when per-line delivery events exist and some line is still outstanding. */
  linesOutstanding?: boolean;
}): ActionAvailability[] {
  const permitted = input.isMine || input.canActAny;
  const cod = input.codAmount !== null && Number(input.codAmount) > 0;
  const plan: ActionKey[] =
    input.state === 'assigned' ? ['pickup'] : input.state === 'picked_up' ? ['depart'] : input.state === 'in_transit' ? ['arrive_for_delivery'] : input.state === 'out_for_delivery' ? ['deliver', 'fail_delivery'] : [];
  return plan.map((key) => {
    if (!permitted) return { key, enabled: false, disabledReason: 'not_permitted' as const };
    if (key === 'deliver' && cod && !input.codCollected) return { key, enabled: false, disabledReason: 'cash_on_delivery' as const };
    if (key === 'deliver' && input.linesOutstanding) return { key, enabled: false, disabledReason: 'lines_outstanding' as const };
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
  /** Stage C / C1: recorded (driver) -> confirmed | rejected (someone else). Optional only so older payloads still type-check. */
  verificationStatus?: 'recorded' | 'confirmed' | 'rejected';
  rejectionReason?: string | null;
  collectorUserId?: string;
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

/** Server-computed totals of one shipment's collections (whole-cent arithmetic on the server; the client only displays them). */
export interface WsCollectionTotals {
  expected: string | null;
  recorded: string;
  confirmed: string;
  rejected: string;
  counted: string;
  remaining: string | null;
}

export interface WsLineProgressRow {
  shipmentLineId: string;
  productId: string;
  shipped: number;
  delivered: number;
  returned: number;
  outstanding: number;
}
export interface WsLineProgress {
  status: 'none' | 'in_progress' | 'complete' | 'partial';
  lines: WsLineProgressRow[];
}

export type WsExpenseStatus = 'pending_approval' | 'approved' | 'rejected' | 'posted' | 'cancelled' | 'reversed';
export interface WsExpense {
  id: string;
  expenseNumber: string;
  category: string;
  amount: string;
  reason: string;
  incurredOn: string;
  status: WsExpenseStatus;
  claimedByUserId: string;
  decisionNote: string | null;
}

export interface WsHandover {
  id: string;
  handoverNumber: string;
  amount: string;
  status: 'declared' | 'confirmed' | 'rejected';
  createdAt: string;
}

/** Mirror of the server's `CustodyReconciliation` - displayed as received, never recomputed here. */
export interface WsReconciliation {
  collections: { recorded: string; confirmed: string; rejected: string; counted: string; remitted: string; notYetRemitted: string };
  expenses: { pendingApproval: string; approvedNotPosted: string; posted: string; rejectedOrCancelled: string };
  /** The separate expense float (policy 2026-10-26): about the float account only - expenses never touch collections. */
  float: { assigned: boolean; balance: string | null; expectedBalance: string | null; difference: string | null; pendingApproval: string; approvedNotPosted: string; posted: string; reversed: string; availableAfterCommitments: string | null };
  handovers: { declared: string; confirmed: string; rejected: string; handedOver: string };
  derived: { cashInDriverHand: string; cashInDriverHandFormula: string; expectedCustodyAccountBalance: string; expectedCustodyAccountFormula: string; ledgerDifference: string | null };
}

/** May another instalment be recorded? Only while the server-computed remaining amount is positive; with no expected amount the legacy single-collection rule applies. */
export function canRecordCollection(expectedCod: string | null, totals: WsCollectionTotals | null | undefined): boolean {
  if (!totals) return false;
  if (expectedCod === null || Number(expectedCod) <= 0) return Number(totals.counted) === 0;
  return totals.remaining !== null && Number(totals.remaining) > 0;
}

/** Which actions the verification step offers for one collection (the server re-checks maker != checker and the permission). */
export function collectionDecisionOptions(c: WsCollection, canDecide: boolean, isCollector: boolean): Array<'confirm' | 'reject'> {
  if (!canDecide || isCollector) return [];
  return (c.verificationStatus ?? 'recorded') === 'recorded' && c.remittanceStatus !== 'remitted' ? ['confirm', 'reject'] : [];
}

export function expenseNeedsApproval(e: WsExpense): boolean {
  return e.status === 'pending_approval';
}
/** Can this posted expense be reversed (finance, with a reason)? */
export function expenseCanBeReversed(e: WsExpense): boolean {
  return e.status === 'posted';
}

/** The float can fund a new claim only while the server-reported amount available after pending commitments is positive; unknown = not available. */
export function floatHasRoom(float: { assigned: boolean; availableAfterCommitments: string | null } | null | undefined, amount: string): boolean | null {
  if (!float || !float.assigned || float.availableAfterCommitments === null) return null;
  return Math.round(Number(amount) * 100) <= Math.round(Number(float.availableAfterCommitments) * 100);
}

export function expenseReadyToPost(e: WsExpense): boolean {
  return e.status === 'approved';
}

/** Expenses of the whole workspace that still wait for a person: the number on the "Expenses" badge. */
export function openExpenseCount(expenses: readonly WsExpense[]): number {
  return expenses.filter((e) => e.status === 'pending_approval' || e.status === 'approved').length;
}

/** A retry-safe idempotency key for one submit (generated once per form open; the same key is re-sent on a network retry). */
export function newClientKey(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.slice(0, 40).padEnd(8, '0');
}
