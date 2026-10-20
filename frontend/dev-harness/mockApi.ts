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


// ---------------------------------------------------------------- T5 mock state (statuses only; the real rules are proven by the real-PostgreSQL specs)
type Line = { id: string; lineNumber: number; valueDate: string; description: string | null; reference: string | null; amount: string; status: string; possibleDuplicate: boolean; suggestion: unknown; matches: unknown[] };
type Stmt = { id: string; systemNumber: string; statementNumber: string | null; treasuryAccountId: string; periodStart: string; periodEnd: string; openingBalance: string; closingBalance: string; status: string; lineCount: number; lines: Line[] };
const ln = (n: number, amount: string, reference: string, description: string, status = 'unmatched', suggestion: unknown = null): Line => ({ id: `l-${n}`, lineNumber: n, valueDate: today, description, reference, amount, status, possibleDuplicate: false, suggestion, matches: status === 'matched' ? [{ id: `m-${n}`, treasuryTransactionId: `t-${n}` }] : [] });
const statements: Stmt[] = [
  { id: 's-1', systemNumber: 'BST-2026-000001', statementNumber: 'OCT-1', treasuryAccountId: 'a-bank', periodStart: today, periodEnd: today, openingBalance: '0.00', closingBalance: '2155.00', status: 'imported', lineCount: 4,
    lines: [ln(1, '2000.00', 'R-1', 'Incoming wire R-1', 'suggested', { outcome: 'suggested', candidates: [{ transactionId: 't-1', transactionNumber: 'TRS-IN-2026-000101', score: 100, reasons: ['amount', 'reference', 'same-day'] }] }),
      ln(2, '300.00', 'DEP-1', 'Cash deposit DEP-1', 'matched'), ln(3, '-120.00', 'EXP-1', 'Payment EXP-1', 'suggested', { outcome: 'ambiguous', candidates: [{ transactionId: 't-3', transactionNumber: 'TRS-OUT-2026-000044', score: 55, reasons: ['amount', 'near-date'] }, { transactionId: 't-4', transactionNumber: 'TRS-OUT-2026-000045', score: 55, reasons: ['amount', 'near-date'] }] }),
      ln(4, '-25.00', 'FEE-OCT', 'Monthly account fee')] },
  { id: 's-2', systemNumber: 'BST-2026-000002', statementNumber: 'SEP', treasuryAccountId: 'a-bank', periodStart: '2026-09-01', periodEnd: '2026-09-30', openingBalance: '0.00', closingBalance: '500.00', status: 'reconciled', lineCount: 1, lines: [ln(1, '500.00', 'S-1', 'Wire', 'matched')] },
];
const sessions: Array<Record<string, unknown>> = [
  { id: 'cs-1', sessionNumber: 'CS-2026-000001', treasuryAccountId: 'a-cash', status: 'open', openedAt: now(), openingBalance: '12500.00', closedAt: null, expectedBalance: null, countedAmount: null, variance: null, varianceReason: null, varianceDocumentId: null },
  { id: 'cs-2', sessionNumber: 'CS-2026-000000', treasuryAccountId: 'a-new', status: 'closed', openedAt: now(), openingBalance: '300.00', closedAt: now(), expectedBalance: '300.00', countedAmount: '260.00', variance: '-40.00', varianceReason: 'till error', varianceDocumentId: 'd-3' },
];
function recon(st: Stmt) {
  const bankOnly = st.lines.filter((l) => l.status !== 'matched').reduce((a, l) => a + Number(l.amount), 0);
  const outstanding = st.id === 's-1' ? -25 : 0;
  const book = 2155;
  const adjBank = Number(st.closingBalance) + outstanding;
  const adjBook = book + bankOnly;
  return { statementId: st.id, systemNumber: st.systemNumber, status: st.status, closingBalance: st.closingBalance, bookBalanceAtPeriodEnd: book.toFixed(2), outstandingBookNet: outstanding.toFixed(2), bankOnlyNet: bankOnly.toFixed(2), adjustedBank: adjBank.toFixed(2), adjustedBook: adjBook.toFixed(2), difference: (adjBank - adjBook).toFixed(2), reconciled: st.status === 'reconciled', unmatchedLines: st.lines.filter((l) => l.status !== 'matched'), outstandingBookItems: st.id === 's-1' ? [{ transactionId: 't-9', transactionNumber: 'TRS-OUT-2026-000050', movementDate: today, signedAmount: '-25.00', reference: 'FEE-OCT', ageDays: 0 }] : [] };
}
function handleT5(method: string, p: string, body: Record<string, unknown>): unknown | undefined {
  let m: RegExpMatchArray | null;
  if (p === '/treasury/bank-statements' && method === 'GET') return statements.map((s) => ({ ...s, lines: undefined }));
  if (p === '/treasury/bank-statements' && method === 'POST') {
    const lines = (body.lines as Array<{ valueDate: string; amount: string; reference?: string; description?: string }>) ?? [];
    const total = lines.reduce((a, l) => a + Number(l.amount), 0);
    if (Math.abs(Number(body.openingBalance) + total - Number(body.closingBalance)) > 0.004) throw new ApiError(400, 'VALIDATION_ERROR', `The statement does not add up: opening ${body.openingBalance} + lines ${total.toFixed(2)}, but the closing balance is ${body.closingBalance}. Nothing was imported.`);
    const st: Stmt = { id: `s-${statements.length + 1}`, systemNumber: `BST-2026-${String(statements.length + 1).padStart(6, '0')}`, statementNumber: (body.statementNumber as string) ?? null, treasuryAccountId: String(body.treasuryAccountId), periodStart: String(body.periodStart), periodEnd: String(body.periodEnd), openingBalance: String(body.openingBalance), closingBalance: String(body.closingBalance), status: 'imported', lineCount: lines.length, lines: lines.map((l, i) => ln(i + 1, l.amount, l.reference ?? '', l.description ?? '')) };
    statements.unshift(st);
    return { ...st, lines: undefined };
  }
  if ((m = p.match(/^\/treasury\/bank-statements\/(s-\d+)\/reconciliation$/))) return recon(statements.find((s) => s.id === m![1])!);
  if ((m = p.match(/^\/treasury\/bank-statements\/(s-\d+)\/(suggest|reconcile|reopen)$/))) {
    const st = statements.find((s) => s.id === m![1])!;
    if (m[2] === 'suggest') return { suggested: 1, ambiguous: 1, unmatched: 1 };
    if (m[2] === 'reopen') { st.status = 'imported'; return st; }
    const open = st.lines.filter((l) => l.status !== 'matched').length;
    if (open > 0) throw new ApiError(409, 'CONFLICT', `${open} bank line(s) are not matched. Record any bank fee / interest as a Treasury document, execute it, then match the line. Nothing was closed.`);
    st.status = 'reconciled';
    return st;
  }
  if ((m = p.match(/^\/treasury\/bank-statements\/(s-\d+)$/)) && method === 'GET') return JSON.parse(JSON.stringify(statements.find((s) => s.id === m![1])));
  if ((m = p.match(/^\/treasury\/bank-statements\/lines\/(l-\d+)\/(confirm|unmatch)$/))) {
    for (const st of statements) { const l = st.lines.find((x) => x.id === m![1]); if (l) { l.status = m[2] === 'confirm' ? 'matched' : 'unmatched'; l.suggestion = null; return l; } }
  }
  if (p === '/treasury/cash-sessions' && method === 'GET') return sessions;
  if (p === '/treasury/cash-sessions' && method === 'POST') {
    const s = { id: `cs-${sessions.length + 1}`, sessionNumber: `CS-2026-0000${sessions.length + 2}`, treasuryAccountId: String(body.treasuryAccountId), status: 'open', openedAt: now(), openingBalance: '1000.00', closedAt: null, expectedBalance: null, countedAmount: null, variance: null, varianceReason: null, varianceDocumentId: null };
    sessions.unshift(s);
    return s;
  }
  if ((m = p.match(/^\/treasury\/cash-sessions\/([^/]+)\/(close|reopen)$/))) {
    const s = sessions.find((x) => x.id === m![1])!;
    if (m[2] === 'close') {
      const variance = Number(body.countedAmount) - 12500;
      if (variance !== 0 && !body.varianceReason) throw new ApiError(400, 'VALIDATION_ERROR', `The count differs from the book balance by ${variance.toFixed(2)} — a reason for the variance is required. Nothing was closed.`);
      Object.assign(s, { status: 'closed', closedAt: now(), expectedBalance: '12500.00', countedAmount: String(body.countedAmount), variance: variance.toFixed(2), varianceReason: (body.varianceReason as string) ?? null, varianceDocumentId: variance !== 0 ? 'd-3' : null });
    } else Object.assign(s, { status: 'open', closedAt: null, expectedBalance: null, countedAmount: null, variance: null, varianceDocumentId: null });
    return s;
  }
  return undefined;
}

async function handle(method: string, path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const [p, qs] = path.split('?');
  const t5 = handleT5(method, p, body);
  if (t5 !== undefined) return t5;
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
