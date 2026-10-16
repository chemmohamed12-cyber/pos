/**
 * Master data step 1 (approved 2026-10-15, decision D-MD2) — the item type. Informational in step 1: it decides which item-page
 * sections apply (a Bill of Materials belongs to `finished_good` / `semi_finished`), and is the hook later steps use for
 * type-specific rules (e.g. a `service` holding no stock). It changes no posting, valuation or eligibility rule.
 */
export const ITEM_TYPES = ['finished_good', 'semi_finished', 'raw_material', 'consumable', 'service'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Item types that carry a Bill of Materials. */
export const BOM_ITEM_TYPES: ReadonlySet<ItemType> = new Set<ItemType>(['finished_good', 'semi_finished']);

export function isItemType(value: unknown): value is ItemType {
  return typeof value === 'string' && (ITEM_TYPES as readonly string[]).includes(value);
}
