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
};
