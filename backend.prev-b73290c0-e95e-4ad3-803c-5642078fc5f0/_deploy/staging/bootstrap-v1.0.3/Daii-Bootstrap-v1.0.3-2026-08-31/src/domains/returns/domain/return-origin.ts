/**
 * Returns Engine Phase B (CTO directive — "شحنات الشركة/السيارة") — WHERE
 * the returned goods physically come from. `customer` is Phase A's
 * original path (goods already delivered, or at least invoiced to the
 * customer). The other two are pre-delivery custody reversals — the goods
 * never left company ownership and never reached the customer, so unlike a
 * `customer` return they never carry a `returnType`/`ReturnCredit`
 * (directive's explicit "no automatic Customer Credit — the customer never
 * received the goods").
 */
export type ReturnOrigin = 'customer' | 'shipping_company_custody' | 'vehicle_custody';

export const RETURN_ORIGINS: ReturnOrigin[] = ['customer', 'shipping_company_custody', 'vehicle_custody'];
