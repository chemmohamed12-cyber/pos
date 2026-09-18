/**
 * Returns Engine (CTO directive) — which of the three customer-return
 * paths this request is. Mirrors `sales-orders/domain/shipping-method.ts`'s
 * fixed-choice pattern.
 *
 * - `exchange` — استبدال. The returned unit goes to Inspection then its
 *   disposition; a replacement is issued from Finished Goods separately.
 *   No `ReturnCredit` is created for a same-value exchange.
 * - `value_credit` — مرتجع بقيمة. Creates a `ReturnCredit` for the
 *   returned line's own historical price, usable on a future order.
 * - `product_return` — Customer Product Return. Same physical/ledger path
 *   as `value_credit` (returned to stock, credit created) — kept as its
 *   own directive-named type rather than merged into `value_credit` so
 *   reporting/UI can distinguish "customer wants a refund" from "customer
 *   is just returning a product," even though the mechanics are identical.
 */
export type ReturnType = 'exchange' | 'value_credit' | 'product_return';

export const RETURN_TYPES: ReturnType[] = ['exchange', 'value_credit', 'product_return'];

export function isValidReturnType(value: string): value is ReturnType {
  return (RETURN_TYPES as string[]).includes(value);
}

/** Which return types create a `ReturnCredit` on disposition — never `exchange` unless a price difference is handled (out of Phase A scope, disclosed). */
export const CREDIT_BEARING_RETURN_TYPES: ReturnType[] = ['value_credit', 'product_return'];
