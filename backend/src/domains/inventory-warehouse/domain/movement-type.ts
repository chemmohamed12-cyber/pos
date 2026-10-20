/**
 * Inventory & Warehouse — Stage 2 build-order item 27.
 * Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §6, ADR-007, blueprint §17-19.
 *
 * Movement-based ledger, adapted from baseline's inventory-ledger-engine.js
 * (Class B, Daii/_source-audits/baseline/) — stock is always derived from
 * movements, never stored as a mutable quantity anywhere. Extended with
 * the warehouse dimension the source lacked.
 */
/**
 * `assembly_consumption`/`assembly_output` — Gap G-2
 * (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §3B/§4,
 * `تجميع صاله الانتاج` — "assembly, production floor", the one real
 * movement type evidenced in the company's own component-warehouse
 * operation-type reference sheet, today kept in sync by hand across two
 * mirrored workbooks). Always written in the SAME atomic transaction by
 * `InventoryService.assembleProduct` — components consumed and the
 * finished good produced, or neither, never a partial assembly.
 */
/**
 * `return_in` — Returns Engine (CTO directive, Returns/Inspection Location).
 * The physical arrival of a customer-returned unit into the Returns/
 * Inspection sub-location — analogous to `receipt` (stock appearing from
 * outside the ledger) but tagged distinctly so it's never confused with a
 * normal purchase receipt. The pre-existing generic `return` type is left
 * untouched (still used nowhere new); the Inspection→destination leg that
 * follows a disposition reuses the existing `transfer_in`/`transfer_out`
 * pair, no further new type needed.
 */
/**
 * `work_order_material_issue`/`work_order_material_return`/
 * `work_order_finished_goods_output` — ADR-061 (Manufacturing). Each
 * explicitly invokes F08 valuation itself (never relies on
 * `recordMovement`'s `'receipt'`-only auto-hook) — see
 * `ManufacturingWorkOrderService`. Deliberately NOT added to
 * `INVENTORY_GL_MOVEMENT_TYPES` (ADR-061 §13): each publishes its own
 * Financial Event topic instead of using that set's dispatch-only path.
 */
export type MovementType =
  | 'receipt'
  | 'dispatch'
  | 'adjustment'
  | 'transfer_in'
  | 'transfer_out'
  | 'return'
  | 'return_in'
  | 'assembly_consumption'
  | 'assembly_output'
  | 'work_order_material_issue'
  | 'work_order_material_return'
  | 'work_order_finished_goods_output'
  // phase D-1 (2026-10-20): goods returned to a supplier by a posted Purchase Return. Deliberately NOT in `glKindFor`: the return publishes its own `procurement.purchase_return.posted` event.
  | 'purchase_return_out';
