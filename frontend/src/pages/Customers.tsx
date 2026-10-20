import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { ExcelImportExport } from '../components/ExcelImportExport';
import { nameOf, currentLang, STATUS_NAMES } from '../lib/displayNames';
import { fmtDate } from '../lib/formatDateTime';

const PAGE_SIZE = 50;

type CustomerStatus = 'pending' | 'active' | 'suspended';

interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  status: CustomerStatus;
  classification: string | null;
  orderWorkflowPolicy: 'standard' | 'open_account';
  priceListId: string | null;
  createdAt: string;
  // Gap G-5 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4) —
  // the real CRM master sheet's own fields, shown in the expandable
  // detail row below rather than crowding the main table.
  managerName: string | null;
  address: string | null;
  governorate: string | null;
  whatsappPhone: string | null;
  contactMethod: string | null;
  responsivenessLevel: string | null;
  disinterestNotes: string | null;
  priceSatisfactionLevel: string | null;
  topBrand: string | null;
  midBrand: string | null;
  lowBrand: string | null;
  shippingMethodPreference: string | null;
  locationUrl: string | null;
}
interface CustomersPage {
  rows: Customer[];
  total: number;
}

/** Mirrors `canTransitionCustomerStatus` (backend, customer-status.ts) — kept in sync deliberately; the server re-checks regardless. */
const NEXT_CUSTOMER_STATUS: Record<CustomerStatus, { to: CustomerStatus; actionCode: string } | null> = {
  pending: { to: 'active', actionCode: 'action.activate' },
  active: { to: 'suspended', actionCode: 'action.suspend' },
  suspended: { to: 'active', actionCode: 'action.reactivate' },
};
interface AdminUser {
  id: string;
  email: string;
  fullName: string;
}
interface PriceList {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
}

export function Customers() {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [reps, setReps] = useState<AdminUser[]>([]);
  const [assignSelections, setAssignSelections] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyAssign, setBusyAssign] = useState<string | null>(null);
  const [assignedMessage, setAssignedMessage] = useState<Record<string, string>>({});
  const [policySelections, setPolicySelections] = useState<Record<string, string>>({});
  const [busyPolicy, setBusyPolicy] = useState<string | null>(null);
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [priceListSelections, setPriceListSelections] = useState<Record<string, string>>({});
  const [busyPriceList, setBusyPriceList] = useState<string | null>(null);
  const [busyStatus, setBusyStatus] = useState<string | null>(null);
  const [assignmentTypes, setAssignmentTypes] = useState<Record<string, 'primary' | 'secondary'>>({});
  const [classificationDrafts, setClassificationDrafts] = useState<Record<string, string>>({});
  const [busyClassification, setBusyClassification] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  preload([
    'nav.customers',
    'action.previous_page',
    'action.next_page',
    'field.page_of_total',
    'action.create',
    'action.save',
    'action.view_account',
    'field.status',
    'field.created_at',
    'field.code',
    'field.name',
    'field.phone',
    'field.assign_role',
    'field.order_workflow_policy',
    'workflow_policy.standard',
    'workflow_policy.open_account',
    'field.customer_price_list',
    'field.no_override',
    'field.classification',
    'action.activate',
    'action.suspend',
    'action.reactivate',
    'assignment_type.primary',
    'assignment_type.secondary',
    'panel.no_customers_yet',
    'role.sales_rep',
    'action.download_template',
    'action.export_excel',
    'action.import_excel',
    'field.total_rows',
    'field.succeeded_rows',
    'field.rejected_rows',
    'field.row',
    'field.errors',
    'field.governorate',
    'field.manager_name',
    'field.address',
    'field.whatsapp_phone',
    'field.contact_method',
    'field.responsiveness_level',
    'field.disinterest_notes',
    'field.price_satisfaction_level',
    'field.top_brand',
    'field.mid_brand',
    'field.low_brand',
    'field.shipping_method_preference',
    'field.location_url',
    'action.view_details',
  ]);

  async function load() {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      const data = await api.get<CustomersPage>(`/customers?${params.toString()}`);
      setCustomers(data.rows);
      setTotal(data.total);
      if (can('sales.customer.assign', 'editable')) {
        // F5: the Company's own sales reps (the former `/admin/users` was the platform's user table).
        const users = await api.get<AdminUser[]>('/admin/sales-reps').catch(() => [] as AdminUser[]);
        setReps(users);
      }
      if (can('sales.customer.edit', 'editable')) {
        const lists = await api.get<PriceList[]>('/price-lists');
        setPriceLists(lists);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load customers.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/customers', { name, phone: phone || undefined });
      setName('');
      setPhone('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create customer.');
    } finally {
      setCreating(false);
    }
  }

  async function assignRep(customerId: string) {
    const salesRepUserId = assignSelections[customerId];
    if (!salesRepUserId) return;
    const assignmentType = assignmentTypes[customerId] ?? 'primary';
    setBusyAssign(customerId);
    setError(null);
    try {
      await api.post(`/customers/${customerId}/assign`, { salesRepUserId, assignmentType });
      const rep = reps.find((r) => r.id === salesRepUserId);
      setAssignedMessage((prev) => ({ ...prev, [customerId]: `${rep?.fullName ?? salesRepUserId} (${t(`assignment_type.${assignmentType}`)})` }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign sales rep.');
    } finally {
      setBusyAssign(null);
    }
  }

  async function transitionStatus(customerId: string, to: CustomerStatus) {
    setBusyStatus(customerId);
    setError(null);
    try {
      await api.post(`/customers/${customerId}/status`, { status: to });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change customer status.');
    } finally {
      setBusyStatus(null);
    }
  }

  async function saveClassification(customerId: string) {
    if (!(customerId in classificationDrafts)) return;
    setBusyClassification(customerId);
    setError(null);
    try {
      await api.post(`/customers/${customerId}/classification`, { classification: classificationDrafts[customerId] });
      await load();
      setClassificationDrafts((prev) => {
        const next = { ...prev };
        delete next[customerId];
        return next;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update classification.');
    } finally {
      setBusyClassification(null);
    }
  }

  async function savePolicy(customerId: string) {
    const orderWorkflowPolicy = policySelections[customerId];
    if (!orderWorkflowPolicy) return;
    setBusyPolicy(customerId);
    setError(null);
    try {
      await api.post(`/customers/${customerId}/workflow-policy`, { orderWorkflowPolicy });
      await load();
      setPolicySelections((prev) => {
        const next = { ...prev };
        delete next[customerId];
        return next;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update workflow policy.');
    } finally {
      setBusyPolicy(null);
    }
  }

  async function savePriceList(customerId: string) {
    if (!(customerId in priceListSelections)) return;
    const selected = priceListSelections[customerId];
    setBusyPriceList(customerId);
    setError(null);
    try {
      await api.post(`/customers/${customerId}/price-list`, { priceListId: selected || null });
      await load();
      setPriceListSelections((prev) => {
        const next = { ...prev };
        delete next[customerId];
        return next;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update price list.');
    } finally {
      setBusyPriceList(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.customers')}</h1>
      </div>

      <ExcelImportExport
        templateUrl="/api/customers/import-template"
        exportUrl="/api/customers/export"
        importUrl="/api/customers/import"
        onImported={load}
      />

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.name')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.phone')}</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {t('action.create')}
          </button>
        </form>
      </div>

      {error && <div className="error-text">{error}</div>}

      {customers === null ? (
        <div className="empty-state">Loading…</div>
      ) : customers.length === 0 ? (
        <div className="empty-state">{t('panel.no_customers_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.code')}</th>
              <th>{t('field.name')}</th>
              <th>{t('field.phone')}</th>
              <th>{t('field.governorate')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.created_at')}</th>
              <th>{t('field.actions')}</th>
              {can('sales.customer.assign', 'editable') && <th>{t('role.sales_rep')}</th>}
              {can('sales.customer.edit', 'editable') && <th>{t('field.classification')}</th>}
              {can('sales.customer.edit', 'editable') && <th>{t('field.order_workflow_policy')}</th>}
              {can('sales.customer.edit', 'editable') && <th>{t('field.customer_price_list')}</th>}
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <Fragment key={c.id}>
              <tr>
                <td>{c.code}</td>
                <td>{c.name}</td>
                <td>{c.phone ?? '—'}</td>
                <td>{c.governorate ?? '—'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span className="status-badge">{nameOf(STATUS_NAMES, c.status, currentLang())}</span>
                    {can('sales.customer_status.edit', 'editable') && NEXT_CUSTOMER_STATUS[c.status] && (
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '2px 8px', fontSize: '0.78rem' }}
                        disabled={busyStatus === c.id}
                        onClick={() => transitionStatus(c.id, NEXT_CUSTOMER_STATUS[c.status]!.to)}
                      >
                        {busyStatus === c.id ? '...' : t(NEXT_CUSTOMER_STATUS[c.status]!.actionCode)}
                      </button>
                    )}
                  </div>
                </td>
                <td>{fmtDate(c.createdAt)}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary" onClick={() => window.open(`/print/customer/${c.id}`, '_blank')}>
                    {t('action.print')}
                  </button>
                  <button className="btn btn-secondary" onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}>
                    {t('action.view_details')}
                  </button>
                  <button className="btn btn-secondary" onClick={() => navigate(`/customers/${c.id}/account`)}>
                    {t('action.view_account')}
                  </button>
                </td>
                {can('sales.customer.assign', 'editable') && (
                  <td>
                    {assignedMessage[c.id] ? (
                      <span className="status-badge positive">{assignedMessage[c.id]}</span>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <select
                          value={assignSelections[c.id] ?? ''}
                          onChange={(e) => setAssignSelections((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        >
                          <option value="">—</option>
                          {reps.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.fullName}
                            </option>
                          ))}
                        </select>
                        <select
                          value={assignmentTypes[c.id] ?? 'primary'}
                          onChange={(e) => setAssignmentTypes((prev) => ({ ...prev, [c.id]: e.target.value as 'primary' | 'secondary' }))}
                          style={{ width: 100 }}
                        >
                          <option value="primary">{t('assignment_type.primary')}</option>
                          <option value="secondary">{t('assignment_type.secondary')}</option>
                        </select>
                        <button
                          className="btn btn-secondary"
                          disabled={busyAssign === c.id || !assignSelections[c.id]}
                          onClick={() => assignRep(c.id)}
                        >
                          {t('action.assign')}
                        </button>
                      </div>
                    )}
                  </td>
                )}
                {can('sales.customer.edit', 'editable') && (
                  <td>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        value={classificationDrafts[c.id] ?? c.classification ?? ''}
                        onChange={(e) => setClassificationDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        style={{ width: 120 }}
                      />
                      {(classificationDrafts[c.id] ?? c.classification ?? '') !== (c.classification ?? '') && (
                        <button className="btn btn-secondary" disabled={busyClassification === c.id} onClick={() => saveClassification(c.id)}>
                          {busyClassification === c.id ? '...' : t('action.save')}
                        </button>
                      )}
                    </div>
                  </td>
                )}
                {can('sales.customer.edit', 'editable') && (
                  <td>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select
                        value={policySelections[c.id] ?? c.orderWorkflowPolicy}
                        onChange={(e) => setPolicySelections((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      >
                        <option value="standard">{t('workflow_policy.standard')}</option>
                        <option value="open_account">{t('workflow_policy.open_account')}</option>
                      </select>
                      {policySelections[c.id] && policySelections[c.id] !== c.orderWorkflowPolicy && (
                        <button
                          className="btn btn-secondary"
                          disabled={busyPolicy === c.id}
                          onClick={() => savePolicy(c.id)}
                        >
                          {busyPolicy === c.id ? '...' : t('action.save')}
                        </button>
                      )}
                    </div>
                  </td>
                )}
                {can('sales.customer.edit', 'editable') && (
                  <td>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select
                        value={priceListSelections[c.id] ?? c.priceListId ?? ''}
                        onChange={(e) => setPriceListSelections((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      >
                        <option value="">{t('field.no_override')}</option>
                        {priceLists.map((pl) => (
                          <option key={pl.id} value={pl.id}>
                            {pl.code} — {pl.name}
                          </option>
                        ))}
                      </select>
                      {(priceListSelections[c.id] ?? c.priceListId ?? '') !== (c.priceListId ?? '') && (
                        <button
                          className="btn btn-secondary"
                          disabled={busyPriceList === c.id}
                          onClick={() => savePriceList(c.id)}
                        >
                          {busyPriceList === c.id ? '...' : t('action.save')}
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
              {expandedId === c.id && (
                <tr>
                  <td colSpan={100}>
                    <div className="card" style={{ margin: '8px 0' }}>
                      <div className="detail-grid">
                        <div className="detail-field">
                          <div className="label">{t('field.manager_name')}</div>
                          <div className="value">{c.managerName ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.address')}</div>
                          <div className="value">{c.address ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.whatsapp_phone')}</div>
                          <div className="value">{c.whatsappPhone ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.contact_method')}</div>
                          <div className="value">{c.contactMethod ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.responsiveness_level')}</div>
                          <div className="value">{c.responsivenessLevel ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.price_satisfaction_level')}</div>
                          <div className="value">{c.priceSatisfactionLevel ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.top_brand')}</div>
                          <div className="value">{c.topBrand ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.mid_brand')}</div>
                          <div className="value">{c.midBrand ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.low_brand')}</div>
                          <div className="value">{c.lowBrand ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.shipping_method_preference')}</div>
                          <div className="value">{c.shippingMethodPreference ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.disinterest_notes')}</div>
                          <div className="value">{c.disinterestNotes ?? '—'}</div>
                        </div>
                        <div className="detail-field">
                          <div className="label">{t('field.location_url')}</div>
                          <div className="value">
                            {c.locationUrl ? (
                              <a href={c.locationUrl} target="_blank" rel="noreferrer">
                                {c.locationUrl}
                              </a>
                            ) : (
                              '—'
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {customers !== null && customers.length > 0 && (
        <div className="action-row" style={{ marginTop: 14, alignItems: 'center' }}>
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t('action.previous_page')}
          </button>
          <span style={{ fontSize: '0.85rem', color: '#6b7280' }}>
            {t('field.page_of_total').replace('{page}', String(page)).replace('{total}', String(totalPages))}
          </span>
          <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            {t('action.next_page')}
          </button>
        </div>
      )}
    </div>
  );
}
