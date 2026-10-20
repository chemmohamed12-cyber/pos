import type { Lang } from '../context/LanguageContext';
import { FINANCIAL_EVENT_TYPES, humanize, type NamePair } from './displayNames';

/**
 * The reason a Financial Event was rejected is a sentence written by the backend handler, in English, with the event kind in front
 * ("goods_receipt.posted: no GRNI control account in the chart — assign controlFunction "grni" to an account first"). This turns the
 * common kinds of reason into the user's language. A reason that matches no rule keeps its original text, after a translated event
 * name — it is never hidden or guessed.
 */
const pick = (pair: NamePair, lang: Lang) => pair[lang === 'ar' ? 0 : 1];

/**
 * A code (account number, control function …) inside an Arabic sentence: wrapped as a left-to-right isolate so the right-to-left
 * display cannot reorder its characters (4000-A/1 must not read A/1-4000). The characters themselves are unchanged.
 */
const LRI = '\u2066';
const PDI = '\u2069';
const code = (value: string, lang: Lang) => (lang === 'ar' ? `${LRI}${value}${PDI}` : value);

const CONTROL_FUNCTIONS: Record<string, NamePair> = {
  ar: ['العملاء (الذمم المدينة)', 'receivables (AR)'],
  ap: ['الموردين (الذمم الدائنة)', 'payables (AP)'],
  bank: ['البنك', 'bank'],
  cash: ['النقدية', 'cash'],
  grni: ['بضاعة مستلمة غير مفوترة (GRNI)', 'goods received not invoiced (GRNI)'],
  tax_payable: ['الضريبة المستحقة', 'tax payable'],
  inventory: ['المخزون', 'inventory'],
  wip: ['إنتاج تحت التشغيل', 'work in progress'],
};

const FIELDS: Record<string, NamePair> = {
  amount: ['المبلغ', 'amount'],
  netamount: ['صافي المبلغ', 'net amount'],
  kind: ['النوع', 'kind'],
  invoiceid: ['رقم الفاتورة', 'invoice'],
  direction: ['الاتجاه', 'direction'],
  contraaccountcode: ['الحساب المقابل', 'contra account'],
  counteraccountcode: ['الحساب المقابل', 'counter account'],
  clearingaccountcode: ['حساب التسوية', 'clearing account'],
  openingbalanceaccountcode: ['حساب الرصيد الافتتاحي', 'opening-balance account'],
};

const ACCOUNT_ROLES: Record<string, NamePair> = {
  revenue: ['الإيرادات', 'revenue'],
  expense: ['المصروفات', 'expense'],
  income: ['الإيرادات الأخرى', 'income'],
  contra: ['المقابل', 'contra'],
  clearing: ['التسوية', 'clearing'],
  counter: ['المقابل', 'counter'],
};

const ADJUSTMENT_SIDES: Record<string, NamePair> = {
  ar: ['حساب عميل', 'Customer account'],
  ap: ['حساب مورد', 'Supplier account'],
  cash: ['نقدية / بنك', 'Cash / bank'],
};

const ADJUSTMENT_KINDS: Record<string, NamePair> = {
  adjustment: ['تسوية', 'adjustment'],
  write_off: ['شطب', 'write-off'],
  opening_balance: ['رصيد افتتاحي', 'opening balance'],
  credit_note: ['إشعار دائن', 'credit note'],
  debit_note: ['إشعار مدين', 'debit note'],
  reclassification: ['إعادة تصنيف', 'reclassification'],
};

/** The event kind written in front of the reason → a readable name. */
function prefixName(prefix: string, lang: Lang): string {
  const exact = FINANCIAL_EVENT_TYPES[prefix];
  if (exact) return pick(exact, lang);
  const suffixMatch = Object.keys(FINANCIAL_EVENT_TYPES).find((k) => k.endsWith(`.${prefix}`));
  if (suffixMatch) return pick(FINANCIAL_EVENT_TYPES[suffixMatch], lang);
  const adjustment = /^(ar|ap|cash) (adjustment|write_off|opening_balance|credit_note|debit_note|reclassification)/.exec(prefix);
  if (adjustment) {
    const side = ADJUSTMENT_SIDES[adjustment[1]];
    const kind = ADJUSTMENT_KINDS[adjustment[2]];
    return `${pick(side, lang)} — ${kind ? pick(kind, lang) : humanize(adjustment[2])}`;
  }
  return humanize(prefix);
}

function fieldName(raw: string, lang: Lang): string {
  const hit = FIELDS[raw.toLowerCase()];
  return hit ? pick(hit, lang) : humanize(raw);
}

function translateProblem(problem: string, lang: Lang): string | null {
  const ar = lang === 'ar';
  let m: RegExpExecArray | null;

  if ((m = /^no ([\w]+) control account in the chart(?: — assign controlFunction "([\w]+)" to an account first)?/i.exec(problem))) {
    const fn = CONTROL_FUNCTIONS[m[1].toLowerCase()];
    const name = fn ? pick(fn, lang) : humanize(m[1]);
    const hint = m[2] ? (ar ? ` — عيّن وظيفة الرقابة «${code(m[2], lang)}» لأحد الحسابات أولاً` : ` — assign the control function “${m[2]}” to an account first`) : '';
    return (ar ? `لا يوجد حساب رقابة لـ ${name} في دليل الحسابات` : `No ${name} control account in the chart of accounts`) + hint;
  }
  if ((m = /^missing\/invalid ([\w]+)(?: or ([\w]+))?$/i.exec(problem))) {
    const names = [m[1], m[2]].filter(Boolean).map((f) => fieldName(f as string, lang));
    return ar ? `${names.join(' أو ')} ناقص أو غير صالح` : `Missing or invalid ${names.join(' or ')}`;
  }
  if ((m = /^missing ([\w]+)$/i.exec(problem))) {
    return ar ? `${fieldName(m[1], lang)} ناقص` : `Missing ${fieldName(m[1], lang)}`;
  }
  if ((m = /^(?:([a-z]+) )?account "([^"]+)" not found/i.exec(problem)) || (m = /^(?:[a-z_ ]+: )?(?:([a-z]+) )?account "([^"]+)" not found/i.exec(problem))) {
    const role = m[1] && ACCOUNT_ROLES[m[1].toLowerCase()] ? pick(ACCOUNT_ROLES[m[1].toLowerCase()], lang) : '';
    return ar ? `حساب${role ? ` ${role}` : ''} «${code(m[2], lang)}» غير موجود في دليل الحسابات` : `${role ? `${role[0].toUpperCase()}${role.slice(1)} account` : 'Account'} “${m[2]}” not found in the chart of accounts`;
  }
  if ((m = /^an? ([\w]+) is required$/i.exec(problem))) {
    return ar ? `${fieldName(m[1], lang)} مطلوب` : `${fieldName(m[1], lang)} is required`;
  }
  if (/treasury account is not GL-mapped/i.test(problem)) {
    return ar ? 'حساب الخزينة غير مربوط بحساب نشط في دليل الحسابات' : 'The treasury account is not mapped to an active account in the chart of accounts';
  }
  if (/^direction must be "in" or "out"$/i.test(problem)) {
    return ar ? 'الاتجاه يجب أن يكون «وارد» أو «صادر»' : 'Direction must be “in” or “out”';
  }
  return null;
}

/** `null` / empty → an em dash. Otherwise «<event name>: <reason in the user's language>». */
export function translateRejectionReason(reason: string | null | undefined, lang: Lang): string {
  if (!reason) return '—';
  const split = /^([a-z_. ]+?):\s+(.*)$/s.exec(reason);
  if (!split) return translateProblem(reason, lang) ?? reason;
  const [, prefix, problem] = split;
  const translated = translateProblem(problem, lang);
  return `${prefixName(prefix, lang)}: ${translated ?? problem}`;
}
