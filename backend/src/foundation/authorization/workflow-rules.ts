import { PermissionAccess } from '../permission/role-permission.entity';

/**
 * Authorization Foundation F5 — the legacy-role MAP: every hard-coded role decision of the product, expressed once as a workflow capability.
 *
 * A "workflow rule" is one decision point that used to read `roles.includes('sales_supervisor')`-style keys. Each gets a capability node in the `wf.*`
 * namespace (`wf.<module>.<area>.<action>`) — deliberately OUTSIDE the module prefixes (`sales`, `logistics`, …) so a module-wide grant such as the
 * `sales.manager` template's `sales: editable` can never silently confer a workflow power the legacy role key used to gate (that would be a capability GAIN).
 * The owning module (second segment) still drives entitlement filtering.
 *
 * `legacyRoles` is the role list the call site declared; the legacy `admin` passes every rule (explicitly or implicitly at every call site) and is therefore
 * not repeated here. The Company's existing roles receive the capability by the migration `WorkflowCapabilityGrants` (the holders of each legacy key get exactly
 * the nodes whose `legacyRoles` list that key; `admin` gets them all), so the capability decision equals the legacy decision for every existing user — and from
 * then on a Company can grant the capability to any role it designs.
 */
export type WorkflowRisk = 'low' | 'sensitive';

export interface WorkflowRule {
  key: string;
  node: string;
  /** The module that owns the capability (entitlement); `core` = always available. */
  module: string;
  legacyRoles: readonly string[];
  access: PermissionAccess;
  risk: WorkflowRisk;
  titleEn: string;
  titleAr: string;
}

const W = (key: string, node: string, module: string, legacyRoles: string[], risk: WorkflowRisk, titleEn: string, titleAr: string): WorkflowRule => ({ key, node, module, legacyRoles, access: 'editable', risk, titleEn, titleAr });

const WH_NAV = ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'];

export const WORKFLOW_RULES: readonly WorkflowRule[] = [
  // ── Sales orders ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  W('sales.order.submit', 'wf.sales.order.submit', 'sales', ['sales_rep'], 'low', 'Submit a sales order for approval', 'تقديم أمر البيع للاعتماد'),
  W('sales.order.resubmit', 'wf.sales.order.resubmit', 'sales', ['sales_rep'], 'low', 'Resubmit a rejected sales order', 'إعادة تقديم أمر بيع مرفوض'),
  W('sales.order.supervisor_approve', 'wf.sales.order.supervisor_approve', 'sales', ['sales_supervisor'], 'sensitive', 'Approve a sales order as supervisor', 'اعتماد أمر البيع كمشرف'),
  W('sales.order.supervisor_reject', 'wf.sales.order.supervisor_reject', 'sales', ['sales_supervisor'], 'sensitive', 'Reject a sales order as supervisor', 'رفض أمر البيع كمشرف'),
  W('sales.order.manager_approve', 'wf.sales.order.manager_approve', 'sales', ['sales_manager'], 'sensitive', 'Approve a sales order as manager', 'اعتماد أمر البيع كمدير'),
  W('sales.order.manager_reject', 'wf.sales.order.manager_reject', 'sales', ['sales_manager'], 'sensitive', 'Reject a sales order as manager', 'رفض أمر البيع كمدير'),
  W('sales.order.list_all', 'wf.sales.order.list_all', 'sales', ['sales_supervisor', 'sales_manager', 'warehouse_worker'], 'low', 'See every sales order in lists (not only own)', 'رؤية كل أوامر البيع في القوائم'),
  W('sales.order.read_any', 'wf.sales.order.read_any', 'sales', ['sales_supervisor', 'sales_manager', 'warehouse_worker', 'finance'], 'low', 'Open any sales order (no per-order assignment)', 'فتح أي أمر بيع دون إسناد'),
  W('sales.order.edit_supervisor_review', 'wf.sales.order.edit_supervisor_review', 'sales', ['sales_supervisor'], 'sensitive', 'Edit an order while in supervisor review', 'تعديل الأمر أثناء مراجعة المشرف'),
  W('sales.order.edit_manager_approval', 'wf.sales.order.edit_manager_approval', 'sales', ['sales_manager'], 'sensitive', 'Edit an order while awaiting manager approval', 'تعديل الأمر أثناء اعتماد المدير'),
  W('sales.order.edit_released', 'wf.sales.order.edit_released', 'sales', ['finance'], 'sensitive', 'Edit a released order (reason required)', 'تعديل أمر مُفرج عنه (بسبب موثق)'),
  W('sales.order.set_manager_price', 'wf.sales.order.set_manager_price', 'sales', ['sales_manager'], 'sensitive', 'Set a manager price on an order line', 'تحديد سعر المدير على سطر أمر'),
  W('sales.order.edit_any_draft', 'wf.sales.order.edit_any_draft', 'sales', [], 'sensitive', 'Edit a draft order of another sales representative', 'تعديل مسودة أمر لمندوب آخر'),
  W('sales.order.delete_any_draft', 'wf.sales.order.delete_any_draft', 'sales', [], 'sensitive', 'Delete a draft order of another sales representative', 'حذف مسودة أمر لمندوب آخر'),
  W('sales.rep.list', 'wf.sales.rep.list', 'sales', ['sales_manager'], 'low', 'List the sales representatives of the Company (order rep picker)', 'عرض مندوبي مبيعات الشركة (اختيار المندوب في الطلب)'),
  W('sales.rep.act', 'wf.sales.rep.act', 'sales', ['sales_rep'], 'low', 'Act as the sales representative of an order (deposit, stock reservation, return request)', 'العمل كمندوب المبيعات للطلب (العربون، حجز المخزون، طلب مرتجع)'),
  W('sales.customer.read_any', 'wf.sales.customer.read_any', 'sales', ['sales_supervisor', 'sales_manager', 'finance'], 'low', 'Open any customer (no per-customer assignment)', 'فتح أي عميل دون إسناد'),
  // ── Logistics: shipments and returns ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  W('logistics.shipment.assign_driver', 'wf.logistics.shipment.assign_driver', 'logistics', [], 'sensitive', 'Assign a driver to a shipment', 'تعيين سائق لشحنة'),
  W('logistics.shipment.set_route', 'wf.logistics.shipment.set_route', 'logistics', [], 'sensitive', 'Assign or change a shipment route', 'تحديد أو تغيير مسار الشحنة'),
  W('logistics.shipment.act_any', 'wf.logistics.shipment.act_any', 'logistics', [], 'sensitive', 'Act on any shipment as if the assigned driver', 'التصرف في أي شحنة كالسائق المعيّن'),
  W('logistics.shipment.read_any', 'wf.logistics.shipment.read_any', 'logistics', ['finance'], 'low', 'View any shipment', 'عرض أي شحنة'),
  W('logistics.shipment.manage_non_driver_actions', 'wf.logistics.shipment.manage_non_driver_actions', 'logistics', [], 'sensitive', 'Run dispatcher-only shipment actions', 'تنفيذ إجراءات الشحن الخاصة بالمُرسِل'),
  W('logistics.shipment.board_all', 'wf.logistics.shipment.board_all', 'logistics', ['warehouse_worker'], 'low', 'See the whole shipments board', 'رؤية لوحة الشحنات كاملة'),
  W('logistics.shipment.custody_query', 'wf.logistics.shipment.custody_query', 'logistics', ['warehouse_worker', 'sales_supervisor'], 'low', 'Query goods in customer custody', 'الاستعلام عن البضاعة في عهدة العملاء'),
  W('logistics.return.request', 'wf.logistics.return.request', 'logistics', ['warehouse_worker', 'sales_supervisor'], 'low', 'Open a return request', 'فتح طلب مرتجع'),
  W('logistics.return.authorize', 'wf.logistics.return.authorize', 'logistics', ['sales_supervisor'], 'sensitive', 'Authorize a return', 'الموافقة على مرتجع'),
  W('logistics.return.reject', 'wf.logistics.return.reject', 'logistics', ['sales_supervisor'], 'sensitive', 'Reject a return', 'رفض مرتجع'),
  W('logistics.return.receive', 'wf.logistics.return.receive', 'logistics', ['warehouse_worker'], 'low', 'Receive a return at the warehouse', 'استلام مرتجع بالمخزن'),
  W('logistics.return.inspect', 'wf.logistics.return.inspect', 'logistics', ['warehouse_worker'], 'low', 'Inspect a return', 'فحص مرتجع'),
  W('logistics.return.disposition', 'wf.logistics.return.disposition', 'logistics', ['warehouse_worker'], 'sensitive', 'Record a return disposition', 'تسجيل مصير المرتجع'),
  // ── Inventory / warehouse ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  W('inventory.fulfillment.worker', 'wf.inventory.fulfillment.worker', 'inventory', ['warehouse_worker'], 'low', 'Prepare and fulfil orders (warehouse worker)', 'تجهيز الأوامر (عامل مخزن)'),
  W('inventory.warehouse_tx.submit', 'wf.inventory.warehouse_tx.submit', 'inventory', ['warehouse_worker', 'inventory_controller'], 'low', 'Submit a warehouse transaction', 'تقديم حركة مخزنية'),
  W('inventory.warehouse_tx.recall', 'wf.inventory.warehouse_tx.recall', 'inventory', ['warehouse_worker', 'warehouse_supervisor', 'inventory_controller'], 'low', 'Recall a warehouse transaction', 'سحب حركة مخزنية'),
  W('inventory.warehouse_tx.approve', 'wf.inventory.warehouse_tx.approve', 'inventory', ['warehouse_supervisor', 'inventory_controller'], 'sensitive', 'Approve a warehouse transaction', 'اعتماد حركة مخزنية'),
  W('inventory.warehouse_tx.post', 'wf.inventory.warehouse_tx.post', 'inventory', ['warehouse_supervisor', 'inventory_controller'], 'sensitive', 'Post a warehouse transaction', 'ترحيل حركة مخزنية'),
  W('inventory.warehouse_tx.reverse', 'wf.inventory.warehouse_tx.reverse', 'inventory', ['warehouse_supervisor'], 'sensitive', 'Reverse a warehouse transaction', 'عكس حركة مخزنية'),
  // ── Core ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  W('core.scope.unrestricted', 'wf.core.scope.unrestricted', 'core', [], 'sensitive', 'Unrestricted data scope (all records)', 'نطاق بيانات غير مقيّد (كل السجلات)'),
  // ── Navigation (the sidebar item used to be gated by these role lists) ─────────────────────────────────────────────────────────────────────────
  W('nav.warehouse', 'wf.inventory.nav.warehouse', 'inventory', WH_NAV, 'low', 'See the warehouse screens in the menu', 'إظهار شاشات المخازن في القائمة'),
  W('nav.fulfillment', 'wf.inventory.nav.fulfillment', 'inventory', ['warehouse_worker'], 'low', 'See Fulfilment in the menu', 'إظهار التجهيز في القائمة'),
  W('nav.shipments', 'wf.logistics.nav.shipments', 'logistics', ['driver'], 'low', 'See Shipments in the menu', 'إظهار الشحنات في القائمة'),
  W('nav.shipping_methods', 'wf.logistics.nav.shipping_methods', 'logistics', [], 'low', 'See Shipping methods in the menu', 'إظهار طرق الشحن في القائمة'),
  W('nav.custody_returns', 'wf.logistics.nav.custody_returns', 'logistics', ['warehouse_worker', 'sales_supervisor'], 'low', 'See Custody returns in the menu', 'إظهار مرتجعات العهدة في القائمة'),
  W('nav.collection_settlements', 'wf.logistics.nav.collection_settlements', 'logistics', ['finance'], 'low', 'See Collection settlements in the menu', 'إظهار تسويات التحصيل في القائمة'),
  W('nav.price_lists', 'wf.sales.nav.price_lists', 'sales', ['sales_manager'], 'low', 'See Price lists in the menu', 'إظهار قوائم الأسعار في القائمة'),
  W('nav.bom', 'wf.sales.nav.bom', 'sales', [], 'low', 'See Bills of materials in the menu', 'إظهار قوائم المواد في القائمة'),
];

export const WORKFLOW_RULE_BY_KEY: ReadonlyMap<string, WorkflowRule> = new Map(WORKFLOW_RULES.map((r) => [r.key, r]));
export const WORKFLOW_NODES: readonly string[] = WORKFLOW_RULES.map((r) => r.node);
export const WORKFLOW_RULE_BY_NODE: ReadonlyMap<string, WorkflowRule> = new Map(WORKFLOW_RULES.map((r) => [r.node, r]));

/** The legacy roles that must hold each workflow node after the migration: the call-site list plus the implicit `admin`. */
export function rolesGrantedFor(rule: WorkflowRule): string[] {
  return [...new Set([...rule.legacyRoles, 'admin'])];
}
