import { ModuleManifest } from '../module-manifest.type';

/**
 * ADR-048 — `procurement` module manifest, promoted from
 * `ReservedModuleCode` per direct CTO instruction. This first version
 * covers only the `supplier` bounded context (Supplier Master); the
 * `purchasing` (PO/Goods Receipt) and `supplier-finance` (Invoice/AP/
 * Payment) contexts each bump `manifest_version` and extend
 * `permission_nodes`/`public_contract` as they ship, matching how
 * `accounting`'s own manifest grew across F01-F08.
 *
 * `depends_on: []` for this slice — Supplier Master has no read/write
 * dependency on any sibling domain yet. `purchasing` will add `inventory`
 * (via `InventoryService.recordMovement`) and `supplier-finance` will add
 * `accounting`/`finance` (via the financial-event/outbox pattern and the
 * Treasury contract) once those slices land.
 */
export const procurementManifest: ModuleManifest = {
  module_code: 'procurement',
  manifest_version: '1.6.0',
  title_code: 'module.procurement',
  business_domains: ['procurement'],
  // 1.1.0 (Goods Receipt) added `inventory`: `GoodsReceiptService` calls
  // `InventoryService.recordMovement` directly. 1.2.0 (Supplier Invoice/
  // AP/Payment) adds `finance`: `SupplierPaymentService` calls
  // `TreasuryService.cashOut` directly (ADR-027 only gates import
  // cycles, not every cross-domain import — see the module's own doc
  // comment). `accounting` is NOT listed — the AP posting integration is
  // one-directional the OTHER way (`AccountingModule` imports
  // `ProcurementModule` for `SUPPLIER_LEDGER_CONTRACT`), and Procurement
  // reaches Accounting only via the Transactional Outbox event bus, never
  // a code import.
  depends_on: ['inventory', 'finance'],

  permission_nodes: [
    { node: 'procurement', title_code: 'perm.procurement' },

    { node: 'procurement.supplier', title_code: 'perm.procurement.supplier', parent: 'procurement' },
    { node: 'procurement.supplier.view', title_code: 'perm.procurement.supplier.view', parent: 'procurement.supplier' },
    { node: 'procurement.supplier.create', title_code: 'perm.procurement.supplier.create', parent: 'procurement.supplier' },
    { node: 'procurement.supplier.edit', title_code: 'perm.procurement.supplier.edit', parent: 'procurement.supplier' },

    // OP-Procurement/AP Blueprint (CTO ratification, Decision 6) — the
    // `requiredPermissionNode` a checker must hold for the
    // `procurement.bank_account_change` request type's mandatory 2-person
    // sequential matrix rule (`SupplierService.onModuleInit`). Named
    // `.bank_account.edit` (a capability), deliberately distinct from the
    // `procurement.bank_account_change` requestTypeCode (an event) —
    // the same two-different-strings convention `accounting.ap.write_off`
    // (event) / `accounting.ap.approve` (capability) already uses.
    { node: 'procurement.bank_account.edit', title_code: 'perm.procurement.bank_account.edit', parent: 'procurement.supplier' },

    { node: 'procurement.purchase_order', title_code: 'perm.procurement.purchase_order', parent: 'procurement' },
    { node: 'procurement.purchase_order.view', title_code: 'perm.procurement.purchase_order.view', parent: 'procurement.purchase_order' },
    { node: 'procurement.purchase_order.create', title_code: 'perm.procurement.purchase_order.create', parent: 'procurement.purchase_order' },
    { node: 'procurement.purchase_order.edit', title_code: 'perm.procurement.purchase_order.edit', parent: 'procurement.purchase_order' },
    // Deliberately separate from .create — a maker can draft a PO without
    // also being able to approve it (segregation of duties, expressed as a
    // plain permission split here since PO approval is one role's single
    // decision, not a configurable multi-approver flow).
    { node: 'procurement.purchase_order.approve', title_code: 'perm.procurement.purchase_order.approve', parent: 'procurement.purchase_order' },

    { node: 'procurement.goods_receipt', title_code: 'perm.procurement.goods_receipt', parent: 'procurement' },
    { node: 'procurement.goods_receipt.view', title_code: 'perm.procurement.goods_receipt.view', parent: 'procurement.goods_receipt' },
    { node: 'procurement.goods_receipt.create', title_code: 'perm.procurement.goods_receipt.create', parent: 'procurement.goods_receipt' },

    { node: 'procurement.supplier_invoice', title_code: 'perm.procurement.supplier_invoice', parent: 'procurement' },
    { node: 'procurement.supplier_invoice.view', title_code: 'perm.procurement.supplier_invoice.view', parent: 'procurement.supplier_invoice' },
    { node: 'procurement.supplier_invoice.create', title_code: 'perm.procurement.supplier_invoice.create', parent: 'procurement.supplier_invoice' },
    { node: 'procurement.supplier_invoice.post', title_code: 'perm.procurement.supplier_invoice.post', parent: 'procurement.supplier_invoice' },
    { node: 'procurement.supplier_invoice.void', title_code: 'perm.procurement.supplier_invoice.void', parent: 'procurement.supplier_invoice' },
    // phase C-1 (D5 / D2 / D1): submit -> approve (independent person) -> post; `override` approves a price exception; `invoice_policy.manage` sets the Company approval switch and tolerance limits
    { node: 'procurement.supplier_invoice.submit', title_code: 'perm.procurement.supplier_invoice.submit', parent: 'procurement.supplier_invoice' },
    { node: 'procurement.supplier_invoice.approve', title_code: 'perm.procurement.supplier_invoice.approve', parent: 'procurement.supplier_invoice' },
    { node: 'procurement.supplier_invoice.override', title_code: 'perm.procurement.supplier_invoice.override', parent: 'procurement.supplier_invoice' },
    { node: 'procurement.invoice_policy', title_code: 'perm.procurement.invoice_policy', parent: 'procurement' },
    { node: 'procurement.invoice_policy.manage', title_code: 'perm.procurement.invoice_policy.manage', parent: 'procurement.invoice_policy' },

    // phase D-1 (D7): purchase returns - create (maker) -> submit -> approve (independent person) -> post
    { node: 'procurement.purchase_return', title_code: 'perm.procurement.purchase_return', parent: 'procurement' },
    { node: 'procurement.purchase_return.view', title_code: 'perm.procurement.purchase_return.view', parent: 'procurement.purchase_return' },
    { node: 'procurement.purchase_return.create', title_code: 'perm.procurement.purchase_return.create', parent: 'procurement.purchase_return' },
    { node: 'procurement.purchase_return.submit', title_code: 'perm.procurement.purchase_return.submit', parent: 'procurement.purchase_return' },
    { node: 'procurement.purchase_return.approve', title_code: 'perm.procurement.purchase_return.approve', parent: 'procurement.purchase_return' },
    { node: 'procurement.purchase_return.post', title_code: 'perm.procurement.purchase_return.post', parent: 'procurement.purchase_return' },

    { node: 'procurement.supplier_payment', title_code: 'perm.procurement.supplier_payment', parent: 'procurement' },
    { node: 'procurement.supplier_payment.view', title_code: 'perm.procurement.supplier_payment.view', parent: 'procurement.supplier_payment' },
    { node: 'procurement.supplier_payment.create', title_code: 'perm.procurement.supplier_payment.create', parent: 'procurement.supplier_payment' },

    // Path B (Controlled Procurement Cycle) — Purchase Request → RFQ → Quotations → Evaluation/Approval.
    { node: 'procurement.purchase_request', title_code: 'perm.procurement.purchase_request', parent: 'procurement' },
    { node: 'procurement.purchase_request.view', title_code: 'perm.procurement.purchase_request.view', parent: 'procurement.purchase_request' },
    { node: 'procurement.purchase_request.create', title_code: 'perm.procurement.purchase_request.create', parent: 'procurement.purchase_request' },
    { node: 'procurement.purchase_request.edit', title_code: 'perm.procurement.purchase_request.edit', parent: 'procurement.purchase_request' },
    { node: 'procurement.purchase_request.approve', title_code: 'perm.procurement.purchase_request.approve', parent: 'procurement.purchase_request' },

    { node: 'procurement.rfq', title_code: 'perm.procurement.rfq', parent: 'procurement' },
    { node: 'procurement.rfq.view', title_code: 'perm.procurement.rfq.view', parent: 'procurement.rfq' },
    { node: 'procurement.rfq.create', title_code: 'perm.procurement.rfq.create', parent: 'procurement.rfq' },
    { node: 'procurement.rfq.edit', title_code: 'perm.procurement.rfq.edit', parent: 'procurement.rfq' },
    { node: 'procurement.rfq.record_quotation', title_code: 'perm.procurement.rfq.record_quotation', parent: 'procurement.rfq' },
    // The Approval Engine's fallback `resolvedRequiredNode` when no matrix rule is configured yet
    // for `procurement.rfq_award` — whoever holds this node can decide the Evaluation/Approval step.
    { node: 'procurement.rfq.award', title_code: 'perm.procurement.rfq.award', parent: 'procurement.rfq' },
    { node: 'procurement.rfq_award', title_code: 'perm.procurement.rfq_award', parent: 'procurement.rfq' },
  ],

  feature_codes: [
    { code: 'procurement.supplier_master', title_code: 'feat.procurement.supplier_master', default: true, toggleable: false },
    { code: 'procurement.purchase_orders', title_code: 'feat.procurement.purchase_orders', default: true, toggleable: false },
    { code: 'procurement.supplier_finance', title_code: 'feat.procurement.supplier_finance', default: true, toggleable: false },
    { code: 'procurement.controlled_procurement_cycle', title_code: 'feat.procurement.controlled_procurement_cycle', default: true, toggleable: false },
  ],

  limit_keys: [{ key: 'procurement.max_suppliers', title_code: 'limit.procurement.max_suppliers', unit: 'count', default: null }],

  config_keys: [],

  migration_tag: 'procurement',

  public_contract: {
    commands: [
      'CreateSupplier',
      'SetSupplierStatus',
      'AddSupplierBankAccount',
      'CreatePurchaseOrder',
      'TransitionPurchaseOrder',
      'PostGoodsReceipt',
      'CreateSupplierInvoice',
      'PostSupplierInvoice',
      'VoidSupplierInvoice',
      'RecordSupplierPayment',
      'CreatePurchaseRequest',
      'TransitionPurchaseRequest',
      'CreateRfqFromPurchaseRequest',
      'SendRfq',
      'RecordSupplierQuotation',
      'AwardRfqToSupplier',
    ],
    queries: [
      'GetSupplier',
      'ListSuppliers',
      'GetSupplierLedger',
      'GetPurchaseOrder',
      'ListPurchaseOrders',
      'ListGoodsReceiptsForPurchaseOrder',
      'GetSupplierInvoice',
      'ListSupplierInvoices',
      'GetApAging',
      'ListSupplierPayments',
      'GetPurchaseRequest',
      'ListPurchaseRequests',
      'GetRfq',
      'ListRfqs',
    ],
    events: ['procurement.purchase_return.posted', 'finance.supplier_invoice.posted', 'finance.supplier_invoice.voided', 'finance.supplier_invoice.cost_adjusted', 'finance.supplier_invoice.cost_adjustment_voided', 'finance.supplier_payment.recorded'],
  },
};
