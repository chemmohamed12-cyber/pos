/**
 * Sales Orders — Shipping Method (CTO directive §2).
 *
 * How this order's goods leave the warehouse: the company's own vehicles,
 * or a third-party shipping company. Chosen at order creation, shown on the
 * order header. Mirrors `crm/domain/order-workflow-policy.ts`'s pattern for
 * a small fixed-choice field — NOT `Customer.shippingMethodPreference`
 * (a loose free-text CRM import field, the wrong precedent here).
 */
export type ShippingMethod = 'company_vehicles' | 'shipping_company';

export const SHIPPING_METHODS: ShippingMethod[] = ['company_vehicles', 'shipping_company'];

export function isValidShippingMethod(value: string): value is ShippingMethod {
  return (SHIPPING_METHODS as string[]).includes(value);
}
