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
  manifest_version: '1.0.0',
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
  ],

  // ADR-061 §15 — off by default, mirroring `inventory.assembly`'s own
  // existing precedent; satisfies ADR-055 §2's entitlement-vs-permission
  // separation from this module's first commit.
  feature_codes: [{ code: 'manufacturing.work_orders', title_code: 'feat.manufacturing.work_orders', default: false, toggleable: true }],

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
    ],
    queries: ['GetWorkOrder', 'ListWorkOrders'],
    events: [
      'manufacturing.work_order.material_issued',
      'manufacturing.work_order.material_returned',
      'manufacturing.work_order.finished_goods_received',
    ],
  },
};
