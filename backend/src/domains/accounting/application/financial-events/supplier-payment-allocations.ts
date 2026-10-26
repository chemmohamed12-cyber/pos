/**
 * Org engine WP-A (decision D-A, option B) — how a supplier payment (and its mirror) is split across organization units.
 *
 * Payload contract, `payloadVersion` 2 of `finance.supplier_payment.recorded` / `.reversed`:
 *   allocations: [{ invoiceId, amount, orgUnitId|null }]  — what each settled invoice carries (its branch, stamped when the payment was recorded);
 *   bankOrgUnitId: string|null                           — the paying treasury account's branch (stamped at the same time).
 * The Accounts-payable side becomes one line per distinct unit (so branch AP balances relieve in their own branch), the bank side stays ONE line on the account's unit.
 * A payload WITHOUT `allocations` (version 1, recorded before the decision) is handled exactly as before — one AP line, no unit — so history is never re-attributed.
 */
export interface PaymentUnitGroup {
  orgUnitId: string | null;
  amount: string;
}

export type PaymentAllocationsResult = { ok: true; groups: PaymentUnitGroup[] } | { ok: false; reason: string } | null;

/** `null` = no allocation detail in the payload (legacy v1): the caller keeps the single-line behaviour. */
export function readPaymentAllocations(payload: Record<string, unknown>, totalAmount: string): PaymentAllocationsResult {
  const raw = payload.allocations;
  if (!Array.isArray(raw)) return null;
  const cents = new Map<string | null, number>();
  let sum = 0;
  for (const item of raw as Array<Record<string, unknown>>) {
    const n = Number(item?.amount);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'allocation with a missing/invalid amount' };
    const c = Math.round(n * 100);
    const unit = typeof item.orgUnitId === 'string' && item.orgUnitId.trim() !== '' ? item.orgUnitId : null;
    cents.set(unit, (cents.get(unit) ?? 0) + c);
    sum += c;
  }
  if (cents.size === 0) return { ok: false, reason: 'allocations are empty' };
  if (sum !== Math.round(Number(totalAmount) * 100)) return { ok: false, reason: `allocations (${(sum / 100).toFixed(2)}) do not add up to the payment amount (${totalAmount})` };
  const groups = [...cents.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1)) // unassigned first, then by unit id: deterministic line order
    .map(([orgUnitId, c]) => ({ orgUnitId, amount: (c / 100).toFixed(2) }));
  return { ok: true, groups };
}
