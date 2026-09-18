/**
 * External Integrations — CTO directive §17: "Daii should be able to
 * publish relevant operational status back to QR... Do not expose
 * internal Daii implementation details. QR receives a clean
 * customer-facing order status contract." This vocabulary is deliberately
 * NOT Daii's internal Process Engine state names (`draft`,
 * `supervisor_review`, `deposit_verification`, ...) — see
 * `mapInternalStateToCustomerFacingStatus` in `integrations.service.ts`
 * for the translation.
 */
export type CustomerFacingOrderStatus =
  | 'received'
  | 'accepted'
  | 'rejected'
  | 'processing'
  | 'preparing'
  | 'ready'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'returned';
