/**
 * Post-v1.0.2 Hotfix 3 — Price List priority chain for Sales Order
 * pricing: Customer's assigned list -> Main -> General. `null` means an
 * ordinary, unassigned list (every list before this hotfix, and every
 * list an admin creates without marking it). `'general'` is set only by
 * `PriceListsService` itself (the system-owned, auto-populated list) —
 * never assignable through the admin UI.
 */
export type PriceListRole = 'main' | 'general' | null;
