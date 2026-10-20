/**
 * Plain-language names for the codes the backend sends (event types, source domains, payment methods, statuses, actions …).
 * Same convention as the Approvals page: a small [Arabic, English] table in the front end — no migration, no data change. A code
 * that is not in a table is shown as readable words (never as a raw dotted / snake_case key).
 */
import type { Lang } from '../context/LanguageContext';

export type NamePair = readonly [string, string];
export type NameTable = Readonly<Record<string, NamePair>>;

/** `procurement.goods_receipt.posted` → `Procurement goods receipt posted`; `bank_transfer` → `Bank transfer`. */
export function humanize(code: string): string {
  const words = code.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._\-/]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : code;
}

/** The table's name for `code` in `lang`, else the readable form of the code. Empty / missing → an em dash. */
export function nameOf(table: NameTable, code: string | null | undefined, lang: Lang): string {
  if (code === null || code === undefined || code === '') return '—';
  const hit = table[code] ?? table[code.toLowerCase()];
  return hit ? hit[lang === 'ar' ? 0 : 1] : humanize(code);
}

/** The language the user chose (the same key the language switch writes) — for helpers used outside a component. */
export function currentLang(): Lang {
  try {
    return localStorage.getItem('daii_lang') === 'en' ? 'en' : 'ar';
  } catch {
    return 'ar';
  }
}

export const SOURCE_DOMAINS: NameTable = {
  finance: ['المالية', 'Finance'],
  treasury: ['الخزينة', 'Treasury'],
  'deposit-control': ['العرابين', 'Deposits'],
  delivery: ['التوصيل والتحصيل', 'Delivery and collections'],
  returns: ['المرتجعات', 'Returns'],
  inventory: ['المخزون', 'Inventory'],
  manufacturing: ['التصنيع', 'Manufacturing'],
  accounting: ['المحاسبة', 'Accounting'],
  payroll: ['الرواتب', 'Payroll'],
  procurement: ['المشتريات', 'Procurement'],
  customer: ['العملاء', 'Customers'],
  collection: ['التحصيل', 'Collections'],
  deposit: ['العرابين', 'Deposits'],
  return: ['المرتجعات', 'Returns'],
  unknown: ['غير محدد', 'Unspecified'],
};

export const FINANCIAL_EVENT_TYPES: NameTable = {
  'finance.invoice.posted': ['ترحيل فاتورة بيع', 'Sales invoice posted'],
  'finance.invoice.voided': ['إلغاء فاتورة بيع', 'Sales invoice voided'],
  'finance.payment.recorded': ['تسجيل دفعة من عميل', 'Customer payment recorded'],
  'finance.supplier_invoice.posted': ['ترحيل فاتورة مورد', 'Supplier invoice posted'],
  'finance.supplier_invoice.voided': ['إلغاء فاتورة مورد', 'Supplier invoice voided'],
  'finance.supplier_payment.recorded': ['تسجيل دفعة لمورد', 'Supplier payment recorded'],
  'finance.credit_note.issued': ['إصدار إشعار دائن', 'Credit note issued'],
  'finance.debit_note.issued': ['إصدار إشعار مدين', 'Debit note issued'],
  'finance.supplier_credit_note.received': ['استلام إشعار دائن من مورد', 'Supplier credit note received'],
  'finance.supplier_debit_note.issued': ['إصدار إشعار مدين لمورد', 'Supplier debit note issued'],
  'treasury.cash.recorded': ['حركة نقدية', 'Cash movement recorded'],
  'treasury.transfer.completed': ['تحويل بين حسابات الخزينة', 'Treasury transfer completed'],
  'deposit.verified': ['تأكيد عربون', 'Deposit verified'],
  'collection.recorded': ['تسجيل تحصيل', 'Collection recorded'],
  'collection.remitted': ['توريد تحصيل', 'Collection remitted'],
  'return.completed': ['اكتمال مرتجع', 'Return completed'],
  'returns.sale_return.credited': ['قيد مرتجع مبيعات', 'Sales return credited'],
  'inventory.movement.recorded': ['حركة مخزون', 'Inventory movement recorded'],
  'manufacturing.work_order.material_issued': ['صرف خامات لأمر تشغيل', 'Work order materials issued'],
  'manufacturing.work_order.material_returned': ['إرجاع خامات من أمر تشغيل', 'Work order materials returned'],
  'manufacturing.work_order.finished_goods_received': ['استلام منتج تام من أمر تشغيل', 'Work order finished goods received'],
  'customer.refund.adjusted': ['تسوية استرداد لعميل', 'Customer refund adjusted'],
  'accounting.ar.adjustment.approved': ['اعتماد تسوية حساب عميل', 'Receivable adjustment approved'],
  'accounting.ap.adjustment.approved': ['اعتماد تسوية حساب مورد', 'Payable adjustment approved'],
  'accounting.cash.adjustment.approved': ['اعتماد تسوية نقدية أو بنكية', 'Cash / bank adjustment approved'],
  'accounting.financial_event.posted': ['ترحيل حدث مالي', 'Financial event posted'],
  'accounting.financial_event.rejected': ['رفض حدث مالي', 'Financial event rejected'],
  'payroll.run.posted': ['ترحيل مسير رواتب', 'Payroll run posted'],
  'procurement.goods_receipt.posted': ['ترحيل استلام بضاعة', 'Goods receipt posted'],
};

/** Status words that appear in many tables (party status, statement rows, ledger entries, policies, integrations …). */
export const STATUS_NAMES: NameTable = {
  pending: ['قيد الانتظار', 'Pending'],
  active: ['نشط', 'Active'],
  inactive: ['غير نشط', 'Inactive'],
  suspended: ['موقوف', 'Suspended'],
  blocked: ['محظور', 'Blocked'],
  draft: ['مسودة', 'Draft'],
  open: ['مفتوح', 'Open'],
  closed: ['مغلق', 'Closed'],
  posted: ['مرحّل', 'Posted'],
  paid: ['مدفوع', 'Paid'],
  partially_paid: ['مدفوع جزئياً', 'Partially paid'],
  unpaid: ['غير مدفوع', 'Unpaid'],
  overdue: ['متأخر', 'Overdue'],
  approved: ['معتمد', 'Approved'],
  rejected: ['مرفوض', 'Rejected'],
  cancelled: ['ملغى', 'Cancelled'],
  voided: ['ملغى', 'Voided'],
  void: ['ملغى', 'Void'],
  reversed: ['معكوس', 'Reversed'],
  superseded: ['مستبدل', 'Superseded'],
  success: ['نجاح', 'Success'],
  failed: ['فشل', 'Failed'],
  withdrawn: ['مسحوب', 'Withdrawn'],
  expired: ['منتهي', 'Expired'],
  released: ['مُفرج عنه', 'Released'],
  reserved: ['محجوز', 'Reserved'],
  consumed: ['مستهلك', 'Consumed'],
  completed: ['مكتمل', 'Completed'],
  // company membership status (upper case on the wire)
  ready: ['جاهزة', 'Ready'],
  provisioning: ['قيد التجهيز', 'Provisioning'],
};

export const PAYMENT_METHODS: NameTable = {
  cash: ['نقداً', 'Cash'],
  bank_transfer: ['تحويل بنكي', 'Bank transfer'],
  transfer: ['تحويل', 'Transfer'],
  cheque: ['شيك', 'Cheque'],
  check: ['شيك', 'Cheque'],
  card: ['بطاقة', 'Card'],
  credit_card: ['بطاقة ائتمان', 'Credit card'],
  wallet: ['محفظة إلكترونية', 'E-wallet'],
  on_account: ['على الحساب', 'On account'],
  deposit: ['من العربون', 'From deposit'],
  other: ['أخرى', 'Other'],
};

export const DIRECTIONS: NameTable = {
  inbound: ['وارد', 'Inbound'],
  outbound: ['صادر', 'Outbound'],
  in: ['وارد', 'In'],
  out: ['صادر', 'Out'],
};

/** Integration log event types, shipment tracking events and work-order / audit actions. */
export const EVENT_AND_ACTION_NAMES: NameTable = {
  'order.received': ['استلام طلب', 'Order received'],
  'order.created': ['إنشاء طلب', 'Order created'],
  'order.updated': ['تعديل طلب', 'Order updated'],
  'order.cancelled': ['إلغاء طلب', 'Order cancelled'],
  'product.created': ['إنشاء صنف', 'Product created'],
  'product.published': ['نشر صنف', 'Product published'],
  'product.updated': ['تعديل صنف', 'Product updated'],
  created: ['تم الإنشاء', 'Created'],
  assigned: ['تم التعيين', 'Assigned'],
  picked_up: ['تم الاستلام من المخزن', 'Picked up'],
  dispatched: ['تم الشحن', 'Dispatched'],
  in_transit: ['في الطريق', 'In transit'],
  out_for_delivery: ['خرجت للتسليم', 'Out for delivery'],
  delivered: ['تم التسليم', 'Delivered'],
  delivery_failed: ['فشل التسليم', 'Delivery failed'],
  failed_delivery: ['فشل التسليم', 'Delivery failed'],
  returned: ['تم الإرجاع', 'Returned'],
  handed_over: ['تم التسليم للمندوب', 'Handed over'],
  begin_production: ['بدء الإنتاج', 'Production started'],
  start: ['بدء', 'Started'],
  hold: ['إيقاف مؤقت', 'Put on hold'],
  resume: ['استئناف', 'Resumed'],
  complete: ['إكمال', 'Completed'],
  cancel: ['إلغاء', 'Cancelled'],
  release: ['إطلاق', 'Released'],
  'manufacturing.work_order.cancelled': ['إلغاء أمر تشغيل', 'Work order cancelled'],
  'manufacturing.work_order.completed': ['إكمال أمر تشغيل', 'Work order completed'],
  'manufacturing.work_order.released': ['إطلاق أمر تشغيل', 'Work order released'],
  'manufacturing.work_order.started': ['بدء أمر تشغيل', 'Work order started'],
  'manufacturing.work_order.held': ['إيقاف أمر تشغيل مؤقتاً', 'Work order put on hold'],
  ...FINANCIAL_EVENT_TYPES,
};

/** Organisation unit types shown next to a unit's name. */
export const ORG_UNIT_TYPES: NameTable = {
  company: ['شركة', 'Company'],
  branch: ['فرع', 'Branch'],
  department: ['قسم', 'Department'],
  division: ['قطاع', 'Division'],
  warehouse: ['مخزن', 'Warehouse'],
  team: ['فريق', 'Team'],
  cost_center: ['مركز تكلفة', 'Cost centre'],
  site: ['موقع', 'Site'],
};

/** The source domain to show for an event: the stored one, or — when it is `unknown` — the first part of the event type. */
export function sourceDomainOf(sourceDomain: string, eventType: string): string {
  return sourceDomain && sourceDomain !== 'unknown' ? sourceDomain : eventType.split('.')[0] || 'unknown';
}

/** «Loading…» in the language the user chose (screens show it while their data loads). */
export function loadingLabel(): string {
  return currentLang() === 'ar' ? 'جارٍ التحميل…' : 'Loading…';
}
