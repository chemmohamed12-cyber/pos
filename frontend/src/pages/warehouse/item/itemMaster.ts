/** Master data step 1 — shared constants, types and terminology code lists of the item page panels. */
export const ITEM_TYPES = ['finished_good', 'semi_finished', 'raw_material', 'consumable', 'service'] as const;
export const BOM_ITEM_TYPES = new Set<string>(['finished_good', 'semi_finished']);

export interface ItemMasterProduct {
  id: string;
  sku: string;
  name: string;
  unit: string | null;
  status: string;
  itemType: string;
  categoryId: string | null;
  defaultWarehouseId: string | null;
  reorderLevel: string | null;
  description: string | null;
}
export interface Category {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  status: 'active' | 'inactive';
}
export interface AssignedWarehouse {
  id: string;
  code: string;
  name: string;
}

export const ITEM_BASIC_LABELS = [
  'field.code',
  'field.name',
  'field.status',
  'field.base_unit',
  'field.item_type',
  'field.item_category',
  'field.primary_default_warehouse',
  'field.assigned_warehouses',
  'field.reorder_level',
  'field.item_description',
  'field.item_image',
  'field.category_code',
  'field.category_name',
  'panel.not_in_data_model',
  'panel.item_default_warehouse_hint',
  'panel.item_reorder_hint',
  'panel.item_saved',
  'action.edit',
  'action.save',
  'action.cancel',
  'action.new_category',
  ...ITEM_TYPES.map((v) => `value.item_type.${v}`),
];

export const ITEM_BARCODE_LABELS = [
  'field.base_unit',
  'field.barcode',
  'field.pack_label',
  'field.primary_barcode',
  'panel.item_no_barcodes',
  'panel.item_barcode_rules',
  'action.add_barcode',
  'action.remove',
];

export const ITEM_BOM_LABELS = [
  'field.component',
  'field.quantity_per_unit',
  'field.status',
  'panel.item_no_bom',
  'panel.item_bom_integer_note',
  'action.add_component',
  'action.save',
  'action.cancel',
  'action.remove',
  'mfg.action.edit',
  'mfg.action.new_bom',
  'mfg.action.activate',
  'mfg.action.deactivate',
  'mfg.status.active',
  'mfg.status.inactive',
  'field.search_product_placeholder',
  'nav.manufacturing_boms',
];
