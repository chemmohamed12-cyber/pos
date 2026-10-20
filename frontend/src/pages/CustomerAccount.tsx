import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { CustomerProfileTab } from './CustomerProfileTab';
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

type Tab = 'ledger' | 'invoices' | 'ar_aging' | 'profile';

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
  const { t, preload } = useLanguage();

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
  const lastInvoice = [...invoices].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  const lastPayment = [...payments].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())[0];

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

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.phone')}</div>
            <div>{customer.phone ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.governorate')}</div>
            <div>{customer.governorate ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.address')}</div>
            <div>{customer.address ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.sales_representative')}</div>
            <div>{primaryRep ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.status')}</div>
            <div>{nameOf(STATUS_NAMES, customer.status, currentLang())}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.account_type')}</div>
            <div>{t(`account_type.${customer.accountType}`)}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.financial_status')}</div>
            <div>{t(`financial_status.${customer.financialStatus}`)}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.credit_limit')}</div>
            <div>{customer.creditLimit ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.payment_terms_days')}</div>
            <div>{customer.paymentTermsDays ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.available_credit')}</div>
            <div>{statement.availableCredit ?? '—'}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.last_invoice')}</div>
            <div>{lastInvoice ? lastInvoice.invoiceNumber : '—'}</div>
          </div>
          <div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>{t('field.last_payment')}</div>
            <div>{lastPayment ? `${lastPayment.paymentNumber} (${lastPayment.amount})` : '—'}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        <button className="btn btn-secondary" onClick={() => navigate(`/customer-statement?customerId=${id}`)}>
          {t('nav.customer_statement')}
        </button>
        <button className="btn btn-secondary" onClick={() => setTab('invoices')}>
          {t('panel.invoices')}
        </button>
        <button className="btn btn-secondary" onClick={() => navigate(`/customer-statement?customerId=${id}&entryType=deposit`)}>
          {t('customer_ledger_entry_type.deposit')}
        </button>
        <button className="btn btn-secondary" onClick={() => navigate('/returns')}>
          {t('nav.returns')}
        </button>
        <button className="btn btn-secondary" onClick={() => navigate(`/customer-statement?customerId=${id}&entryType=return_credit_note`)}>
          {t('customer_ledger_entry_type.return_credit_note')}
        </button>
        <button className="btn btn-secondary" onClick={() => navigate(`/customer-statement?customerId=${id}&entryType=adjustment`)}>
          {t('customer_ledger_entry_type.adjustment')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        {(
          [
            ['balance', 'field.balance'],
            ['totalSales', 'field.total_sales'],
            ['totalPaid', 'field.total_paid'],
            ['totalOutstanding', 'field.total_outstanding'],
            ['overdueAmount', 'field.overdue_amount'],
            ['totalReturns', 'field.total_returns'],
          ] as const
        ).map(([key, labelKey]) => (
          <div key={key} className="card" style={{ minWidth: 150, textAlign: 'center' }}>
            <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{statement[key]}</div>
            <div style={{ color: '#6b7280' }}>{t(labelKey)}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={tab === 'ledger' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('ledger')}>
          {t('panel.customer_ledger')}
        </button>
        <button className={tab === 'invoices' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('invoices')}>
          {t('panel.invoices')}
        </button>
        <button className={tab === 'ar_aging' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('ar_aging')}>
          {t('panel.ar_aging')}
        </button>
        <button className={tab === 'profile' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab('profile')}>
          {t('panel.customer_profile')}
        </button>
        <button className="btn btn-secondary" onClick={() => navigate('/returns')}>
          {t('nav.returns')}
        </button>
        <button className="btn btn-secondary" onClick={() => navigate('/sales-orders')}>
          {t('nav.sales_orders')}
        </button>
      </div>

      {tab === 'ledger' &&
        (statement.entries.length === 0 ? (
          <div className="empty-state">{t('panel.no_ledger_entries_yet')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.date')}</th>
                <th>{t('field.type')}</th>
                <th>{t('field.reference')}</th>
                <th>{t('field.description')}</th>
                <th>{t('field.debit')}</th>
                <th>{t('field.credit')}</th>
                <th>{t('field.running_balance')}</th>
                <th>{t('field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {statement.entries.map((entry, idx) => (
                <tr
                  key={`${entry.reference}-${idx}`}
                  style={{ cursor: entry.salesOrderId ? 'pointer' : 'default', opacity: entry.status === 'reversed' ? 0.5 : 1 }}
                  onClick={() => entry.salesOrderId && navigate(`/sales-orders/${entry.salesOrderId}`)}
                >
                  <td>{fmtDateTime(entry.date)}</td>
                  <td>{t(`customer_ledger_entry_type.${entry.type}`)}</td>
                  <td>{entry.reference}</td>
                  <td>{entry.description}</td>
                  <td>{entry.debit !== '0.00' ? entry.debit : '—'}</td>
                  <td>{entry.credit !== '0.00' ? entry.credit : '—'}</td>
                  <td>{entry.runningBalance}</td>
                  <td>{nameOf(STATUS_NAMES, entry.status, currentLang())}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      {tab === 'invoices' && (
        <div>
          <div className="card" style={{ marginBottom: 20 }}>
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
    </div>
  );
}
