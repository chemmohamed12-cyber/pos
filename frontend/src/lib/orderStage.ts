/**
 * Where a RELEASED sales order is after approval, read from records the system already keeps (no second status invented): no fulfilment order yet -> waiting for
 * preparation; a fulfilment order -> in preparation, or prepared once its pack task is closed; a shipment -> in shipping (or delivered). Pure so the screens that show
 * it (Sales cover, order detail, shipping) cannot drift apart.
 */
export type OrderStage = 'awaiting_preparation' | 'in_preparation' | 'ready_for_shipping' | 'in_shipping' | 'delivered';

export interface OrderStageFacts {
  hasFulfillmentOrder: boolean;
  packClosed: boolean;
  shipmentState: string | null;
}

export function orderStage(f: OrderStageFacts): OrderStage {
  if (f.shipmentState) return f.shipmentState === 'delivered' ? 'delivered' : 'in_shipping';
  if (!f.hasFulfillmentOrder) return 'awaiting_preparation';
  return f.packClosed ? 'ready_for_shipping' : 'in_preparation';
}

/** A shipment that still needs a route (no company / vehicle) and is not a direct sale = a NEW shipping order, the same rule the Shipments screen uses. */
export function isNewShippingOrder(s: { state: string; shippingCompanyId: string | null; vehicleId: string | null; shippingMethod?: string | null }): boolean {
  return !s.shippingCompanyId && !s.vehicleId && s.shippingMethod !== 'direct_sale' && (s.state === 'created' || s.state === 'assigned');
}

/** Orders whose approval is finished and that were sent to preparation; everything earlier in the approval chain is incomplete. */
export const COMPLETED_ORDER_STATES = ['released'];
