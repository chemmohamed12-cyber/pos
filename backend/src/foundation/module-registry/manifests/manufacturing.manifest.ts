import { ModuleManifest } from '../module-manifest.type';

/**
 * ADR-061 — `manufacturing` module manifest, promoted from
 * `ReservedModuleCode` per direct CTO instruction (ADR-060/ADR-061,
 * "Manufacturing Team — PROCEED"). Covers Work Orders (Work Order /
 * Work Order Component / Material Issue / Material Return / Finished
 * Goods Output) exactly as specified in ADR-061 §§1-20. No labor/
 * overhead/standard-cost/variance surface (D2/D3) — those permission
 * nodes/features do not exist anywhere in this manifest by design.
 *
 * `depends_on: ['sales', 'inventory']` (ADR-061 §1) — `sales` because
 * Work Order release reads `SalesBomContract.getBomForAssembly`
 * (Commerce/BOM lives under the `sales` module grouping); `inventory`
 * because every Manufacturing movement calls
 * `InventoryService.recordMovement`/`reserveStockInTransaction`
 * directly. `accounting` is NOT listed — Manufacturing reaches
 * Accounting only via the Transactional Outbox event bus (Financial
 * Events), never a code import, same precedent `procurement`'s own
 * manifest already documents.
 */
export const manufacturingManifest: ModuleManifest = {
  module_code: 'manufacturing',
  manifest_version: '1.1.0',
  title_code: 'module.manufacturing',
  business_domains: ['manufacturing'],
  depends_on: ['sales', 'inventory'],

  permission_nodes: [
    { node: 'manufacturing', title_code: 'perm.manufacturing' },

    { node: 'manufacturing.work_order', title_code: 'perm.manufacturing.work_order', parent: 'manufacturing' },
    { node: 'manufacturing.work_order.view', title_code: 'perm.manufacturing.work_order.view', parent: 'manufacturing.work_order' },
    { node: 'manufacturing.work_order.create', title_code: 'perm.manufacturing.work_order.create', parent: 'manufacturing.work_order' },
    { node: 'manufacturing.work_order.release', title_code: 'perm.manufacturing.work_order.release', parent: 'manufacturing.work_order' },
    { node: 'manufacturing.work_order.material_issue', title_code: 'perm.manufacturing.work_order.material_issue', parent: 'manufacturing.work_order' },
    { node: 'manufacturing.work_order.material_return', title_code: 'perm.manufacturing.work_order.material_return', parent: 'manufacturing.work_order' },
    { node: 'manufacturing.work_order.finished_goods_receive', title_code: 'perm.manufacturing.work_order.finished_goods_receive', parent: 'manufacturing.work_order' },
    { node: 'manufacturing.work_order.hold', title_code: 'perm.manufacturing.work_order.hold', parent: 'manufacturing.work_order' },
    { node: 'manufacturing.work_order.complete', title_code: 'perm.manufacturing.work_order.complete', parent: 'manufacturing.work_order' },
    { node: 'manufacturing.work_order.cancel', title_code: 'perm.manufacturing.work_order.cancel', parent: 'manufacturing.work_order' },

    // ADR-061 Addendum 1 (A1/A2/A6) — master data + operation execution.
    { node: 'manufacturing.work_order.operation_execute', title_code: 'perm.manufacturing.work_order.operation_execute', parent: 'manufacturing.work_order' },
    { node: 'manufacturing.bom', title_code: 'perm.manufacturing.bom', parent: 'manufacturing' },
    { node: 'manufacturing.bom.view', title_code: 'perm.manufacturing.bom.view', parent: 'manufacturing.bom' },
    { node: 'manufacturing.bom.create', title_code: 'perm.manufacturing.bom.create', parent: 'manufacturing.bom' },
    { node: 'manufacturing.bom.edit', title_code: 'perm.manufacturing.bom.edit', parent: 'manufacturing.bom' },
    { node: 'manufacturing.bom.delete', title_code: 'perm.manufacturing.bom.delete', parent: 'manufacturing.bom' },
    { node: 'manufacturing.routing', title_code: 'perm.manufacturing.routing', parent: 'manufacturing' },
    { node: 'manufacturing.routing.view', title_code: 'perm.manufacturing.routing.view', parent: 'manufacturing.routing' },
    { node: 'manufacturing.routing.create', title_code: 'perm.manufacturing.routing.create', parent: 'manufacturing.routing' },
    { node: 'manufacturing.routing.edit', title_code: 'perm.manufacturing.routing.edit', parent: 'manufacturing.routing' },
    { node: 'manufacturing.routing.delete', title_code: 'perm.manufacturing.routing.delete', parent: 'manufacturing.routing' },
    { node: 'manufacturing.work_center', title_code: 'perm.manufacturing.work_center', parent: 'manufacturing' },
    { node: 'manufacturing.work_center.view', title_code: 'perm.manufacturing.work_center.view', parent: 'manufacturing.work_center' },
    { node: 'manufacturing.work_center.create', title_code: 'perm.manufacturing.work_center.create', parent: 'manufacturing.work_center' },
    { node: 'manufacturing.work_center.edit', title_code: 'perm.manufacturing.work_center.edit', parent: 'manufacturing.work_center' },
    { node: 'manufacturing.work_center.delete', title_code: 'perm.manufacturing.work_center.delete', parent: 'manufacturing.work_center' },
  ],

  // ADR-061 Addendum 1 (A5) — structural: Work Orders ARE the Manufacturing module, so the feature follows
  // the module's entitlement (Package → Entitlement → Company Capability) with no separate toggle.
  feature_codes: [{ code: 'manufacturing.work_orders', title_code: 'feat.manufacturing.work_orders', default: true, toggleable: false }],

  limit_keys: [],

  config_keys: [],

  migration_tag: 'manufacturing',

  public_contract: {
    commands: [
      'CreateWorkOrder',
      'ReleaseWorkOrder',
      'IssueWorkOrderMaterial',
      'ReturnWorkOrderMaterial',
      'RecordWorkOrderFinishedGoodsOutput',
      'HoldWorkOrder',
      'ResumeWorkOrder',
      'CompleteWorkOrder',
      'CancelWorkOrder',
      'StartWorkOrderOperation',
      'CompleteWorkOrderOperation',
      'DefineBillOfMaterials',
      'SetBillOfMaterialsStatus',
      'DefineRouting',
      'CreateWorkCenter',
    ],
    queries: ['GetWorkOrder', 'ListWorkOrders', 'ListBillsOfMaterials', 'GetBillOfMaterials', 'ListRoutings', 'GetRouting', 'ListWorkCenters'],
    events: [
      'manufacturing.work_order.material_issued',
      'manufacturing.work_order.material_returned',
      'manufacturing.work_order.finished_goods_received',
    ],
  },
};
