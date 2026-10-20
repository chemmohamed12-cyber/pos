import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ProfileFieldsCard, type ProfileField } from '../../components/profile/ProfileFieldsCard';
import { ProfileContactsPanel, type ProfileContact } from '../../components/profile/ProfileContactsPanel';
import { ProfileAddressesPanel, type ProfileAddress } from '../../components/profile/ProfileAddressesPanel';
import { nameOf, currentLang, PAYMENT_METHODS } from '../../lib/displayNames';
import { fmtDate } from '../../lib/formatDateTime';

/**
 * Supplier profile (master-data gap matrix §5) — one page over the EXISTING supplier APIs plus the shared profile components used by the
 * customer profile. The "Purchases" tab only QUERIES by supplier (purchase orders, supplier invoices, supplier payments): nothing is copied
 * or duplicated, so the supplier ledger, statement and payment flows stay the single source of truth.
 */
interface SupplierDetail {
  supplier: Record<string, string | number | null> & { id: string; code: string; legalName: string; status: 'active' | 'inactive' };
  contacts: ProfileContact[];
  addresses: ProfileAddress[];
  bankAccounts: Array<{ id: string; bankName: string; accountNumber: string; iban: string | null; approvalStatus: 'pending' | 'approved' | 'rejected' }>;
}
interface PoRow {
  id: string;
  poNumber: string;
  totalAmountBase: string;
  createdAt: string;
  state: string;
}
interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  totalAmount: string;
  remaining: string;
  state: string;
  dueDate: string | null;
}
interface PaymentRow {
  id: string;
  paymentNumber: string;
  amount: string;
  method: string;
  occurredAt: string;
}

const FIELDS: ProfileField[] = [
  { key: 'legalName', labelCode: 'field.legal_name' },
  { key: 'tradingName', labelCode: 'field.trading_name' },
  {
    key: 'supplierType',
    labelCode: 'field.supplier_type',
    kind: 'select',
    options: [
      { value: 'company', labelCode: 'value.supplier_type.company' },
      { value: 'individual', labelCode: 'value.supplier_type.individual' },
    ],
  },
  { key: 'taxRegistrationNumber', labelCode: 'field.tax_registration_number' },
  { key: 'vatRegistrationNumber', labelCode: 'field.vat_registration_number' },
  { key: 'commercialRegistrationNumber', labelCode: 'field.commercial_registration_number' },
  { key: 'email', labelCode: 'field.email', kind: 'email' },
  { key: 'website', labelCode: 'field.website', kind: 'url' },
  {
    key: 'language',
    labelCode: 'field.language',
    kind: 'select',
    options: [
      { value: 'ar', labelCode: 'value.language.ar' },
      { value: 'en', labelCode: 'value.language.en' },
    ],
  },
  { key: 'internalNotes', labelCode: 'field.internal_notes', kind: 'textarea', wide: true },
];

type Tab = 'profile' | 'purchases';

export function SupplierProfile() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  preload([
    'panel.supplier_profile',
    'panel.supplier_purchases',
    'panel.purchase_orders',
    'panel.supplier_invoices',
    'panel.supplier_payments',
    'panel.bank_accounts',
    'panel.no_records_yet',
    'action.back_to_suppliers',
    'nav.suppliers',
    'field.po_number',
    'field.date',
    'field.total_amount',
    'field.status',
    'field.invoice_number',
    'field.due_date',
    'field.remaining',
    'field.payment_number',
    'field.amount',
    'field.method',
    'field.bank_name',
    'field.account_number',
    'field.approval_status',
    'field.iban',
  ]);
  const canEdit = can('procurement.supplier.edit', 'editable');
  const [tab, setTab] = useState<Tab>('profile');
  const [detail, setDetail] = useState<SupplierDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<PoRow[] | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [purchasesError, setPurchasesError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.get<SupplierDetail>(`/procurement/suppliers/${id}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the supplier.');
    }
  }, [id]);

  useEffect(() => {
    // load() sets state only after the awaited request resolves (not synchronously); the rule cannot see through the callback.
    // eslint-disable-next-line react/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'purchases' || orders !== null) return;
    // Each list is its own existing endpoint with its own permission: a user who cannot see one still sees the others.
    const safe = <T,>(request: Promise<T>, set: (v: T) => void) =>
      request.then(set).catch((err) => {
        set([] as unknown as T);
        setPurchasesError(err instanceof ApiError && err.status !== 403 ? err.message : null);
      });
    void safe(api.get<PoRow[]>(`/procurement/purchase-orders?supplierId=${id}`), setOrders);
    void safe(api.get<InvoiceRow[]>(`/procurement/supplier-invoices/by-supplier/${id}`), setInvoices);
    void safe(api.get<PaymentRow[]>(`/procurement/supplier-payments/by-supplier/${id}`), setPayments);
  }, [tab, id, orders]);

  if (error) return <div className="error-text">{error}</div>;
  if (!detail) return <div className="empty-state">Loading…</div>;

  const base = `/procurement/suppliers/${id}`;
  const s = detail.supplier;
  const tabButton = (key: Tab, labelCode: string) => (
    <button className={tab === key ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setTab(key)}>
      {t(labelCode)}
    </button>
  );
  const empty = <div className="empty-state">{t('panel.no_records_yet')}</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <div style={{ fontSize: 13, opacity: 0.75 }}>
            <Link to="/suppliers">{t('nav.suppliers')}</Link> / {t('panel.supplier_profile')}
          </div>
          <h1 style={{ margin: 0 }}>{s.legalName}</h1>
          <div style={{ opacity: 0.75 }}>
            {s.code} · <StatusBadge code={`supplier_status.${s.status}`} />
          </div>
        </div>
        <Link className="btn btn-secondary" to="/suppliers">
          {t('action.back_to_suppliers')}
        </Link>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {tabButton('profile', 'panel.supplier_profile')}
        {tabButton('purchases', 'panel.supplier_purchases')}
      </div>

      {tab === 'profile' && (
        <>
          <ProfileFieldsCard
            titleCode="panel.supplier_profile"
            fields={FIELDS}
            values={s as unknown as Record<string, string | null>}
            canEdit={canEdit}
            onSave={async (patch) => {
              await api.post(`${base}/update`, patch);
              await load();
            }}
          />
          <ProfileContactsPanel
            contacts={detail.contacts}
            canEdit={canEdit}
            onAdd={async (input) => {
              await api.post(`${base}/contacts`, input);
              await load();
            }}
            onSetPrimary={async (contactId) => {
              await api.post(`${base}/contacts/${contactId}/update`, { isPrimary: true });
              await load();
            }}
            onRemove={async (contactId) => {
              await api.post(`${base}/contacts/${contactId}/remove`, {});
              await load();
            }}
          />
          <ProfileAddressesPanel
            addresses={detail.addresses}
            canEdit={canEdit}
            onAdd={async (input) => {
              await api.post(`${base}/addresses`, input);
              await load();
            }}
            onSetDefault={async (addressId) => {
              await api.post(`${base}/addresses/${addressId}/update`, { isDefault: true });
              await load();
            }}
            onRemove={async (addressId) => {
              await api.post(`${base}/addresses/${addressId}/remove`, {});
              await load();
            }}
          />
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ marginTop: 0 }}>{t('panel.bank_accounts')}</h3>
            {detail.bankAccounts.length === 0 ? (
              empty
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.bank_name')}</th>
                    <th>{t('field.account_number')}</th>
                    <th>{t('field.iban')}</th>
                    <th>{t('field.approval_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.bankAccounts.map((b) => (
                    <tr key={b.id}>
                      <td>{b.bankName}</td>
                      <td>{b.accountNumber}</td>
                      <td>{b.iban ?? '—'}</td>
                      <td>
                        <StatusBadge code={`value.approval_status.${b.approvalStatus}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === 'purchases' && (
        <>
          {purchasesError && <div className="error-text">{purchasesError}</div>}
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ marginTop: 0 }}>{t('panel.purchase_orders')}</h3>
            {orders === null ? (
              <div className="empty-state">Loading…</div>
            ) : orders.length === 0 ? (
              empty
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.po_number')}</th>
                    <th>{t('field.date')}</th>
                    <th>{t('field.total_amount')}</th>
                    <th>{t('field.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td>{o.poNumber}</td>
                      <td>{fmtDate(o.createdAt)}</td>
                      <td>{o.totalAmountBase}</td>
                      <td>
                        <StatusBadge code={`purchase_order_lifecycle.state.${o.state}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ marginTop: 0 }}>{t('panel.supplier_invoices')}</h3>
            {invoices === null ? (
              <div className="empty-state">Loading…</div>
            ) : invoices.length === 0 ? (
              empty
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.invoice_number')}</th>
                    <th>{t('field.due_date')}</th>
                    <th>{t('field.total_amount')}</th>
                    <th>{t('field.remaining')}</th>
                    <th>{t('field.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td>{i.invoiceNumber}</td>
                      <td>{i.dueDate ? fmtDate(i.dueDate) : '—'}</td>
                      <td>{i.totalAmount}</td>
                      <td>{i.remaining}</td>
                      <td>
                        <StatusBadge code={`supplier_invoice_lifecycle.state.${i.state}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ marginTop: 0 }}>{t('panel.supplier_payments')}</h3>
            {payments === null ? (
              <div className="empty-state">Loading…</div>
            ) : payments.length === 0 ? (
              empty
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.payment_number')}</th>
                    <th>{t('field.date')}</th>
                    <th>{t('field.amount')}</th>
                    <th>{t('field.method')}</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td>{p.paymentNumber}</td>
                      <td>{fmtDate(p.occurredAt)}</td>
                      <td>{p.amount}</td>
                      <td>{nameOf(PAYMENT_METHODS, p.method, currentLang())}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
