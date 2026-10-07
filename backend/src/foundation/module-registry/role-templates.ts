/**
 * ERP Foundation — P4 F2. System role TEMPLATES per module. Data only.
 *
 * These are seeded (idempotently) into `roles` + `role_permissions` for every
 * currently-entitled module on boot, and for a newly-enabled module by P6's
 * "enable Module" deploy step. `is_system` is not a column on `roles` today —
 * the templates are seeded as ordinary roles the customer then owns and may
 * edit (TENANT_ENTITLEMENT_PERMISSION_MODEL.md §5).
 *
 * A template grants a node at an access level; the Permission Engine's
 * ancestor-walk means granting `sales.order` 'editable' covers
 * `sales.order.approve` etc. — so templates stay short.
 */
export type PermissionAccess = 'hidden' | 'read-only' | 'editable';

export interface RoleTemplate {
  /** role key, `<module_code>.<role>` */
  key: string;
  titleCode: string;
  /**
   * F3 — the template's own version (default 1). A Company role records the version it was cloned at; a higher catalog version is OFFERED to the
   * Company (diff + apply/ignore), never applied automatically (Blueprint §7).
   */
  version?: number;
  grants: { node: string; access: PermissionAccess }[];
}

export const MODULE_ROLE_TEMPLATES: Record<string, RoleTemplate[]> = {
  sales: [
    {
      key: 'sales.manager',
      titleCode: 'role.sales.manager',
      grants: [{ node: 'sales', access: 'editable' }],
    },
    {
      key: 'sales.rep',
      titleCode: 'role.sales.rep',
      grants: [
        { node: 'sales.catalog', access: 'read-only' },
        { node: 'sales.customer', access: 'editable' },
        { node: 'sales.order', access: 'editable' },
        { node: 'sales.deposit', access: 'editable' },
      ],
    },
    { key: 'sales.viewer', titleCode: 'role.sales.viewer', grants: [{ node: 'sales', access: 'read-only' }] },
  ],
  inventory: [
    { key: 'inventory.manager', titleCode: 'role.inventory.manager', grants: [{ node: 'inventory', access: 'editable' }] },
    {
      key: 'inventory.operator',
      titleCode: 'role.inventory.operator',
      grants: [
        { node: 'inventory.stock', access: 'read-only' },
        { node: 'inventory.movement', access: 'editable' },
        { node: 'inventory.transaction', access: 'editable' },
        { node: 'inventory.fulfillment', access: 'editable' },
      ],
    },
    { key: 'inventory.viewer', titleCode: 'role.inventory.viewer', grants: [{ node: 'inventory', access: 'read-only' }] },
  ],
  logistics: [
    { key: 'logistics.manager', titleCode: 'role.logistics.manager', grants: [{ node: 'logistics', access: 'editable' }] },
    {
      key: 'logistics.dispatcher',
      titleCode: 'role.logistics.dispatcher',
      grants: [
        { node: 'logistics.shipment', access: 'editable' },
        { node: 'logistics.tracking', access: 'read-only' },
        { node: 'logistics.delivery', access: 'editable' },
        { node: 'logistics.collection', access: 'editable' },
      ],
    },
    { key: 'logistics.viewer', titleCode: 'role.logistics.viewer', grants: [{ node: 'logistics', access: 'read-only' }] },
  ],
  finance: [
    { key: 'finance.manager', titleCode: 'role.finance.manager', grants: [{ node: 'finance', access: 'editable' }] },
    {
      key: 'finance.clerk',
      titleCode: 'role.finance.clerk',
      grants: [
        { node: 'finance.cash', access: 'editable' },
        { node: 'finance.invoice', access: 'editable' },
        { node: 'finance.payment', access: 'editable' },
        { node: 'finance.ledger', access: 'read-only' },
      ],
    },
    { key: 'finance.viewer', titleCode: 'role.finance.viewer', grants: [{ node: 'finance', access: 'read-only' }] },
    // F3: treasury had only module-wide roles. The officer works the cash desk (view / post / transfer) and the treasury accounts; reversing a cash entry stays out of the template.
    {
      key: 'finance.treasury_officer',
      titleCode: 'role.finance.treasury_officer',
      grants: [
        { node: 'finance.cash.view', access: 'read-only' },
        { node: 'finance.cash.post', access: 'editable' },
        { node: 'finance.cash.transfer', access: 'editable' },
        { node: 'finance.treasury', access: 'editable' },
        { node: 'finance.payment.view', access: 'read-only' },
        { node: 'finance.ledger.view', access: 'read-only' },
      ],
    },
  ],
  reporting: [
    { key: 'reporting.analyst', titleCode: 'role.reporting.analyst', grants: [{ node: 'reporting', access: 'read-only' }] },
  ],
  hr: [
    { key: 'hr.manager', titleCode: 'role.hr.manager', grants: [{ node: 'hr', access: 'editable' }] },
    { key: 'hr.viewer', titleCode: 'role.hr.viewer', grants: [{ node: 'hr', access: 'read-only' }] },
  ],
  manufacturing: [
    { key: 'manufacturing.manager', titleCode: 'role.manufacturing.manager', grants: [{ node: 'manufacturing', access: 'editable' }] },
    {
      key: 'manufacturing.operator',
      titleCode: 'role.manufacturing.operator',
      grants: [
        { node: 'manufacturing.work_order.view', access: 'read-only' },
        { node: 'manufacturing.work_order.material_issue', access: 'editable' },
        { node: 'manufacturing.work_order.material_return', access: 'editable' },
        { node: 'manufacturing.work_order.finished_goods_receive', access: 'editable' },
        { node: 'manufacturing.work_order.operation_execute', access: 'editable' },
        { node: 'manufacturing.bom.view', access: 'read-only' },
        { node: 'manufacturing.routing.view', access: 'read-only' },
        { node: 'manufacturing.work_center.view', access: 'read-only' },
      ],
    },
    { key: 'manufacturing.viewer', titleCode: 'role.manufacturing.viewer', grants: [{ node: 'manufacturing', access: 'read-only' }] },
  ],
  accounting: [
    { key: 'accounting.manager', titleCode: 'role.accounting.manager', grants: [{ node: 'accounting', access: 'editable' }] },
    { key: 'accounting.viewer', titleCode: 'role.accounting.viewer', grants: [{ node: 'accounting', access: 'read-only' }] },
  ],
  // ── F3 (2026-10-07) — templates for the modules that had none (AZ-04). Created UNASSIGNED when the module is enabled; no one gains anything automatically.
  procurement: [
    { key: 'procurement.manager', titleCode: 'role.procurement.manager', grants: [{ node: 'procurement', access: 'editable' }] },
    {
      key: 'procurement.buyer',
      titleCode: 'role.procurement.buyer',
      grants: [
        { node: 'procurement.purchase_request.view', access: 'read-only' },
        { node: 'procurement.purchase_request.create', access: 'editable' },
        { node: 'procurement.purchase_request.edit', access: 'editable' },
        { node: 'procurement.purchase_order.view', access: 'read-only' },
        { node: 'procurement.purchase_order.create', access: 'editable' },
        { node: 'procurement.purchase_order.edit', access: 'editable' },
        { node: 'procurement.rfq.view', access: 'read-only' },
        { node: 'procurement.rfq.create', access: 'editable' },
        { node: 'procurement.rfq.edit', access: 'editable' },
        { node: 'procurement.rfq.record_quotation', access: 'editable' },
        { node: 'procurement.supplier.view', access: 'read-only' },
        { node: 'procurement.goods_receipt.view', access: 'read-only' },
      ],
    },
    { key: 'procurement.viewer', titleCode: 'role.procurement.viewer', grants: [{ node: 'procurement', access: 'read-only' }] },
  ],
  payroll: [
    { key: 'payroll.manager', titleCode: 'role.payroll.manager', grants: [{ node: 'payroll', access: 'editable' }] },
    { key: 'payroll.viewer', titleCode: 'role.payroll.viewer', grants: [{ node: 'payroll', access: 'read-only' }] },
  ],
  attendance: [
    { key: 'attendance.manager', titleCode: 'role.attendance.manager', grants: [{ node: 'attendance', access: 'editable' }] },
    { key: 'attendance.viewer', titleCode: 'role.attendance.viewer', grants: [{ node: 'attendance', access: 'read-only' }] },
  ],
  commission: [
    { key: 'commission.manager', titleCode: 'role.commission.manager', grants: [{ node: 'commission', access: 'editable' }] },
    { key: 'commission.viewer', titleCode: 'role.commission.viewer', grants: [{ node: 'commission', access: 'read-only' }] },
  ],
  targets: [
    { key: 'targets.manager', titleCode: 'role.targets.manager', grants: [{ node: 'targets', access: 'editable' }] },
    { key: 'targets.viewer', titleCode: 'role.targets.viewer', grants: [{ node: 'targets', access: 'read-only' }] },
  ],
};

/**
 * F3 — the Company ADMINISTRATION system role (Blueprint §6.2, D17): `company_admin` administers the Company (users, roles, backups, the authorization
 * audit) and holds NO operational or critical capability. It is NOT a module template (it is not entitlement-gated and is never part of the catalog a module
 * brings); it is seeded for NEW Companies only — existing Companies keep their `admin` row verbatim, relabelled "Legacy Administrator (Operational)".
 */
export const COMPANY_ADMIN_ROLE_KEY = 'company_admin';
export const COMPANY_ADMIN_ROLE_META = {
  nameEn: 'Company Administrator',
  nameAr: 'مدير الشركة',
  descriptionEn: 'Administers the Company: users, roles, backups and the authorization audit. Holds no operational or critical permission; those are granted explicitly by roles.',
  descriptionAr: 'يدير الشركة: المستخدمين والأدوار والنسخ الاحتياطي وسجل التدقيق. لا يملك أي صلاحية تشغيلية أو حرجة؛ تُمنح هذه صراحةً عبر الأدوار.',
};
