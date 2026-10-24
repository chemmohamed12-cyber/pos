import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { CustomerProfileTab } from './CustomerProfileTab';
import { LedgerEntryDrawer } from '../components/LedgerEntryDrawer';
import { PAYMENT_METHODS, STATUS_NAMES, currentLang, loadingLabel, nameOf } from '../lib/displayNames';
import { fmtDate, fmtDateTime } from '../lib/formatDateTime';

interface Customer {
  id: string;
  code: string;
  name: string;
  status: string;
  phone: string | null;
  governorate: string | null;
  address: string | null;
  creditLimit: string | null;
  paymentTermsDays: number | null;
  accountType: 'cash' | 'credit';
  financialStatus: 'active' | 'on_hold' | 'suspended';
}

interface LedgerEntry {
  type: string;
  date: string;
  reference: string;
  description: string;
  salesOrderId: string | null;
  invoiceId: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
  status: 'posted' | 'reversed';
}

interface Statement {
  customerId: string;
  customerCode: string;
  customerName: string;
  balance: string;
  creditLimit: string | null;
  availableCredit: string | null;
  overdueAmount: string;
  totalSales: string;
  totalPaid: string;
  totalReturns: string;
  totalOutstanding: string;
  entries: LedgerEntry[];
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  salesOrderId: string;
  totalAmount: string;
  dueDate: string | null;
  state: string;
  remaining: string;
  createdAt: string;
}

interface Payment {
  id: string;
  paymentNumber: string;
  invoiceId: string | null; // null = on-account / advance payment (CUS-01)
  amount: string;
  method: string;
  occurredAt: string;
}

interface ArAgingRow {
  invoiceId: string;
  invoiceNumber: string;
  dueDate: string | null;
  originalAmount: string;
  paidAmount: string;
  remaining: string;
  daysOverdue: number;
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
}

interface SalesOrder {
  id: string;
  orderNumber: string;
  customerId: string;
}

interface ReturnCreditRow {
  id: string;
  originalSalesOrderId: string;
  originalAmount: string;
  usedAmount: string;
  remainingAmount: string;
  status: string;
  returnNumber: string | null;
}

/** CUS-01 — a payment (Customer Advance) that still carries an unapplied balance. */
interface UnappliedPayment {
  id: string;
  paymentNumber: string;
  salesOrderId: string | null;
  amount: string;
  unappliedAmount: string;
  method: string;
  occurredAt: string;
}

interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
}

type Tab = 'ledger' | 'invoices' | 'ar_aging' | 'credit' | 'profile';

interface Bilingual {
  ar: string;
  en: string;
}
interface AccountSummary {
  balance: string;
  creditLimit: string | null;
  availableCredit: string | null;
  overdue: string;
  overdueNetOfUnappliedCredit: string;
  notYetDue: string;
  totalOpen: string;
  openInvoices: number;
  unappliedCredit: string;
  customerCreditBalance: string;
  overApplied: { invoices: number; amount: string };
  aging: Record<'0-30' | '31-60' | '61-90' | '90+', string>;
  invoicedInPeriod: string;
  collectedInPeriod: string;
  returnsInPeriod: string;
  lastInvoiceDate: string | null;
  lastPaymentDate: string | null;
  nextDueDate: string | null;
  alerts: { overCreditLimit: boolean; hasOverdue: boolean; hasOverApplied: boolean };
  definitions: Record<string, Bilingual>;
}
interface RecentRow {
  entryId: string;
  date: string;
  typeLabel: Bilingual;
  description: Bilingual;
  documentNumber: string | null;
  documentLink: string | null;
  debit: string;
  credit: string;
  balance: string;
  nettedOut: boolean;
  flags: string[];
}
const money = (v: string) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Customer Financial Account / Invoice / AR (CTO directive §11 — Customer
 * Account Dashboard). Header + KPIs + Ledger sourced from the new PRIMARY
 * `GET /reports/customer-accounts/:id` (Customer-Ledger-backed, never a
 * cached balance). Invoices/Payments/AR-Aging are their own tabs on the
 * same screen — "موظف الحسابات يرى الوضع المالي الكامل للعميل من شاشة
 * واحدة" (finance staff sees the customer's full financial picture from
 * one screen).
 */
export function CustomerAccount() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, preload, lang } = useLanguage();
  const ar = lang === 'ar';

  preload([
    'panel.customer_profile',
    'field.customer_account',
    'field.credit_limit',
    'field.available_credit',
    'field.payment_terms_days',
    'field.account_type',
    'field.financial_status',
    'field.balance',
    'field.overdue_amount',
    'field.total_sales',
    'field.total_paid',
    'field.total_outstanding',
    'field.total_returns',
    'field.date',
    'field.type',
    'field.reference',
    'field.description',
    'field.debit',
    'field.credit',
    'field.running_balance',
    'field.status',
    'field.sales_order',
    'field.invoice_number',
    'field.invoice',
    'field.total_amount',
    'field.due_date',
    'field.remaining',
    'field.payment_number',
    'field.payment_method',
    'field.aging_bucket',
    'field.days_overdue',
    'field.quantity',
    'field.actions',
    'field.phone',
    'field.governorate',
    'field.address',
    'field.sales_representative',
    'field.last_invoice',
    'field.last_payment',
    'field.credit_amount',
    'field.available_amount',
    'field.used_amount',
    'field.original_sales_order',
    'field.return_number',
    'account_type.cash',
    'account_type.credit',
    'financial_status.active',
    'financial_status.on_hold',
    'financial_status.suspended',
    'aging_bucket.current',
    'return_credit_status.active',
    'return_credit_status.partially_used',
    'return_credit_status.fully_used',
    'panel.invoices',
    'panel.payments',
    'panel.ar_aging',
    'panel.customer_ledger',
    'panel.no_invoices_yet',
    'panel.no_payments_yet',
    'panel.no_ledger_entries_yet',
    'panel.no_credits_available',
    'action.create_invoice',
    'action.post_invoice',
    'action.void_invoice',
    'action.record_payment',
    'action.apply_credit_to_invoice',
    'action.back',
    'action.view_statement',
    'nav.sales_orders',
    'nav.returns',
    'nav.customer_statement',
    'customer_ledger_entry_type.sales_invoice',
    'customer_ledger_entry_type.deposit',
    'customer_ledger_entry_type.payment',
    'customer_ledger_entry_type.payment_application',
    'panel.customer_advance_unapplied',
    'panel.on_account_note',
    'panel.no_unapplied_receipts',
    'action.record_on_account_payment',
    'action.apply_unapplied_payment',
    'field.unapplied_amount',
    'field.treasury_account',
    'customer_ledger_entry_type.cod_collection',
    'customer_ledger_entry_type.return_credit_note',
    'customer_ledger_entry_type.debit_note',
    'customer_ledger_entry_type.adjustment',
    'customer_ledger_entry_type.opening_balance',
    'customer_ledger_entry_type.refund',
  ]);

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [arAging, setArAging] = useState<ArAgingRow[]>([]);
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [credits, setCredits] = useState<ReturnCreditRow[]>([]);
  const [treasuryAccounts, setTreasuryAccounts] = useState<TreasuryAccount[]>([]);
  const [primaryRep, setPrimaryRep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('ledger');
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [recent, setRecent] = useState<RecentRow[] | null>(null);
  const [openEntry, setOpenEntry] = useState<string | null>(null);

  const [newInvoiceOrderId, setNewInvoiceOrderId] = useState('');
  const [voidReason, setVoidReason] = useState<Record<string, string>>({});
  const [paymentAmount, setPaymentAmount] = useState<Record<string, string>>({});
  const [paymentMethod, setPaymentMethod] = useState<Record<string, string>>({});
  const [paymentAccount, setPaymentAccount] = useState<Record<string, string>>({});
  const [unapplied, setUnapplied] = useState<UnappliedPayment[]>([]);
  const [onAccount, setOnAccount] = useState({ amount: '', method: 'cash', treasuryAccountId: '', salesOrderId: '' });
  const [unappliedInvoice, setUnappliedInvoice] = useState<Record<string, string>>({});
  const [unappliedAmount, setUnappliedAmount] = useState<Record<string, string>>({});
  const [creditApplyInvoice, setCreditApplyInvoice] = useState<Record<string, string>>({});
  const [creditApplyAmount, setCreditApplyAmount] = useState<Record<string, string>>({});

  async function loadAll() {
    if (!id) return;
    const [customerData, statementData, invoicesData, paymentsData, agingData, ordersData, creditsData, treasuryData, repData, unappliedData] = await Promise.all([
      api.get<Customer>(`/customers/${id}`),
      api.get<Statement>(`/reports/customer-accounts/${id}`),
      api.get<Invoice[]>(`/customers/${id}/invoices`),
      api.get<Payment[]>(`/customers/${id}/payments`),
      api.get<ArAgingRow[]>(`/customers/${id}/ar-aging`),
      api.get<SalesOrder[]>('/sales-orders'),
      api.get<ReturnCreditRow[]>(`/returns/credits?customerId=${id}`),
      api.get<TreasuryAccount[]>('/treasury/accounts'),
      api.get<{ name: string | null }>(`/customers/${id}/primary-rep`),
      api.get<UnappliedPayment[]>(`/payments/unapplied?customerId=${id}`).catch(() => [] as UnappliedPayment[]),
    ]);
    // The single-source indicators and the latest movements of the official statement engine (read-only; absent without the `accounting.ar.view` permission).
    const fromYear = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    api.get<AccountSummary>(`/customer-finance/account-summary/${id}?from=${fromYear}`).then(setSummary).catch(() => setSummary(null));
    api.get<{ rows: RecentRow[] }>(`/customer-finance/statement/${id}`).then((r) => setRecent([...r.rows].slice(-10).reverse())).catch(() => setRecent(null));
    setCustomer(customerData);
    setStatement(statementData);
    setInvoices(invoicesData);
    setPayments(paymentsData);
    setArAging(agingData);
    setOrders(ordersData.filter((o) => o.customerId === id));
    setCredits(creditsData);
    setTreasuryAccounts(treasuryData);
    setPrimaryRep(repData.name);
    setUnapplied(unappliedData);
  }

  useEffect(() => {
    loadAll().catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load customer account.'));
  }, [id]);

  async function createInvoice() {
    if (!newInvoiceOrderId) return;
    setBusy('create-invoice');
    setError(null);
    setNotice(null);
    try {
      await api.post('/invoices', { salesOrderId: newInvoiceOrderId });
      setNewInvoiceOrderId('');
      setNotice('Invoice created as draft.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create invoice.');
    } finally {
      setBusy(null);
    }
  }

  async function postInvoice(invoiceId: string) {
    setBusy(invoiceId + 'post');
    setError(null);
    setNotice(null);
    try {
      await api.post(`/invoices/${invoiceId}/post`, {});
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to post invoice.');
    } finally {
      setBusy(null);
    }
  }

  async function voidInvoice(invoiceId: string) {
    const reason = voidReason[invoiceId] ?? '';
    if (!reason.trim()) {
      setError('A reason is required to void an invoice.');
      return;
    }
    setBusy(invoiceId + 'void');
    setError(null);
    setNotice(null);
    try {
      await api.post(`/invoices/${invoiceId}/void`, { reason });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to void invoice.');
    } finally {
      setBusy(null);
    }
  }

  async function recordPayment(invoiceId: string) {
    if (!id) return;
    const amount = paymentAmount[invoiceId];
    const method = paymentMethod[invoiceId] ?? 'cash';
    const treasuryAccountId = paymentAccount[invoiceId];
    if (!amount || !treasuryAccountId) {
      setError('Amount and Treasury account are required to record a payment.');
      return;
    }
    setBusy(invoiceId + 'payment');
    setError(null);
    setNotice(null);
    try {
      await api.post('/payments', { customerId: id, invoiceId, amount, method, treasuryAccountId });
      setPaymentAmount((prev) => ({ ...prev, [invoiceId]: '' }));
      setNotice('Payment recorded.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record payment.');
    } finally {
      setBusy(null);
    }
  }

  /** CUS-01 — record money received BEFORE an invoice (Customer Advance / Unapplied Receipt); the server posts Dr bank / Cr AR and an unapplied ledger credit. */
  async function recordOnAccount() {
    if (!id) return;
    if (!onAccount.amount || !onAccount.treasuryAccountId) {
      setError('Amount and Treasury account are required to record an on-account payment.');
      return;
    }
    setBusy('on-account');
    setError(null);
    setNotice(null);
    try {
      await api.post('/payments/on-account', {
        customerId: id,
        amount: onAccount.amount,
        method: onAccount.method || 'cash',
        treasuryAccountId: onAccount.treasuryAccountId,
        salesOrderId: onAccount.salesOrderId || undefined,
      });
      setOnAccount({ amount: '', method: 'cash', treasuryAccountId: '', salesOrderId: '' });
      setNotice('On-account payment recorded.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record the on-account payment.');
    } finally {
      setBusy(null);
    }
  }

  async function applyUnapplied(paymentId: string) {
    const invoiceId = unappliedInvoice[paymentId];
    const amount = unappliedAmount[paymentId];
    if (!invoiceId || !amount) {
      setError('Select a target invoice and an amount to apply the receipt.');
      return;
    }
    setBusy(paymentId + 'apply-unapplied');
    setError(null);
    setNotice(null);
    try {
      await api.post(`/payments/${paymentId}/apply`, { invoiceId, amount });
      setUnappliedAmount((prev) => ({ ...prev, [paymentId]: '' }));
      setNotice('Receipt applied to invoice.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to apply the receipt.');
    } finally {
      setBusy(null);
    }
  }

  async function applyCreditToInvoice(creditId: string) {
    const invoiceId = creditApplyInvoice[creditId];
    const amount = creditApplyAmount[creditId];
    if (!invoiceId || !amount) {
      setError('Select a target invoice and amount to apply a credit.');
      return;
    }
    setBusy(creditId + 'apply');
    setError(null);
    setNotice(null);
    try {
      await api.post(`/returns/credits/${creditId}/apply-to-invoice`, { invoiceId, amount });
      setNotice('Credit applied to invoice.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to apply credit.');
    } finally {
      setBusy(null);
    }
  }

  if (error && !statement) return <div className="error-text">{error}</div>;
  if (!customer || !statement) return <div className="empty-state">{loadingLabel()}</div>;

  const ordersWithoutOpenInvoice = orders.filter((o) => !invoices.some((inv) => inv.salesOrderId === o.id && inv.state !== 'void'));

  return (
    <div>
      <div className="page-header">
        <h1>
          {t('field.customer_account')} — {customer.name} ({customer.code})
        </h1>
      </div>

      <button className="btn btn-secondary" style={{ marginBottom: 16 }} onClick={() => navigate('/customers')}>
        {t('action.back')}
      </button>

      {error && <div className="error-text">{error}</div>}
      {notice && <div style={{ color: 'var(--success, #2e7d32)', marginBottom: 12 }}>{notice}</div>}

      {summary && (summary.alerts.overCreditLimit || summary.alerts.hasOverdue || summary.alerts.hasOverApplied) && (
        <div className="error-text" style={{ marginBottom: 12 }} data-testid="account-alerts">
          {summary.alerts.overCreditLimit && <div>{ar ? `تنبيه: الرصيد (${money(summary.balance)}) تجاوز حد الائتمان (${money(summary.creditLimit ?? '0')}).` : `Alert: the balance (${money(summary.balance)}) exceeds the credit limit (${money(summary.creditLimit ?? '0')}).`}</div>}
          {summary.alerts.hasOverApplied && <div>{ar ? `تنبيه: ${summary.overApplied.invoices} فاتورة مطبّق عليها أكثر من قيمتها بإجمالي ${money(summary.overApplied.amount)} — راجع الدفعات والعرابين.` : `Alert: ${summary.overApplied.invoices} invoice(s) have more applied than their value (${money(summary.overApplied.amount)}) — review payments and deposits.`}</div>}
          {summary.alerts.hasOverdue && <div>{ar ? `تنبيه: توجد مديونية متأخرة بقيمة ${money(summary.overdue)}.` : `Alert: overdue receivables of ${money(summary.overdue)}.`}</div>}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {(
              [
                [t('field.phone'), customer.phone ?? '—'],
                [t('field.governorate'), customer.governorate ?? '—'],
                [t('field.address'), customer.address ?? '—'],
                [t('field.sales_representative'), primaryRep ?? '—'],
                [t('field.status'), nameOf(STATUS_NAMES, customer.status, currentLang())],
                [t('field.account_type'), t(`account_type.${customer.accountType}`)],
                [t('field.financial_status'), t(`financial_status.${customer.financialStatus}`)],
                [t('field.payment_terms_days'), customer.paymentTermsDays ?? '—'],
              ] as Array<[string, React.ReactNode]>
            ).map(([label, value]) => (
              <div key={label}>
                <div style={{ color: '#6b7280', fontSize: 12 }}>{label}</div>
                <div>{value}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => navigate(`/customer-statement?customerId=${id}`)} data-testid="open-official-statement">
              {ar ? 'كشف الحساب الرسمي' : 'Official statement'}
            </button>
            <details style={{ position: 'relative' }}>
              <summary className="btn btn-secondary" style={{ listStyle: 'none', cursor: 'pointer' }}>
                {ar ? 'إجراءات ▾' : 'Actions ▾'}
              </summary>
              <div className="card" style={{ position: 'absolute', insetInlineEnd: 0, zIndex: 20, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 6, padding: 10 }}>
                <button className="btn btn-secondary" onClick={() => setTab('invoices')}>{ar ? 'إنشاء فاتورة / تسجيل دفعة' : 'Create invoice / record payment'}</button>
                <button className="btn btn-secondary" onClick={() => navigate('/returns')}>{t('nav.returns')}</button>
                <button className="btn btn-secondary" onClick={() => navigate('/sales-orders')}>{t('nav.sales_orders')}</button>
                <button className="btn btn-secondary" onClick={() => navigate('/ar-aging')}>{t('nav.ar_aging')}</button>
              </div>
            </details>
          </div>
        </div>
      </div>

      {summary && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            {(
              [
                ['balance', ar ? 'الرصيد الحالي' : 'Current balance', summary.balance, summary.definitions.balance],
                ['creditLimit', ar ? 'حد الائتمان' : 'Credit limit', summary.creditLimit === null ? '—' : money(summary.creditLimit), null],
                ['availableCredit', ar ? 'المتاح من الائتمان' : 'Available credit', summary.availableCredit === null ? '—' : money(summary.availableCredit), summary.definitions.availableCredit],
                ['overdue', ar ? 'المتأخر' : 'Overdue', summary.overdue, summary.definitions.overdue],
                ['customerCreditBalance', ar ? 'رصيد دائن للعميل' : 'Customer credit balance', summary.customerCreditBalance, summary.definitions.customerCreditBalance],
                ['unappliedCredit', ar ? 'دفعات مقدمة غير مطبّقة' : 'Unapplied advances', summary.unappliedCredit, summary.definitions.unappliedCredit],
                ['invoicedInPeriod', ar ? 'المفوتَر (آخر 12 شهرًا)' : 'Invoiced (last 12 months)', summary.invoicedInPeriod, summary.definitions.invoicedInPeriod],
                ['collectedInPeriod', ar ? 'المحصَّل (آخر 12 شهرًا)' : 'Collected (last 12 months)', summary.collectedInPeriod, summary.definitions.collectedInPeriod],
                ['returnsInPeriod', ar ? 'المرتجعات (آخر 12 شهرًا)' : 'Returns (last 12 months)', summary.returnsInPeriod, summary.definitions.returnsInPeriod],
              ] as Array<[string, string, string, Bilingual | null]>
            ).map(([key, label, value, def]) => (
              <div key={key} className="card" style={{ minWidth: 150, textAlign: 'center' }} title={def ? def[lang] : undefined} data-testid={`kpi-${key}`}>
                <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>{/^-?\d+(\.\d+)?$/.test(value) ? money(value) : value}</div>
                <div style={{ color: '#6b7280', fontSize: 13 }}>{label}</div>
              </div>
            ))}
          </div>
          <div className="card" style={{ marginBottom: 16 }} data-testid="aging-bands" title={summary.definitions.aging[lang]}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <strong>{ar ? 'أعمار الديون (من تاريخ الاستحقاق)' : 'Receivables aging (past due date)'}</strong>
              {(['0-30', '31-60', '61-90', '90+'] as const).map((b) => (
                <span key={b}>
                  {b} {ar ? 'يوم' : 'days'}: <strong>{money(summary.aging[b])}</strong>
                </span>
              ))}
              <span style={{ opacity: 0.7 }}>
                ({ar ? 'منها غير مستحق بعد' : 'of which not yet due'} {money(summary.notYetDue)} · {ar ? 'إجمالي مفتوح' : 'total open'} {money(summary.totalOpen)})
              </span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
              {ar ? 'آخر فاتورة' : 'Last invoice'}: {summary.lastInvoiceDate ? fmtDate(summary.lastInvoiceDate) : '—'} · {ar ? 'آخر دفعة' : 'Last payment'}: {summary.lastPaymentDate ? fmtDate(summary.lastPaymentDate) : '—'} · {ar ? 'أقرب استحقاق' : 'Next due'}: {summary.nextDueDate ?? '—'}
            </div>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className={tab === 'ledger' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('ledger')}>
          {ar ? 'آخر الحركات' : 'Latest movements'}
        </button>
        <button className={tab === 'invoices' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('invoices')}>
          {ar ? 'الفواتير والمدفوعات' : 'Invoices & payments'}
        </button>
        <button className={tab === 'ar_aging' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('ar_aging')}>
          {t('panel.ar_aging')}
        </button>
        <button className={tab === 'credit' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('credit')}>
          {ar ? 'الائتمان والتحصيل' : 'Credit & collection'}
        </button>
        <button className={tab === 'profile' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('profile')}>
          {t('panel.customer_profile')}
        </button>
      </div>


      {tab === 'ledger' &&
        (recent === null || recent.length === 0 ? (
          <div className="empty-state">{t('panel.no_ledger_entries_yet')}</div>
        ) : (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ opacity: 0.75 }}>{ar ? 'آخر 10 حركات — الكشف الرسمي بالفترة والرصيد الافتتاحي في شاشة كشف الحساب' : 'Latest 10 movements — the official period statement with opening balance is in the statement screen'}</span>
              <Link to={`/customer-statement?customerId=${id}`}>{ar ? 'فتح كشف الحساب' : 'Open statement'}</Link>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{ar ? 'التاريخ' : 'Date'}</th>
                  <th>{ar ? 'نوع الحركة' : 'Type'}</th>
                  <th>{ar ? 'البيان' : 'Description'}</th>
                  <th>{ar ? 'المستند' : 'Document'}</th>
                  <th>{ar ? 'مدين' : 'Debit'}</th>
                  <th>{ar ? 'دائن' : 'Credit'}</th>
                  <th>{ar ? 'الرصيد' : 'Balance'}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.entryId} style={{ cursor: 'pointer', opacity: r.nettedOut ? 0.6 : 1 }} onClick={() => setOpenEntry(r.entryId)}>
                    <td>{fmtDate(r.date)}</td>
                    <td>{r.typeLabel[lang]}</td>
                    <td>{r.description[lang]}{r.flags.length > 0 && <span style={{ color: '#b91c1c' }}> ⚠</span>}</td>
                    <td onClick={(e) => e.stopPropagation()}>{r.documentNumber ? r.documentLink ? <Link to={r.documentLink}>{r.documentNumber}</Link> : r.documentNumber : '—'}</td>
                    <td>{r.debit === '0.00' ? '' : money(r.debit)}</td>
                    <td>{r.credit === '0.00' ? '' : money(r.credit)}</td>
                    <td style={{ fontWeight: 600 }}>{money(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'credit' && (
        <div className="card" data-testid="credit-tab">
          <h3 style={{ marginTop: 0 }}>{ar ? 'الائتمان والتحصيل' : 'Credit & collection'}</h3>
          {summary ? (
            <div className="detail-grid">
              <div className="detail-field"><div className="label">{ar ? 'حد الائتمان' : 'Credit limit'}</div><div className="value">{summary.creditLimit === null ? (ar ? 'غير محدد' : 'Not set') : money(summary.creditLimit)}</div></div>
              <div className="detail-field"><div className="label">{ar ? 'شروط السداد' : 'Payment terms'}</div><div className="value">{customer.paymentTermsDays != null ? `${customer.paymentTermsDays} ${ar ? 'يوم' : 'days'}` : ar ? 'غير محدد' : 'Not set'}</div></div>
              <div className="detail-field"><div className="label">{ar ? 'الرصيد الحالي' : 'Current balance'}</div><div className="value">{money(summary.balance)}</div></div>
              <div className="detail-field"><div className="label">{ar ? 'المتاح من الائتمان' : 'Available credit'}</div><div className="value">{summary.availableCredit === null ? '—' : money(summary.availableCredit)}</div></div>
              <div className="detail-field"><div className="label">{ar ? 'المتأخر (إجمالي)' : 'Overdue (gross)'}</div><div className="value">{money(summary.overdue)}</div></div>
              <div className="detail-field"><div className="label">{ar ? 'المتأخر بعد الرصيد الدائن غير المطبّق' : 'Overdue after unapplied credit'}</div><div className="value">{money(summary.overdueNetOfUnappliedCredit)}</div></div>
              <div className="detail-field"><div className="label">{ar ? 'فواتير مفتوحة' : 'Open invoices'}</div><div className="value">{summary.openInvoices}</div></div>
              <div className="detail-field"><div className="label">{ar ? 'أقرب استحقاق' : 'Next due date'}</div><div className="value">{summary.nextDueDate ?? '—'}</div></div>
            </div>
          ) : (
            <div className="empty-state">{ar ? 'لا تتوفر مؤشرات الائتمان (الصلاحية مطلوبة).' : 'Credit indicators are not available (permission required).'}</div>
          )}
          <div style={{ marginTop: 12, fontSize: 13, opacity: 0.8 }}>{ar ? 'تعديل حد الائتمان وشروط السداد يتم من تبويب «الملف الشخصي» وفق صلاحياتك؛ هذه الشاشة للعرض فقط.' : 'Credit limit and payment terms are edited from the Profile tab according to your permissions; this tab is read-only.'}</div>
          {arAging.length > 0 && (
            <>
              <h4>{ar ? 'الفواتير المستحقة' : 'Open invoices'}</h4>
              <table className="data-table">
                <thead>
                  <tr><th>{t('field.invoice_number')}</th><th>{t('field.due_date')}</th><th>{ar ? 'المتبقي' : 'Remaining'}</th><th>{ar ? 'أيام التأخير' : 'Days late'}</th></tr>
                </thead>
                <tbody>
                  {arAging.map((a) => (
                    <tr key={a.invoiceId}><td><Link to={`/invoices/${a.invoiceId}`}>{a.invoiceNumber}</Link></td><td>{a.dueDate ? fmtDate(a.dueDate) : '—'}</td><td>{money(a.remaining)}</td><td>{a.daysOverdue}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {tab === 'invoices' && (
        <div>
          <details style={{ marginBottom: 20 }} data-testid="write-actions">
            <summary className="btn btn-secondary" style={{ cursor: 'pointer' }}>
              {ar ? 'إجراءات الكتابة: إنشاء فاتورة، تطبيق رصيد مرتجع، دفعة مقدمة/على الحساب' : 'Write actions: create invoice, apply return credit, advance / on-account payment'}
            </summary>
          <div className="card" style={{ marginBottom: 20, marginTop: 12 }}>
            <h3 style={{ marginTop: 0 }}>{t('action.create_invoice')}</h3>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.sales_order')}</label>
                <select value={newInvoiceOrderId} onChange={(e) => setNewInvoiceOrderId(e.target.value)}>
                  <option value="">—</option>
                  {ordersWithoutOpenInvoice.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.orderNumber}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary" disabled={!newInvoiceOrderId || busy === 'create-invoice'} onClick={createInvoice}>
                {t('action.create_invoice')}
              </button>
            </div>
          </div>

          {credits.length === 0 ? (
            <div className="empty-state" style={{ marginBottom: 20 }}>{t('panel.no_credits_available')}</div>
          ) : (
            <div className="card" style={{ marginBottom: 20 }}>
              <h3 style={{ marginTop: 0 }}>{t('action.apply_credit_to_invoice')}</h3>
              <table className="data-table" style={{ marginBottom: 12 }}>
                <thead>
                  <tr>
                    <th>{t('field.return_number')}</th>
                    <th>{t('field.original_sales_order')}</th>
                    <th>{t('field.credit_amount')}</th>
                    <th>{t('field.available_amount')}</th>
                    <th>{t('field.used_amount')}</th>
                    <th>{t('field.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {credits.map((c) => {
                    const derivedStatus = Number(c.remainingAmount) <= 0 ? 'fully_used' : Number(c.usedAmount) > 0 ? 'partially_used' : 'active';
                    return (
                      <tr key={c.id}>
                        <td>{c.returnNumber ?? c.id}</td>
                        <td>
                          <a onClick={() => navigate(`/sales-orders/${c.originalSalesOrderId}`)} style={{ cursor: 'pointer' }}>
                            {orders.find((o) => o.id === c.originalSalesOrderId)?.orderNumber ?? c.originalSalesOrderId}
                          </a>
                        </td>
                        <td>{c.originalAmount}</td>
                        <td>{c.remainingAmount}</td>
                        <td>{c.usedAmount}</td>
                        <td>{t(`return_credit_status.${derivedStatus}`)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {credits.map((c) => (
                <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
                  <div>
                    {c.returnNumber ?? c.id} — {t('field.remaining')}: {c.remainingAmount}
                  </div>
                  <select value={creditApplyInvoice[c.id] ?? ''} onChange={(e) => setCreditApplyInvoice((prev) => ({ ...prev, [c.id]: e.target.value }))}>
                    <option value="">{t('field.invoice')}</option>
                    {invoices
                      .filter((inv) => inv.state === 'posted' || inv.state === 'partially_paid')
                      .map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          {inv.invoiceNumber}
                        </option>
                      ))}
                  </select>
                  <input
                    type="number"
                    style={{ width: 100 }}
                    placeholder={c.remainingAmount}
                    value={creditApplyAmount[c.id] ?? ''}
                    onChange={(e) => setCreditApplyAmount((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  />
                  <button className="btn btn-secondary" disabled={busy === c.id + 'apply'} onClick={() => applyCreditToInvoice(c.id)}>
                    {t('action.apply_credit_to_invoice')}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ marginTop: 0 }}>{t('panel.customer_advance_unapplied')}</h3>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>{t('panel.on_account_note')}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
              <input type="number" min={0} step="0.01" style={{ width: 110 }} placeholder={t('field.total_amount')} value={onAccount.amount} onChange={(e) => setOnAccount({ ...onAccount, amount: e.target.value })} />
              <input style={{ width: 90 }} placeholder="method" value={onAccount.method} onChange={(e) => setOnAccount({ ...onAccount, method: e.target.value })} />
              <select value={onAccount.treasuryAccountId} onChange={(e) => setOnAccount({ ...onAccount, treasuryAccountId: e.target.value })}>
                <option value="">{t('field.treasury_account')}</option>
                {treasuryAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <select value={onAccount.salesOrderId} onChange={(e) => setOnAccount({ ...onAccount, salesOrderId: e.target.value })}>
                <option value="">{t('field.sales_order')}</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.orderNumber}
                  </option>
                ))}
              </select>
              <button className="btn btn-primary" disabled={busy === 'on-account'} onClick={recordOnAccount}>
                {t('action.record_on_account_payment')}
              </button>
            </div>
            {unapplied.length === 0 ? (
              <div className="empty-state" style={{ padding: 10 }}>{t('panel.no_unapplied_receipts')}</div>
            ) : (
              unapplied.map((u) => (
                <div key={u.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <div>
                    {u.paymentNumber} — {t('field.unapplied_amount')}: <strong>{u.unappliedAmount}</strong> / {u.amount}
                  </div>
                  <select value={unappliedInvoice[u.id] ?? ''} onChange={(e) => setUnappliedInvoice((prev) => ({ ...prev, [u.id]: e.target.value }))}>
                    <option value="">{t('field.invoice')}</option>
                    {invoices
                      .filter((inv) => inv.state === 'posted' || inv.state === 'partially_paid')
                      .map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          {inv.invoiceNumber} ({inv.remaining})
                        </option>
                      ))}
                  </select>
                  <input type="number" style={{ width: 100 }} placeholder={u.unappliedAmount} value={unappliedAmount[u.id] ?? ''} onChange={(e) => setUnappliedAmount((prev) => ({ ...prev, [u.id]: e.target.value }))} />
                  <button className="btn btn-secondary" disabled={busy === u.id + 'apply-unapplied'} onClick={() => applyUnapplied(u.id)}>
                    {t('action.apply_unapplied_payment')}
                  </button>
                </div>
              ))
            )}
          </div>

          </details>

          {invoices.length === 0 ? (
            <div className="empty-state">{t('panel.no_invoices_yet')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.invoice_number')}</th>
                  <th>{t('field.sales_order')}</th>
                  <th>{t('field.total_amount')}</th>
                  <th>{t('field.remaining')}</th>
                  <th>{t('field.due_date')}</th>
                  <th>{t('field.status')}</th>
                  <th>{t('field.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.invoiceNumber}</td>
                    <td>{orders.find((o) => o.id === inv.salesOrderId)?.orderNumber ?? inv.salesOrderId}</td>
                    <td>{inv.totalAmount}</td>
                    <td>{inv.remaining}</td>
                    <td>{inv.dueDate ? fmtDate(inv.dueDate) : '—'}</td>
                    <td>
                      <StatusBadge code={`sales_invoice_lifecycle.state.${inv.state}`} />
                    </td>
                    <td>
                      {inv.state === 'draft' && (
                        <button className="btn btn-primary" style={{ marginInlineEnd: 6 }} disabled={busy === inv.id + 'post'} onClick={() => postInvoice(inv.id)}>
                          {t('action.post_invoice')}
                        </button>
                      )}
                      {(inv.state === 'draft' || inv.state === 'posted') && (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          <input
                            style={{ width: 100 }}
                            placeholder="reason"
                            value={voidReason[inv.id] ?? ''}
                            onChange={(e) => setVoidReason((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                          />
                          <button className="btn btn-danger" disabled={busy === inv.id + 'void'} onClick={() => voidInvoice(inv.id)}>
                            {t('action.void_invoice')}
                          </button>
                        </span>
                      )}
                      {(inv.state === 'posted' || inv.state === 'partially_paid') && (
                        <div style={{ display: 'flex', gap: 4, marginTop: 6, alignItems: 'center' }}>
                          <input
                            type="number"
                            style={{ width: 80 }}
                            placeholder={inv.remaining}
                            value={paymentAmount[inv.id] ?? ''}
                            onChange={(e) => setPaymentAmount((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                          />
                          <input
                            style={{ width: 80 }}
                            placeholder="method"
                            value={paymentMethod[inv.id] ?? 'cash'}
                            onChange={(e) => setPaymentMethod((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                          />
                          <select value={paymentAccount[inv.id] ?? ''} onChange={(e) => setPaymentAccount((prev) => ({ ...prev, [inv.id]: e.target.value }))}>
                            <option value="">—</option>
                            {treasuryAccounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                          <button className="btn btn-secondary" disabled={busy === inv.id + 'payment'} onClick={() => recordPayment(inv.id)}>
                            {t('action.record_payment')}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {payments.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h3>{t('panel.payments')}</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.payment_number')}</th>
                    <th>{t('field.invoice')}</th>
                    <th>{t('field.total_amount')}</th>
                    <th>{t('field.payment_method')}</th>
                    <th>{t('field.date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td>{p.paymentNumber}</td>
                      <td>{p.invoiceId ? (invoices.find((i) => i.id === p.invoiceId)?.invoiceNumber ?? p.invoiceId) : t('panel.customer_advance_unapplied')}</td>
                      <td>{p.amount}</td>
                      <td>{nameOf(PAYMENT_METHODS, p.method, currentLang())}</td>
                      <td>{fmtDateTime(p.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'profile' && id && <CustomerProfileTab customerId={id} />}

      {tab === 'ar_aging' &&
        (arAging.length === 0 ? (
          <div className="empty-state">{t('panel.no_invoices_yet')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.invoice_number')}</th>
                <th>{t('field.due_date')}</th>
                <th>{t('field.total_amount')}</th>
                <th>{t('field.remaining')}</th>
                <th>{t('field.days_overdue')}</th>
                <th>{t('field.aging_bucket')}</th>
              </tr>
            </thead>
            <tbody>
              {arAging.map((row) => (
                <tr key={row.invoiceId}>
                  <td>{row.invoiceNumber}</td>
                  <td>{row.dueDate ? fmtDate(row.dueDate) : '—'}</td>
                  <td>{row.originalAmount}</td>
                  <td>{row.remaining}</td>
                  <td>{row.daysOverdue}</td>
                  <td>{row.bucket === 'current' ? t('aging_bucket.current') : row.bucket}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {openEntry && <LedgerEntryDrawer entryId={openEntry} onClose={() => setOpenEntry(null)} onOpen={setOpenEntry} onChanged={() => loadAll().catch(() => undefined)} />}
    </div>
  );
}
