import { useLanguage } from '../../context/LanguageContext';

/** T4 — the Treasury workspace speaks both languages inline (no terminology rows are required for it to read correctly on an environment that has not been migrated yet). */
export function useTr(): (ar: string, en: string) => string {
  const { lang } = useLanguage();
  return (ar, en) => (lang === 'ar' ? ar : en);
}

export type DocStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'executed' | 'reversed' | 'cancelled';
export type DocKind = 'customer_collection' | 'transfer' | 'misc_receipt' | 'disbursement';

export interface TreasuryDocumentRow {
  id: string;
  documentNumber: string;
  kind: DocKind;
  subtype: string | null;
  status: DocStatus;
  businessDate: string;
  amount: string;
  treasuryAccountId: string;
  counterTreasuryAccountId: string | null;
  customerId: string | null;
  method: string | null;
  reasonCode: string | null;
  reference: string | null;
  purpose: string | null;
  unappliedAmount: string;
  approvalRequestId: string | null;
  autoApproved: boolean;
  createdByUserId: string;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  rejectionNote: string | null;
  executedAt: string | null;
  executedByUserId: string | null;
  executedTransactionId: string | null;
  executedPaymentId: string | null;
  reversedAt: string | null;
  reversedByUserId: string | null;
  reversalReason: string | null;
  cancelReason: string | null;
  version: number;
  createdAt: string;
  allocations?: Array<{ id: string; invoiceId: string; invoiceNumber?: string | null; amount: string }>;
  settlement?: { state: 'not_executed' | 'unsettled' | 'matched'; statementNumber?: string; lineNumber?: number };
}

const KIND_LABEL: Record<DocKind, [string, string]> = {
  customer_collection: ['تحصيل من عميل', 'Customer collection'],
  transfer: ['تحويل بين الحسابات', 'Transfer between accounts'],
  misc_receipt: ['استلام نقدي متنوع', 'Miscellaneous receipt'],
  disbursement: ['صرف نقدي', 'Disbursement'],
};
const SUBTYPE_LABEL: Record<string, [string, string]> = {
  account_transfer: ['تحويل بين حسابين', 'Account transfer'],
  bank_deposit: ['إيداع نقدية في البنك', 'Deposit cash into bank'],
  bank_withdrawal: ['سحب نقدية من البنك', 'Withdraw cash from bank'],
};
const STATUS_LABEL: Record<DocStatus, [string, string, 'positive' | 'warning' | 'negative' | '']> = {
  draft: ['مسودة', 'Draft', ''],
  submitted: ['بانتظار الاعتماد', 'Awaiting approval', 'warning'],
  approved: ['معتمد — لم يُنفَّذ', 'Approved — not executed', 'warning'],
  rejected: ['مرفوض', 'Rejected', 'negative'],
  executed: ['منفّذ', 'Executed', 'positive'],
  reversed: ['معكوس', 'Reversed', 'negative'],
  cancelled: ['ملغى', 'Cancelled', 'negative'],
};

export function kindLabel(tr: (a: string, e: string) => string, kind: DocKind, subtype?: string | null): string {
  if (kind === 'transfer' && subtype && SUBTYPE_LABEL[subtype]) return tr(...SUBTYPE_LABEL[subtype]);
  return tr(...KIND_LABEL[kind]);
}

export function DocStatusBadge({ status }: { status: DocStatus }) {
  const tr = useTr();
  const [ar, en, tone] = STATUS_LABEL[status];
  return <span className={`status-badge ${tone}`}>{tr(ar, en)}</span>;
}

export function money(v: string | number): string {
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
