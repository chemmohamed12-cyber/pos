import { GLAccountType } from '../gl-account-type';
import { ControlFunction } from '../control-function';

/**
 * F02 — Chart of Accounts (Blueprint §3.3, ADR-034 D2). One opt-in
 * starter chart (CTO decision, 2026-09-10: exactly one, opt-in, editable).
 *
 * This is **data, not business logic** — no code anywhere assumes any of
 * these codes exist. It is importable only into an EMPTY chart, via an
 * explicit `POST /accounting/chart/import-template` call, and the customer
 * owns every row the moment it lands (rename / re-code / deactivate /
 * delete-by-deactivate all free afterwards). Shipping it saves a new
 * installation from hand-building ~45 accounts; it is never a product
 * opinion forced on anyone.
 *
 * Rows are ordered parents-before-children so the importer can resolve
 * `parentCode` in a single pass.
 */
export interface AccountTemplateEntry {
  code: string;
  nameEn: string;
  nameAr: string;
  accountType: GLAccountType;
  /** default true; false = header/summary node */
  isPostable?: boolean;
  parentCode?: string;
  isContra?: boolean;
  controlFunction?: ControlFunction;
}

export interface AccountTemplate {
  key: string;
  titleEn: string;
  titleAr: string;
  description: string;
  accounts: readonly AccountTemplateEntry[];
}

export const IFRS_SME_TEMPLATE: AccountTemplate = {
  key: 'ifrs-sme',
  titleEn: 'IFRS for SMEs — Starter Chart',
  titleAr: 'دليل حسابات مبدئي — المعايير الدولية للمنشآت الصغيرة والمتوسطة',
  description:
    'A compact IFRS-for-SMEs-style starter chart (~45 accounts) covering the common asset, liability, equity, revenue and expense accounts a small or medium business needs on day one. Every account is editable after import.',
  accounts: [
    // 1 — Assets
    { code: '1', nameEn: 'Assets', nameAr: 'الأصول', accountType: 'asset', isPostable: false },
    { code: '11', nameEn: 'Current Assets', nameAr: 'الأصول المتداولة', accountType: 'asset', isPostable: false, parentCode: '1' },
    { code: '1101', nameEn: 'Cash on Hand', nameAr: 'النقدية بالصندوق', accountType: 'asset', parentCode: '11', controlFunction: 'bank' },
    { code: '1102', nameEn: 'Bank — Current Account', nameAr: 'البنك — الحساب الجاري', accountType: 'asset', parentCode: '11', controlFunction: 'bank' },
    { code: '1110', nameEn: 'Accounts Receivable', nameAr: 'العملاء (المدينون)', accountType: 'asset', parentCode: '11', controlFunction: 'ar' },
    { code: '1120', nameEn: 'Inventory', nameAr: 'المخزون', accountType: 'asset', parentCode: '11', controlFunction: 'inventory' },
    { code: '1130', nameEn: 'Prepaid Expenses', nameAr: 'مصروفات مدفوعة مقدمًا', accountType: 'asset', parentCode: '11' },
    { code: '1140', nameEn: 'Input VAT / Recoverable Tax', nameAr: 'ضريبة القيمة المضافة — المشتريات', accountType: 'asset', parentCode: '11', controlFunction: 'tax_receivable' },
    // ADR-061 (Manufacturing) — the account every Work Order Financial Event reclassifies Inventory into/out of
    // (Dr WIP / Cr Inventory on issue; Dr Inventory / Cr WIP on return and finished-goods output). Always present,
    // even for a Company with no Manufacturing entitlement: an unused zero-balance asset control account is inert
    // (WIP reconciliation reports `no_subledger_source` with or without it), whereas omitting it makes the first
    // Manufacturing event of an entitled Company REJECT until someone hand-assigns one (handoff H2).
    { code: '1150', nameEn: 'Work in Process', nameAr: 'إنتاج تحت التشغيل', accountType: 'asset', parentCode: '11', controlFunction: 'wip' },
    { code: '12', nameEn: 'Non-Current Assets', nameAr: 'الأصول غير المتداولة', accountType: 'asset', isPostable: false, parentCode: '1' },
    { code: '1201', nameEn: 'Property, Plant & Equipment', nameAr: 'الممتلكات والآلات والمعدات', accountType: 'asset', parentCode: '12' },
    { code: '1202', nameEn: 'Accumulated Depreciation', nameAr: 'مجمع الإهلاك', accountType: 'asset', parentCode: '12', isContra: true },
    { code: '1210', nameEn: 'Intangible Assets', nameAr: 'الأصول غير الملموسة', accountType: 'asset', parentCode: '12' },

    // 2 — Liabilities
    { code: '2', nameEn: 'Liabilities', nameAr: 'الالتزامات', accountType: 'liability', isPostable: false },
    { code: '21', nameEn: 'Current Liabilities', nameAr: 'الالتزامات المتداولة', accountType: 'liability', isPostable: false, parentCode: '2' },
    { code: '2101', nameEn: 'Accounts Payable', nameAr: 'الموردون (الدائنون)', accountType: 'liability', parentCode: '21', controlFunction: 'ap' },
    { code: '2110', nameEn: 'Accrued Expenses', nameAr: 'مصروفات مستحقة', accountType: 'liability', parentCode: '21' },
    { code: '2120', nameEn: 'Output VAT / Tax Payable', nameAr: 'ضريبة القيمة المضافة — المبيعات', accountType: 'liability', parentCode: '21', controlFunction: 'tax_payable' },
    { code: '2130', nameEn: 'Short-Term Loans', nameAr: 'قروض قصيرة الأجل', accountType: 'liability', parentCode: '21' },
    { code: '2150', nameEn: 'Wages Payable', nameAr: 'رواتب وأجور مستحقة', accountType: 'liability', parentCode: '21', controlFunction: 'wages_payable' },
    { code: '22', nameEn: 'Non-Current Liabilities', nameAr: 'الالتزامات غير المتداولة', accountType: 'liability', isPostable: false, parentCode: '2' },
    { code: '2201', nameEn: 'Long-Term Loans', nameAr: 'قروض طويلة الأجل', accountType: 'liability', parentCode: '22' },

    // 3 — Equity
    { code: '3', nameEn: 'Equity', nameAr: 'حقوق الملكية', accountType: 'equity', isPostable: false },
    { code: '3101', nameEn: 'Share Capital', nameAr: 'رأس المال', accountType: 'equity', parentCode: '3' },
    { code: '3102', nameEn: 'Retained Earnings', nameAr: 'الأرباح المحتجزة', accountType: 'equity', parentCode: '3', controlFunction: 'retained_earnings' },
    { code: '3103', nameEn: 'Current Year Result', nameAr: 'نتيجة العام الحالي', accountType: 'equity', parentCode: '3' },
    { code: '3110', nameEn: 'Owner Drawings', nameAr: 'مسحوبات المالك', accountType: 'equity', parentCode: '3', isContra: true },

    // 4 — Revenue
    { code: '4', nameEn: 'Revenue', nameAr: 'الإيرادات', accountType: 'revenue', isPostable: false },
    { code: '4101', nameEn: 'Sales Revenue', nameAr: 'إيرادات المبيعات', accountType: 'revenue', parentCode: '4' },
    { code: '4102', nameEn: 'Service Revenue', nameAr: 'إيرادات الخدمات', accountType: 'revenue', parentCode: '4' },
    { code: '4110', nameEn: 'Sales Returns & Allowances', nameAr: 'مردودات ومسموحات المبيعات', accountType: 'revenue', parentCode: '4', isContra: true },
    { code: '4120', nameEn: 'Sales Discounts', nameAr: 'خصومات المبيعات', accountType: 'revenue', parentCode: '4', isContra: true },
    { code: '4900', nameEn: 'Other Income', nameAr: 'إيرادات أخرى', accountType: 'revenue', parentCode: '4' },
    { code: '4910', nameEn: 'Foreign Exchange Gain / (Loss)', nameAr: 'أرباح / (خسائر) فروق العملة', accountType: 'revenue', parentCode: '4', controlFunction: 'fx_gain_loss' },

    // 5 — Expenses
    { code: '5', nameEn: 'Expenses', nameAr: 'المصروفات', accountType: 'expense', isPostable: false },
    { code: '51', nameEn: 'Cost of Sales', nameAr: 'تكلفة المبيعات', accountType: 'expense', isPostable: false, parentCode: '5' },
    { code: '5101', nameEn: 'Cost of Goods Sold', nameAr: 'تكلفة البضاعة المباعة', accountType: 'expense', parentCode: '51' },
    { code: '5110', nameEn: 'Freight In', nameAr: 'مصروفات نقل المشتريات', accountType: 'expense', parentCode: '51' },
    { code: '52', nameEn: 'Operating Expenses', nameAr: 'المصروفات التشغيلية', accountType: 'expense', isPostable: false, parentCode: '5' },
    { code: '5201', nameEn: 'Salaries & Wages', nameAr: 'الرواتب والأجور', accountType: 'expense', parentCode: '52' },
    { code: '5202', nameEn: 'Rent Expense', nameAr: 'مصروف الإيجار', accountType: 'expense', parentCode: '52' },
    { code: '5203', nameEn: 'Utilities', nameAr: 'مصروفات المرافق', accountType: 'expense', parentCode: '52' },
    { code: '5204', nameEn: 'Depreciation Expense', nameAr: 'مصروف الإهلاك', accountType: 'expense', parentCode: '52' },
    { code: '5205', nameEn: 'Marketing & Advertising', nameAr: 'التسويق والإعلان', accountType: 'expense', parentCode: '52' },
    { code: '5206', nameEn: 'Office Supplies', nameAr: 'أدوات ومستلزمات مكتبية', accountType: 'expense', parentCode: '52' },
    { code: '5207', nameEn: 'Professional Fees', nameAr: 'أتعاب مهنية', accountType: 'expense', parentCode: '52' },
    { code: '5208', nameEn: 'Bank Charges', nameAr: 'مصروفات بنكية', accountType: 'expense', parentCode: '52' },
    { code: '5299', nameEn: 'Miscellaneous Expense', nameAr: 'مصروفات متنوعة', accountType: 'expense', parentCode: '52' },
    { code: '59', nameEn: 'Other Expenses', nameAr: 'المصروفات الأخرى', accountType: 'expense', isPostable: false, parentCode: '5' },
    { code: '5901', nameEn: 'Rounding Differences', nameAr: 'فروق التقريب', accountType: 'expense', parentCode: '59', controlFunction: 'rounding' },
    { code: '5902', nameEn: 'Interest Expense', nameAr: 'مصروف الفوائد', accountType: 'expense', parentCode: '59' },
  ],
};

export const ACCOUNT_TEMPLATES: readonly AccountTemplate[] = [IFRS_SME_TEMPLATE];

export function getAccountTemplate(key: string): AccountTemplate | undefined {
  return ACCOUNT_TEMPLATES.find((t) => t.key === key);
}
