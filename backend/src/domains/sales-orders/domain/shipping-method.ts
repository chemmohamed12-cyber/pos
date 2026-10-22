/**
 * Sales Orders — Shipping Method (CTO directive §2).
 *
 * How this order's goods leave the warehouse: the company's own vehicles,
 * a third-party shipping company, or a direct sale from the company
 * (`direct_sale` — the customer takes the goods over at the company's own
 * counter/warehouse: no driver, vehicle, carrier or custody leg, and the
 * stock/COGS exit and the cash land directly on the company's own
 * warehouse/treasury). Chosen at order creation, shown on the order header.
 * Mirrors `crm/domain/order-workflow-policy.ts`'s pattern for a small
 * fixed-choice field — NOT `Customer.shippingMethodPreference` (a loose
 * free-text CRM import field, the wrong precedent here).
 */
export type ShippingMethod = 'company_vehicles' | 'shipping_company' | 'direct_sale';

export const SHIPPING_METHODS: ShippingMethod[] = ['company_vehicles', 'shipping_company', 'direct_sale'];

export function isValidShippingMethod(value: string): value is ShippingMethod {
  return (SHIPPING_METHODS as string[]).includes(value);
}

export function isDirectSale(value: string | null | undefined): boolean {
  return value === 'direct_sale';
}
