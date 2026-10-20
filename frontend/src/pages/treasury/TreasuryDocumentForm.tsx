import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, newIdempotencyKey } from '../../lib/api';
import { ErrorState } from '../../components/ErrorState';
import { PAYMENT_METHODS, currentLang, nameOf } from '../../lib/displayNames';
import { money, useTr, type DocKind, type TreasuryDocumentRow } from './treasuryUi';

interface Account {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
  balance: string;
  accountTypeId: string;
  glAccountCode: string | null;
}
interface AccountType {
  id: string;
  code: string;
}
interface Customer {
  id: string;
  code: string;
  name: string;
}
interface OpenInvoice {
  id: string;
  invoiceNumber: string;
  remaining: string;
  state: string;
}
interface ReasonCodes {
  receipt: string[];
  disbursement: string[];
}

type Purpose = 'customer_collection' | 'bank_deposit' | 'bank_withdrawal' | 'account_transfer' | 'misc_receipt' | 'disbursement';

const PURPOSES: Array<{ id: Purpose; kind: DocKind; subtype?: string; ar: string; en: string; hintAr: string; hintEn: string }> = [
  { id: 'customer_collection', kind: 'customer_collection', ar: 'استلام دفعة من عميل', en: 'Receive a customer payment', hintAr: 'تسوية فاتورة أو أكثر، ويمكن ترك جزء كدفعة مقدّمة.', hintEn: 'Settle one or more invoices; an unapplied part stays as a customer advance.' },
  { id: 'bank_deposit', kind: 'transfer', subtype: 'bank_deposit', ar: 'إيداع نقدية في البنك', en: 'Deposit cash into bank', hintAr: 'نقل نقدية موجودة — لا يُنشئ إيراداً.', hintEn: 'Moves existing cash — creates no revenue.' },
  { id: 'bank_withdrawal', kind: 'transfer', subtype: 'bank_withdrawal', ar: 'سحب نقدية من البنك', en: 'Withdraw cash from bank', hintAr: 'نقل من البنك إلى الخزينة — لا يُنشئ مصروفاً.', hintEn: 'Moves money from bank to cash — creates no expense.' },
  { id: 'account_transfer', kind: 'transfer', subtype: 'account_transfer', ar: 'تحويل بين حسابين', en: 'Transfer between accounts', hintAr: 'تحويل داخلي بين حسابين نقديين/بنكيين.', hintEn: 'An internal transfer between two cash/bank accounts.' },
  { id: 'misc_receipt', kind: 'misc_receipt', ar: 'استلام نقدي متنوع (معتمد)', en: 'Authorized miscellaneous receipt', hintAr: 'يتطلب سبباً مربوطاً بحساب في سياسة الشركة.', hintEn: 'Requires a reason mapped to an account in the company posting profile.' },
  { id: 'disbursement', kind: 'disbursement', ar: 'صرف نقدي (معتمد)', en: 'Authorized disbursement', hintAr: 'يتطلب سبباً مربوطاً بحساب في سياسة الشركة.', hintEn: 'Requires a reason mapped to an account in the company posting profile.' },
];

/**
 * T4 — "what is this money for?" comes FIRST; the form then shows only the fields that purpose needs. No offset account is ever typed: the accounting effect comes from the
 * company posting profile (receipts / disbursements) or from the two accounts themselves (transfers), and is previewed on the document page before anything is posted.
 */
export function TreasuryDocumentForm() {
  const tr = useTr();
  const nav = useNavigate();
  const { id } = useParams();
  const editing = Boolean(id);
  const idem = useRef(newIdempotencyKey());

  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [types, setTypes] = useState<AccountType[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [reasons, setReasons] = useState<ReasonCodes>({ receipt: [], disbursement: [] });
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([]);
  const [existing, setExisting] = useState<TreasuryDocumentRow | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [accountId, setAccountId] = useState('');
  const [counterId, setCounterId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [reference, setReference] = useState('');
  const [text, setText] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [unapplied, setUnapplied] = useState('');

  useEffect(() => {
    Promise.all([
      api.get<Account[]>('/treasury/accounts'),
      api.get<AccountType[]>('/treasury/account-types'),
      api.get<Customer[]>('/customers').catch(() => [] as Customer[]),
      api.get<ReasonCodes>('/treasury/documents/reason-codes').catch(() => ({ receipt: [], disbursement: [] }) as ReasonCodes),
    ])
      .then(([a, t, c, r]) => {
        setAccounts(a);
        setTypes(t);
        setCustomers(c);
        setReasons(r);
      })
      .catch(setError);
  }, []);

  useEffect(() => {
    if (!id) return;
    api
      .get<TreasuryDocumentRow>(`/treasury/documents/${id}`)
      .then((d) => {
        setExisting(d);
        const p = PURPOSES.find((x) => x.kind === d.kind && (x.subtype ?? null) === (d.subtype ?? null));
        setPurpose(p?.id ?? null);
        setAccountId(d.treasuryAccountId);
        setCounterId(d.counterTreasuryAccountId ?? '');
        setCustomerId(d.customerId ?? '');
        setMethod(d.method ?? 'cash');
        setAmount(d.kind === 'customer_collection' ? '' : d.amount);
        setReasonCode(d.reasonCode ?? '');
        setReference(d.reference ?? '');
        setText(d.purpose ?? '');
        setUnapplied(Number(d.unappliedAmount) > 0 ? d.unappliedAmount : '');
        setAlloc(Object.fromEntries((d.allocations ?? []).map((a) => [a.invoiceId, a.amount])));
      })
      .catch(setError);
  }, [id]);

  useEffect(() => {
    if (purpose !== 'customer_collection' || !customerId) {
      setOpenInvoices([]);
      return;
    }
    api
      .get<OpenInvoice[]>(`/treasury/documents/customers/${customerId}/open-invoices`)
      .then(setOpenInvoices)
      .catch(setError);
  }, [purpose, customerId]);

  const typeCode = useMemo(() => new Map(types.map((t) => [t.id, t.code])), [types]);
  const active = accounts.filter((a) => a.status === 'active' && a.glAccountCode);
  const cashLike = (a: Account) => ['cash', 'custody'].includes(typeCode.get(a.accountTypeId) ?? '');
  const isBank = (a: Account) => typeCode.get(a.accountTypeId) === 'bank';
  const sourceChoices = purpose === 'bank_deposit' ? active.filter(cashLike) : purpose === 'bank_withdrawal' ? active.filter(isBank) : active;
  const destChoices = (purpose === 'bank_deposit' ? active.filter(isBank) : purpose === 'bank_withdrawal' ? active.filter(cashLike) : active).filter((a) => a.id !== accountId);

  const allocTotal = Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0);
  const collectionTotal = allocTotal + (Number(unapplied) || 0);
  const meta = PURPOSES.find((p) => p.id === purpose);
  const reasonList = purpose === 'misc_receipt' ? reasons.receipt : reasons.disbursement;

  function body(): Record<string, unknown> {
    const base: Record<string, unknown> = { kind: meta!.kind, treasuryAccountId: accountId, reference: reference || undefined, purpose: text || undefined };
    if (meta!.kind === 'customer_collection') {
      return {
        ...base,
        customerId,
        method,
        allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([invoiceId, v]) => ({ invoiceId, amount: Number(v).toFixed(2) })),
        unappliedAmount: Number(unapplied) > 0 ? Number(unapplied).toFixed(2) : undefined,
      };
    }
    if (meta!.kind === 'transfer') return { ...base, subtype: meta!.subtype, counterTreasuryAccountId: counterId, amount };
    return { ...base, amount, reasonCode };
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!meta) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = editing
        ? await api.put<TreasuryDocumentRow>(`/treasury/documents/${id}`, { ...body(), expectedVersion: existing?.version })
        : await api.post<TreasuryDocumentRow>('/treasury/documents', body(), { idempotencyKey: idem.current });
      nav(`/treasury/documents/${saved.id}`);
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.status === 409) setMessage(tr('تغيّر المستند أو البيانات المرتبطة به — راجع الرسالة ثم أعد المحاولة.', 'The document or its related data changed — read the message and try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{editing ? tr('تعديل مسودة مستند', 'Edit draft document') : tr('مستند خزينة جديد', 'New treasury document')}</h1>
      </div>

      {!purpose && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{tr('ما الغرض من هذه الحركة المالية؟', 'What is this financial movement for?')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            {PURPOSES.map((p) => (
              <button key={p.id} type="button" className="card" style={{ textAlign: 'start', cursor: 'pointer' }} onClick={() => setPurpose(p.id)}>
                <strong>{tr(p.ar, p.en)}</strong>
                <div style={{ opacity: 0.75, marginTop: 4 }}>{tr(p.hintAr, p.hintEn)}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {error ? <ErrorState error={error} /> : null}
      {message && <div className="error-text">{message}</div>}

      {meta && (
        <form className="card" onSubmit={save}>
          <h3 style={{ marginTop: 0 }}>{tr(meta.ar, meta.en)}</h3>
          <div style={{ opacity: 0.75, marginBottom: 12 }}>{tr(meta.hintAr, meta.hintEn)}</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {meta.kind === 'customer_collection' && (
              <div className="form-field" style={{ minWidth: 240 }}>
                <label>{tr('العميل', 'Customer')}</label>
                <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setAlloc({}); }} required disabled={editing && Boolean(existing?.customerId)}>
                  <option value="">—</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-field" style={{ minWidth: 240 }}>
              <label>
                {meta.kind === 'customer_collection' || meta.kind === 'misc_receipt'
                  ? tr('الحساب المستلِم', 'Receiving account')
                  : meta.kind === 'disbursement'
                    ? tr('الحساب الدافع', 'Paying account')
                    : tr('الحساب المصدر', 'Source account')}
              </label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
                <option value="">—</option>
                {sourceChoices.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name} ({money(a.balance)})</option>
                ))}
              </select>
            </div>
            {meta.kind === 'transfer' && (
              <div className="form-field" style={{ minWidth: 240 }}>
                <label>{tr('الحساب المستلِم', 'Destination account')}</label>
                <select value={counterId} onChange={(e) => setCounterId(e.target.value)} required>
                  <option value="">—</option>
                  {destChoices.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                  ))}
                </select>
              </div>
            )}
            {meta.kind === 'customer_collection' && (
              <div className="form-field">
                <label>{tr('طريقة الدفع', 'Payment method')}</label>
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {Object.keys(PAYMENT_METHODS).filter((k) => !['check', 'transfer'].includes(k)).map((k) => (
                    <option key={k} value={k}>{nameOf(PAYMENT_METHODS, k, currentLang())}</option>
                  ))}
                </select>
              </div>
            )}
            {meta.kind !== 'customer_collection' && (
              <div className="form-field">
                <label>{tr('المبلغ', 'Amount')}</label>
                <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </div>
            )}
            {(meta.kind === 'misc_receipt' || meta.kind === 'disbursement') && (
              <div className="form-field" style={{ minWidth: 220 }}>
                <label>{tr('سبب الحركة', 'Reason')}</label>
                <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} required>
                  <option value="">—</option>
                  {reasonList.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                {reasonList.length === 0 && (
                  <div className="error-text">{tr('لا توجد أسباب مربوطة بحسابات — اطلب من المحاسبة ربط الأسباب في سياسة الحسابات.', 'No reasons are mapped to accounts — ask Accounting to map them in the accounting policy.')}</div>
                )}
              </div>
            )}
            <div className="form-field" style={{ minWidth: 220 }}>
              <label>{tr('المرجع / رقم المستند الداعم', 'Reference / supporting document')}</label>
              <input value={reference} onChange={(e) => setReference(e.target.value)} required={meta.kind === 'misc_receipt' || meta.kind === 'disbursement'} />
            </div>
            <div className="form-field" style={{ minWidth: 280, flex: 1 }}>
              <label>{tr('الغرض / الوصف', 'Purpose / description')}</label>
              <input value={text} onChange={(e) => setText(e.target.value)} required={meta.kind !== 'customer_collection'} minLength={meta.kind === 'customer_collection' ? undefined : 3} />
            </div>
          </div>

          {meta.kind === 'customer_collection' && customerId && (
            <div style={{ marginTop: 12 }}>
              <h4>{tr('توزيع المبلغ على الفواتير المفتوحة', 'Allocate the receipt to open invoices')}</h4>
              {openInvoices.length === 0 ? (
                <div className="empty-state">{tr('لا توجد فواتير مفتوحة لهذا العميل — يمكن تسجيل المبلغ كدفعة مقدّمة.', 'This customer has no open invoices — the amount can be recorded as an advance.')}</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{tr('الفاتورة', 'Invoice')}</th>
                      <th style={{ textAlign: 'end' }}>{tr('المتبقي', 'Remaining')}</th>
                      <th>{tr('المخصَّص', 'Allocate')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openInvoices.map((i) => (
                      <tr key={i.id}>
                        <td>{i.invoiceNumber}</td>
                        <td style={{ textAlign: 'end' }}>{money(i.remaining)}</td>
                        <td>
                          <input type="number" min="0" max={i.remaining} step="0.01" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} style={{ width: 120 }} />{' '}
                          <button type="button" className="btn btn-secondary" onClick={() => setAlloc({ ...alloc, [i.id]: i.remaining })}>{tr('الكل', 'Max')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="form-field" style={{ marginTop: 8, maxWidth: 260 }}>
                <label>{tr('جزء غير مخصَّص (دفعة مقدّمة)', 'Unapplied part (customer advance)')}</label>
                <input type="number" min="0" step="0.01" value={unapplied} onChange={(e) => setUnapplied(e.target.value)} />
              </div>
              <strong>{tr('إجمالي التحصيل', 'Total receipt')}: {money(collectionTotal)}</strong>
            </div>
          )}

          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" type="submit" disabled={busy || (meta.kind === 'customer_collection' && collectionTotal <= 0)}>
              {tr('حفظ كمسودة', 'Save as draft')}
            </button>
            {!editing && (
              <button className="btn btn-secondary" type="button" onClick={() => setPurpose(null)}>
                {tr('تغيير الغرض', 'Change purpose')}
              </button>
            )}
          </div>
          <div style={{ opacity: 0.7, marginTop: 8 }}>{tr('الحفظ لا يحرّك أي مبلغ. بعد الحفظ يمكنك مراجعة الأثر المحاسبي ثم إرسال المستند للاعتماد.', 'Saving moves no money. After saving you can review the accounting effect and then submit the document for approval.')}</div>
        </form>
      )}
    </div>
  );
}
