import { permissionCatalogNodes, moduleOfNode } from './permission-catalog';
import { nodeRisk, NodeRisk } from './permission-risk';

/**
 * Authorization Foundation F3 — the Permission Catalog with business-language metadata (Blueprint §8). Built ONLY from the existing nodes
 * (`permissionCatalogNodes()`); nothing is renamed and no node is added here. Each node gets its owning module (entitlement), resource, action, risk and a
 * bilingual title so the role editor can show "Post journal / ترحيل قيد اليومية" instead of `accounting.journal.post`.
 *
 * A node at depth 1 is a module-wide grant, depth 2 a resource-wide grant, depth ≥ 3 a single action. The access level (`read-only` | `editable`) is chosen
 * by the editor per node, exactly as the Permission Engine stores it.
 */
export interface CatalogNode {
  node: string;
  /** Owning module for entitlement (`null` = core / always available). */
  module: string | null;
  resource: string | null;
  action: string | null;
  scope: 'module' | 'resource' | 'action';
  risk: NodeRisk;
  titleEn: string;
  titleAr: string;
}

export const MODULE_TITLES: Record<string, [string, string]> = {
  sales: ['المبيعات', 'Sales'],
  inventory: ['المخازن', 'Inventory'],
  logistics: ['الشحن والتوزيع', 'Logistics'],
  finance: ['الخزينة والمالية', 'Finance & Treasury'],
  reporting: ['التقارير', 'Reporting'],
  hr: ['الموارد البشرية', 'Human Resources'],
  accounting: ['المحاسبة', 'Accounting'],
  procurement: ['المشتريات', 'Procurement'],
  manufacturing: ['التصنيع', 'Manufacturing'],
  attendance: ['الحضور والانصراف', 'Attendance'],
  payroll: ['الرواتب', 'Payroll'],
  commission: ['العمولات', 'Commission'],
  targets: ['المستهدفات', 'Targets'],
  core: ['إدارة الشركة', 'Company administration'],
};

const ACTION_TITLES: Record<string, [string, string]> = {
  view: ['عرض', 'View'],
  create: ['إنشاء', 'Create'],
  edit: ['تعديل', 'Edit'],
  delete: ['حذف', 'Delete'],
  approve: ['اعتماد', 'Approve'],
  reject: ['رفض', 'Reject'],
  post: ['ترحيل', 'Post'],
  reverse: ['عكس', 'Reverse'],
  void: ['إبطال', 'Void'],
  cancel: ['إلغاء', 'Cancel'],
  adjust: ['تسوية', 'Adjust'],
  assign: ['إسناد', 'Assign'],
  submit: ['تقديم', 'Submit'],
  release: ['إصدار', 'Release'],
  reopen: ['إعادة فتح', 'Reopen'],
  resolve: ['حلّ', 'Resolve'],
  terminate: ['إنهاء خدمة', 'Terminate'],
  transfer: ['تحويل', 'Transfer'],
  award: ['ترسية', 'Award'],
  complete: ['إتمام', 'Complete'],
  calculate: ['احتساب', 'Calculate'],
  disburse: ['صرف', 'Disburse'],
  export: ['تصدير', 'Export'],
  manage: ['إدارة', 'Manage'],
  hold: ['تعليق', 'Hold'],
  review: ['مراجعة', 'Review'],
  verify: ['تحقق', 'Verify'],
  record_quotation: ['تسجيل عرض سعر', 'Record quotation for'],
  link_user: ['ربط بمستخدم', 'Link a user to'],
  rotate_key: ['تدوير المفتاح', 'Rotate key of'],
  annotate_test_artifact: ['توثيق ملف اختبار', 'Annotate test artifact for'],
  material_issue: ['صرف مواد', 'Issue materials for'],
  material_return: ['إرجاع مواد', 'Return materials for'],
  finished_goods_receive: ['استلام منتج تام', 'Receive finished goods for'],
  operation_execute: ['تنفيذ عملية', 'Execute operation for'],
};

/** Arabic names of resources (English falls back to the humanised key). */
const RESOURCE_AR: Record<string, string> = {
  account: 'الحسابات', ap: 'الموردين (ذمم دائنة)', ar: 'العملاء (ذمم مدينة)', cash: 'النقدية', closing_exception: 'استثناءات الإقفال',
  closing_snapshot: 'لقطات الإقفال', currency: 'العملات', dimension: 'الأبعاد المحاسبية', exchange_rate: 'أسعار الصرف', financial_event: 'الأحداث المالية',
  fiscal_period: 'الفترة المالية', fiscal_year: 'السنة المالية', fixed_asset: 'الأصول الثابتة', grni: 'بضاعة مستلمة غير مفوترة', inventory: 'المخزون',
  journal: 'قيد اليومية', ledger: 'دفتر الأستاذ', report: 'التقارير', tax_code: 'أكواد الضرائب', tax_period: 'الفترة الضريبية', wip: 'الإنتاج تحت التشغيل',
  approval: 'الموافقات', connector: 'موصل الحضور', correction: 'تصحيح الحضور', day: 'يوم الحضور', import: 'استيراد الحضور', manual_entry: 'الإدخال اليدوي',
  mapping: 'ربط الأجهزة', raw_record: 'السجل الخام', adjustment: 'التسويات', batch: 'الدفعة', policy: 'السياسة', result: 'النتيجة', company: 'الشركة',
  invoice: 'الفاتورة', payment: 'الدفعة', treasury: 'الخزينة', department: 'الأقسام', employee: 'الموظف', leave_request: 'طلب الإجازة',
  assembly: 'التجميع', fulfillment: 'التجهيز', movement: 'حركة المخزون', reservation: 'الحجز', stock: 'الرصيد', stock_count: 'الجرد', transaction: 'الحركة',
  valuation: 'تقييم المخزون', warehouse: 'المخزن', carrier: 'شركة الشحن', collection: 'التحصيل', delivery: 'التسليم', return: 'المرتجع', sales_return: 'مرتجع المبيعات',
  shipment: 'الشحنة', shipment_return: 'مرتجع الشحنة', tracking: 'تتبع الشحنة', vehicle: 'المركبة', bom: 'قائمة المواد', routing: 'مسار التصنيع',
  work_center: 'مركز العمل', work_order: 'أمر التشغيل', compensation: 'التعويضات', deduction: 'الاستقطاعات', period: 'فترة الرواتب', run: 'مسير الرواتب',
  bank_account: 'الحساب البنكي', goods_receipt: 'إذن الاستلام', purchase_order: 'أمر الشراء', purchase_request: 'طلب الشراء', rfq: 'طلب عروض الأسعار',
  rfq_award: 'ترسية العروض', supplier: 'المورد', supplier_invoice: 'فاتورة المورد', supplier_payment: 'دفعة المورد', customer_account: 'حسابات العملاء',
  finance: 'المالية', catalog: 'الكتالوج', customer: 'العميل', customer_financial: 'الحالة المالية للعميل', customer_status: 'حالة العميل', deposit: 'العربون',
  order: 'أمر البيع', price_list: 'قائمة الأسعار', rep: 'مندوب المبيعات', target: 'المستهدف', members: 'أعضاء الشركة', roles: 'أدوار الشركة', backup: 'النسخ الاحتياطي',
  audit: 'سجل التدقيق',
};

const humanize = (s: string): string => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const lower = (s: string): string => s.replace(/_/g, ' ');

let cache: readonly CatalogNode[] | null = null;

export function buildCatalog(): readonly CatalogNode[] {
  if (cache) return cache;
  cache = permissionCatalogNodes().map((node): CatalogNode => {
    const parts = node.split('.');
    const module = moduleOfNode(node);
    const mod = MODULE_TITLES[parts[0]] ?? [humanize(parts[0]), humanize(parts[0])];
    if (parts.length === 1) {
      return { node, module, resource: null, action: null, scope: 'module', risk: nodeRisk(node), titleAr: `كل صلاحيات ${mod[0]}`, titleEn: `Everything in ${mod[1]}` };
    }
    const resource = parts[1];
    const resAr = RESOURCE_AR[resource] ?? humanize(resource);
    if (parts.length === 2) {
      return { node, module, resource, action: null, scope: 'resource', risk: nodeRisk(node), titleAr: `كل إجراءات ${resAr} (${mod[0]})`, titleEn: `All ${lower(resource)} actions (${mod[1]})` };
    }
    const action = parts[parts.length - 1];
    const act = ACTION_TITLES[action] ?? [humanize(action), humanize(action)];
    const mid = parts.length > 3 ? `${parts.slice(1, -1).join(' / ')}` : resource;
    return { node, module, resource: mid, action, scope: 'action', risk: nodeRisk(node), titleAr: `${act[0]} ${RESOURCE_AR[mid] ?? resAr}`, titleEn: `${act[1]} ${lower(mid)}` };
  });
  return cache;
}

export function catalogNode(node: string): CatalogNode | undefined {
  return buildCatalog().find((c) => c.node === node);
}
