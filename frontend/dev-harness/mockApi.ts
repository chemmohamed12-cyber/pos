/* Harness stub of `lib/api`: an in-memory Treasury API with the SAME response shapes the real endpoints return (taken from the real-PostgreSQL HTTP spec). It models status
   changes only (draft → submitted → approved → executed → reversed); it contains none of the business rules — those are proven by the real-PG specs. */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function newIdempotencyKey(): string {
  return `k-${Math.random().toString(36).slice(2)}`;
}
export function setAccessToken() {}
export function setUnauthorizedHandler() {}

type Doc = Record<string, unknown> & { id: string; status: string; version: number };
const now = () => new Date().toISOString();
const today = new Date().toISOString().slice(0, 10);
const accounts = [
  { id: 'a-cash', code: 'CASH-MAIN', name: 'الخزينة الرئيسية', status: 'active', balance: '12500.00', accountTypeId: 't-cash', glAccountCode: '1101' },
  { id: 'a-bank', code: 'BANK-NBE', name: 'البنك الأهلي', status: 'active', balance: '48200.50', accountTypeId: 't-bank', glAccountCode: '1102' },
  { id: 'a-bank2', code: 'BANK-CIB', name: 'بنك CIB', status: 'active', balance: '0.00', accountTypeId: 't-bank', glAccountCode: '1103' },
  { id: 'a-new', code: 'WALLET-1', name: 'محفظة جديدة', status: 'active', balance: '300.00', accountTypeId: 't-cash', glAccountCode: null },
];
const types = [
  { id: 't-cash', code: 'cash' },
  { id: 't-bank', code: 'bank' },
];
const customers = [
  { id: 'c-1', code: 'CUST-001', name: 'شركة النيل' },
  { id: 'c-2', code: 'CUST-002', name: 'Delta Trading' },
];
const invoices: Record<string, Array<{ id: string; invoiceNumber: string; remaining: string; state: string }>> = {
  'c-1': [
    { id: 'i-1', invoiceNumber: 'INV-2026-000101', remaining: '500.00', state: 'posted' },
    { id: 'i-2', invoiceNumber: 'INV-2026-000102', remaining: '400.00', state: 'partially_paid' },
  ],
  'c-2': [],
};
let seq = 3;
const base = (over: Partial<Doc>): Doc => ({
  id: '', documentNumber: '', kind: 'misc_receipt', subtype: null, status: 'draft', businessDate: today, amount: '0.00', treasuryAccountId: 'a-cash', counterTreasuryAccountId: null, customerId: null, method: null,
  reasonCode: null, reference: null, purpose: null, unappliedAmount: '0.00', approvalRequestId: null, autoApproved: false, createdByUserId: 'u-prep', submittedAt: null, approvedAt: null, approvedByUserId: null,
  rejectionNote: null, executedAt: null, executedByUserId: null, executedTransactionId: null, executedPaymentId: null, reversedAt: null, reversedByUserId: null, reversalReason: null, cancelReason: null,
  version: 1, createdAt: now(), allocations: [], ...over,
});
const docs: Doc[] = [
  base({ id: 'd-1', documentNumber: 'TD-2026-000001', kind: 'customer_collection', status: 'submitted', amount: '750.00', customerId: 'c-1', treasuryAccountId: 'a-bank', method: 'bank_transfer', reference: 'CHQ-77', purpose: 'Settlement', unappliedAmount: '50.00', version: 2, allocations: [{ id: 'al-1', invoiceId: 'i-1', invoiceNumber: 'INV-2026-000101', amount: '300.00' }, { id: 'al-2', invoiceId: 'i-2', invoiceNumber: 'INV-2026-000102', amount: '400.00' }] }),
  base({ id: 'd-2', documentNumber: 'TD-2026-000002', kind: 'transfer', subtype: 'bank_deposit', status: 'approved', amount: '5000.00', treasuryAccountId: 'a-cash', counterTreasuryAccountId: 'a-bank', reference: 'DEP-9', purpose: 'Deposit takings', version: 3, approvedAt: now(), approvedByUserId: 'u-appr' }),
  base({ id: 'd-3', documentNumber: 'TD-2026-000003', kind: 'disbursement', status: 'executed', amount: '120.00', reasonCode: 'MISC_EXPENSE', reference: 'EXP-9', purpose: 'Office supplies', version: 4, approvedAt: now(), approvedByUserId: 'u-appr', executedAt: now(), executedByUserId: 'u-exec', executedTransactionId: 'tx-1' }),
];

const mode = () => localStorage.getItem('harness_mode') ?? 'ok';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function view(d: Doc) {
  return JSON.parse(JSON.stringify(d));
}
function find(id: string): Doc {
  const d = docs.find((x) => x.id === id);
  if (!d) throw new ApiError(404, 'NOT_FOUND', 'Treasury document not found.');
  return d;
}
function actor(): string {
  try {
    return JSON.parse(localStorage.getItem('harness_uid') ?? '"u-admin"') as string;
  } catch {
    return 'u-admin';
  }
}
function bump(d: Doc, over: Partial<Doc>) {
  Object.assign(d, over, { version: d.version + 1 });
  return view(d);
}

async function handle(method: string, path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const [p, qs] = path.split('?');
  const q = new URLSearchParams(qs ?? '');
  let m: RegExpMatchArray | null;
  if (p === '/treasury/accounts') return accounts;
  if (p === '/treasury/account-types') return types;
  if (p === '/customers') return customers;
  if (p === '/treasury/documents/reason-codes') return { receipt: ['OTHER_INCOME', 'SCRAP_SALE'], disbursement: ['MISC_EXPENSE'] };
  if (p === '/accounting/cash-bank/posting-exceptions') {
    return {
      total: 2,
      totalAmount: '222.00',
      byCause: { REJECTED: { count: 2, amount: '222.00' } },
      deferredByPolicy: { payrollLegs: 0, codCustodyLegs: 0 },
      rows: [
        { transactionNumber: 'TRS-IN-2026-000034', amount: '200.00', accountCode: 'M0001', cause: 'REJECTED', reason: 'cash.recorded: no counterAccountCode and the clearing account is unset', ageDays: 3 },
        { transactionNumber: 'TRS-IN-2026-000030', amount: '22.00', accountCode: 'M0001', cause: 'REJECTED', reason: 'deposit.verified: treasury account is not GL-mapped', ageDays: 5 },
      ],
    };
  }
  if ((m = p.match(/^\/treasury\/documents\/customers\/([^/]+)\/open-invoices$/))) return invoices[m[1]] ?? [];
  if (p === '/treasury/documents' && method === 'GET') {
    const st = q.get('status');
    return docs.filter((d) => !st || d.status === st).map(view);
  }
  if (p === '/treasury/documents' && method === 'POST') {
    const kind = String(body.kind);
    const allocations = ((body.allocations as Array<{ invoiceId: string; amount: string }>) ?? []).map((a, i) => ({ id: `al-n${seq}-${i}`, ...a }));
    const total = kind === 'customer_collection' ? allocations.reduce((s, a) => s + Number(a.amount), 0) + Number(body.unappliedAmount ?? 0) : Number(body.amount);
    if (!(total > 0)) throw new ApiError(400, 'VALIDATION_ERROR', 'A positive amount with at most two decimals is required.');
    seq += 1;
    const d = base({
      id: `d-${seq}`, documentNumber: `TD-2026-${String(seq).padStart(6, '0')}`, kind: kind as never, subtype: (body.subtype as string) ?? null, amount: total.toFixed(2),
      treasuryAccountId: String(body.treasuryAccountId), counterTreasuryAccountId: (body.counterTreasuryAccountId as string) ?? null, customerId: (body.customerId as string) ?? null,
      method: (body.method as string) ?? null, reasonCode: (body.reasonCode as string) ?? null, reference: (body.reference as string) ?? null, purpose: (body.purpose as string) ?? null,
      unappliedAmount: String(body.unappliedAmount ?? '0.00'), createdByUserId: actor(), allocations,
    });
    docs.unshift(d);
    return view(d);
  }
  if ((m = p.match(/^\/treasury\/documents\/([^/]+)\/(effect|submit|decide|execute|cancel|reverse)$/))) {
    const d = find(m[1]);
    const act = m[2];
    if (act === 'effect') {
      return {
        documentId: d.id,
        note: 'Harness effect preview (the real one is computed by the server).',
        lines:
          d.kind === 'customer_collection'
            ? [{ side: 'debit', role: 'Receiving cash / bank account', glAccountCode: '1102' }, { side: 'credit', role: 'Accounts receivable (control)', glAccountCode: null }]
            : [{ side: 'debit', role: 'Destination / counter account', glAccountCode: '1102' }, { side: 'credit', role: 'Source / counter account', glAccountCode: '1101' }],
      };
    }
    if (act === 'submit') {
      if (d.status !== 'draft') throw new ApiError(409, 'CONFLICT', `A document in status "${d.status}" cannot be submitted.`);
      return bump(d, { status: 'submitted', submittedAt: now(), approvalRequestId: 'ar-1' });
    }
    if (act === 'decide') {
      if (d.createdByUserId === actor()) throw new ApiError(403, 'FORBIDDEN', 'The maker of an approval request cannot approve or reject it (segregation of duties).');
      return body.decision === 'approved' ? bump(d, { status: 'approved', approvedAt: now(), approvedByUserId: actor() }) : bump(d, { status: 'rejected', rejectionNote: (body.note as string) ?? null });
    }
    if (act === 'execute') {
      if (d.status !== 'approved') throw new ApiError(409, 'CONFLICT', `Only an approved document can be executed — this one is "${d.status}".`);
      return bump(d, { status: 'executed', executedAt: now(), executedByUserId: actor(), executedTransactionId: 'tx-n' });
    }
    if (act === 'cancel') return bump(d, { status: 'cancelled', cancelReason: String(body.reason) });
    if (act === 'reverse') return bump(d, { status: 'reversed', reversedAt: now(), reversedByUserId: actor(), reversalReason: String(body.reason) });
  }
  if ((m = p.match(/^\/treasury\/documents\/([^/]+)$/)) && method === 'GET') return view(find(m[1]));
  if ((m = p.match(/^\/treasury\/documents\/([^/]+)$/)) && method === 'PUT') {
    const d = find(m[1]);
    return bump(d, { amount: String(body.amount ?? d.amount), reference: (body.reference as string) ?? d.reference, purpose: (body.purpose as string) ?? d.purpose });
  }
  throw new ApiError(404, 'NOT_FOUND', `Harness has no route for ${method} ${p}`);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const md = mode();
  await wait(md === 'slow' ? 2500 : 120);
  if (md === 'error') throw new ApiError(500, 'INTERNAL_ERROR', 'Simulated server failure (harness mode = error).');
  if (md === 'network') throw new TypeError('Failed to fetch');
  if (md === 'empty' && method === 'GET' && path.startsWith('/treasury/documents') && !path.includes('reason-codes') && !path.includes('open-invoices')) return [] as T;
  return (await handle(method, path, body as Record<string, unknown>)) as T;
}
export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body),
  delete: <T>(path: string) => call<T>('DELETE', path),
};
