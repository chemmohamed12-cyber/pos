import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { ExcelImportExport } from '../components/ExcelImportExport';
import { STATUS_NAMES, currentLang, loadingLabel, nameOf } from '../lib/displayNames';
import { fmtDate } from '../lib/formatDateTime';
import { useDefaultCode } from '../lib/useDefaultCode';
import { CodeField } from '../components/CodeField';

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
  // Gap G-5 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4) — the real CRM master sheet's own fields, shown in the detail card.
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

/** The editable profile fields (`POST /customers/:id/update`); a blank value clears the field on the server. */
const EMPTY_FORM = {
  name: '',
  phone: '',
  whatsappPhone: '',
  managerName: '',
  address: '',
  governorate: '',
  partyType: '',
  legalName: '',
  taxRegistrationNumber: '',
  vatRegistrationNumber: '',
  commercialRegistrationNumber: '',
  email: '',
  website: '',
  language: '',
  internalNotes: '',
};
type ProfileForm = typeof EMPTY_FORM;

/**
 * Customers — laid out like the Suppliers screens: one form on top that adds a customer or (after "Edit") changes the selected one, a compact list, and a detail card for the selected customer
 * that carries the per-customer settings that used to widen the table (sales rep, classification, order policy, price list). Edits go through the existing `POST /customers/:id/update`.
 */
export function Customers() {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const ar = currentLang() === 'ar';
  const L = (a: string, e: string) => (ar ? a : e);
  const canEdit = can('sales.customer.edit', 'editable');
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [reps, setReps] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Owner request 2026-10-20: the customer code starts as the next automatic serial (CUST-000001 …), editable; a duplicate is refused by the server.
  const code = useDefaultCode('/customers/next-code');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [assignRepId, setAssignRepId] = useState('');
  const [assignType, setAssignType] = useState<'primary' | 'secondary'>('primary');
  const [assignedMessage, setAssignedMessage] = useState<Record<string, string>>({});
  const [classificationDraft, setClassificationDraft] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<string | null>(null);
  const [priceListDraft, setPriceListDraft] = useState<string | null>(null);
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  preload([
    'nav.customers',
    'action.previous_page',
    'action.next_page',
    'field.page_of_total',
    'action.create',
    'action.save',
    'action.cancel',
    'action.view_account',
    'action.print',
    'action.assign',
    'field.status',
    'field.created_at',
    'field.code',
    'field.name',
    'field.phone',
    'field.actions',
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
    'field.party_type',
    'value.party_type.company',
    'value.party_type.individual',
    'field.legal_name',
    'field.tax_registration_number',
    'field.vat_registration_number',
    'field.commercial_registration_number',
    'field.email',
    'field.website',
    'field.language',
    'value.language.ar',
    'value.language.en',
    'field.internal_notes',
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
      if (canEdit) {
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
  const selected = customers?.find((c) => c.id === selectedId) ?? null;

  function select(id: string) {
    setSelectedId(id);
    setClassificationDraft(null);
    setPolicyDraft(null);
    setPriceListDraft(null);
    setAssignRepId('');
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/customers', { code: code.payloadCode(), name, phone: phone || undefined });
      void code.reset();
      setName('');
      setPhone('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create customer.');
    } finally {
      setCreating(false);
    }
  }

  async function startEdit(c: Customer) {
    setError(null);
    try {
      // the list row has no e-mail / legal data: the profile endpoint returns the whole editable record
      const p = await api.get<{ customer: Record<string, string | null> }>(`/customers/${c.id}/profile`);
      const next = { ...EMPTY_FORM };
      for (const k of Object.keys(EMPTY_FORM) as Array<keyof ProfileForm>) next[k] = p.customer[k] ?? '';
      setForm(next);
      setEditingId(c.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load customer data.');
    }
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, string | null> = {};
      for (const k of Object.keys(EMPTY_FORM) as Array<keyof ProfileForm>) body[k] = form[k].trim() === '' ? (k === 'name' ? form[k] : null) : form[k].trim();
      await api.post(`/customers/${editingId}/update`, body);
      setEditingId(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save customer.');
    } finally {
      setSaving(false);
    }
  }

  async function run(key: string, fn: () => Promise<void>, failure: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : failure);
    } finally {
      setBusy(null);
    }
  }

  const transitionStatus = (c: Customer, to: CustomerStatus) =>
    run('status:' + c.id, async () => {
      await api.post(`/customers/${c.id}/status`, { status: to });
      await load();
    }, 'Failed to change customer status.');

  const assignRep = (c: Customer) =>
    run('assign', async () => {
      await api.post(`/customers/${c.id}/assign`, { salesRepUserId: assignRepId, assignmentType: assignType });
      const rep = reps.find((r) => r.id === assignRepId);
      setAssignedMessage((prev) => ({ ...prev, [c.id]: `${rep?.fullName ?? assignRepId} (${t(`assignment_type.${assignType}`)})` }));
      setAssignRepId('');
    }, 'Failed to assign sales rep.');

  const saveClassification = (c: Customer) =>
    run('classification', async () => {
      await api.post(`/customers/${c.id}/classification`, { classification: classificationDraft ?? '' });
      setClassificationDraft(null);
      await load();
    }, 'Failed to update classification.');

  const savePolicy = (c: Customer) =>
    run('policy', async () => {
      await api.post(`/customers/${c.id}/workflow-policy`, { orderWorkflowPolicy: policyDraft });
      setPolicyDraft(null);
      await load();
    }, 'Failed to update workflow policy.');

  const savePriceList = (c: Customer) =>
    run('priceList', async () => {
      await api.post(`/customers/${c.id}/price-list`, { priceListId: priceListDraft || null });
      setPriceListDraft(null);
      await load();
    }, 'Failed to update price list.');

  const setF = (k: keyof ProfileForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const textField = (k: keyof ProfileForm, label: string, opts?: { required?: boolean; type?: string; width?: number; wide?: boolean }) => (
    <div className="form-field" style={{ marginBottom: 0, minWidth: opts?.wide ? 320 : 170, flex: opts?.wide ? '1 1 320px' : undefined }}>
      <label>{label}</label>
      <input type={opts?.type ?? 'text'} value={form[k]} onChange={(e) => setF(k, e.target.value)} required={opts?.required} style={opts?.width ? { width: opts.width } : undefined} />
    </div>
  );

  const detailRow = (label: string, value: string | null | undefined) => (
    <div className="detail-field" style={{ marginBottom: 6 }}>
      <div className="label">{label}</div>
      <div className="value">{value || '—'}</div>
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.customers')}</h1>
      </div>

      <ExcelImportExport templateUrl="/api/customers/import-template" exportUrl="/api/customers/export" importUrl="/api/customers/import" onImported={load} />

      <div className="card" style={{ marginBottom: 20 }}>
        {editingId ? (
          <form onSubmit={onSaveEdit} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {textField('name', t('field.name'), { required: true })}
            {textField('phone', t('field.phone'))}
            {textField('whatsappPhone', t('field.whatsapp_phone'))}
            {textField('managerName', t('field.manager_name'))}
            {textField('governorate', t('field.governorate'))}
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.party_type')}</label>
              <select value={form.partyType} onChange={(e) => setF('partyType', e.target.value)}>
                <option value="">—</option>
                <option value="company">{t('value.party_type.company')}</option>
                <option value="individual">{t('value.party_type.individual')}</option>
              </select>
            </div>
            {textField('legalName', t('field.legal_name'))}
            {textField('taxRegistrationNumber', t('field.tax_registration_number'), { width: 150 })}
            {textField('vatRegistrationNumber', t('field.vat_registration_number'), { width: 150 })}
            {textField('commercialRegistrationNumber', t('field.commercial_registration_number'), { width: 150 })}
            {textField('email', t('field.email'), { type: 'email' })}
            {textField('website', t('field.website'))}
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.language')}</label>
              <select value={form.language} onChange={(e) => setF('language', e.target.value)}>
                <option value="">—</option>
                <option value="ar">{t('value.language.ar')}</option>
                <option value="en">{t('value.language.en')}</option>
              </select>
            </div>
            {textField('address', t('field.address'), { wide: true })}
            {textField('internalNotes', t('field.internal_notes'), { wide: true })}
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {t('action.save')}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setEditingId(null);
                setForm(EMPTY_FORM);
              }}
            >
              {t('action.cancel')}
            </button>
          </form>
        ) : (
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <CodeField label={L('كود العميل', 'Customer code')} value={code.value} onChange={code.setValue} defaultCode={code.defaultCode} isCustom={code.isCustom} onUseDefault={code.restoreDefault} />
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
        )}
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          {editingId
            ? L('تعديل بيانات العميل المحدد. كود العميل لا يتغير بعد الحفظ.', 'Editing the selected customer. The customer code cannot be changed after saving.')
            : L('يُقترح كود العميل تلقائيًا ويمكن تعديله عند الإضافة. لتعديل بيانات عميل: اختره من القائمة ثم اضغط «تعديل».', 'The customer code is suggested automatically and can be changed when adding. To change a customer: select it in the list, then press "Edit".')}
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          {customers === null ? (
            <div className="empty-state">{loadingLabel()}</div>
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
                  <th>{t('field.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} style={{ cursor: 'pointer', background: c.id === selectedId ? 'rgba(37, 99, 235, 0.06)' : undefined }} onClick={() => select(c.id)}>
                    <td>{c.code}</td>
                    <td>{c.name}</td>
                    <td>{c.phone ?? '—'}</td>
                    <td>{c.governorate ?? '—'}</td>
                    <td>
                      <span className="status-badge">{nameOf(STATUS_NAMES, c.status, currentLang())}</span>
                    </td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {canEdit && (
                        <button
                          className="btn btn-secondary"
                          onClick={(e) => {
                            e.stopPropagation();
                            select(c.id);
                            void startEdit(c);
                          }}
                        >
                          {L('تعديل', 'Edit')}
                        </button>
                      )}
                      <button
                        className="btn btn-secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/customers/${c.id}/account`);
                        }}
                      >
                        {t('action.view_account')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {customers !== null && customers.length > 0 && (
            <div className="action-row" style={{ marginTop: 14, alignItems: 'center' }}>
              <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                {t('action.previous_page')}
              </button>
              <span style={{ fontSize: '0.85rem', color: '#6b7280' }}>{t('field.page_of_total').replace('{page}', String(page)).replace('{total}', String(totalPages))}</span>
              <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                {t('action.next_page')}
              </button>
            </div>
          )}
        </div>

        {selected && (
          <div className="card" style={{ width: 380, flexShrink: 0 }}>
            <h3 style={{ marginTop: 0 }}>{selected.name}</h3>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 2 }}>{selected.code}</div>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>{fmtDate(selected.createdAt)}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
              <span className="status-badge">{nameOf(STATUS_NAMES, selected.status, currentLang())}</span>
              {can('sales.customer_status.edit', 'editable') && NEXT_CUSTOMER_STATUS[selected.status] && (
                <button className="btn btn-secondary" style={{ padding: '2px 8px', fontSize: '0.78rem' }} disabled={busy === 'status:' + selected.id} onClick={() => transitionStatus(selected, NEXT_CUSTOMER_STATUS[selected.status]!.to)}>
                  {t(NEXT_CUSTOMER_STATUS[selected.status]!.actionCode)}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {canEdit && (
                <button className="btn btn-secondary" onClick={() => void startEdit(selected)}>
                  {L('تعديل', 'Edit')}
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => navigate(`/customers/${selected.id}/account`)}>
                {t('action.view_account')}
              </button>
              <button className="btn btn-secondary" onClick={() => window.open(`/print/customer/${selected.id}`, '_blank')}>
                {t('action.print')}
              </button>
            </div>

            {detailRow(t('field.phone'), selected.phone)}
            {detailRow(t('field.whatsapp_phone'), selected.whatsappPhone)}
            {detailRow(t('field.manager_name'), selected.managerName)}
            {detailRow(t('field.address'), selected.address)}
            {detailRow(t('field.governorate'), selected.governorate)}
            {detailRow(t('field.contact_method'), selected.contactMethod)}
            {detailRow(t('field.responsiveness_level'), selected.responsivenessLevel)}
            {detailRow(t('field.price_satisfaction_level'), selected.priceSatisfactionLevel)}
            {detailRow(t('field.top_brand'), selected.topBrand)}
            {detailRow(t('field.mid_brand'), selected.midBrand)}
            {detailRow(t('field.low_brand'), selected.lowBrand)}
            {detailRow(t('field.shipping_method_preference'), selected.shippingMethodPreference)}
            {detailRow(t('field.disinterest_notes'), selected.disinterestNotes)}
            <div className="detail-field" style={{ marginBottom: 6 }}>
              <div className="label">{t('field.location_url')}</div>
              <div className="value">
                {selected.locationUrl ? (
                  <a href={selected.locationUrl} target="_blank" rel="noreferrer">
                    {selected.locationUrl}
                  </a>
                ) : (
                  '—'
                )}
              </div>
            </div>

            {can('sales.customer.assign', 'editable') && (
              <div className="form-field" style={{ marginTop: 14, marginBottom: 0 }}>
                <label>{t('role.sales_rep')}</label>
                {assignedMessage[selected.id] ? (
                  <span className="status-badge positive">{assignedMessage[selected.id]}</span>
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select value={assignRepId} onChange={(e) => setAssignRepId(e.target.value)}>
                      <option value="">—</option>
                      {reps.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.fullName}
                        </option>
                      ))}
                    </select>
                    <select value={assignType} onChange={(e) => setAssignType(e.target.value as 'primary' | 'secondary')} style={{ width: 100 }}>
                      <option value="primary">{t('assignment_type.primary')}</option>
                      <option value="secondary">{t('assignment_type.secondary')}</option>
                    </select>
                    <button className="btn btn-secondary" disabled={busy === 'assign' || !assignRepId} onClick={() => assignRep(selected)}>
                      {t('action.assign')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {canEdit && (
              <>
                <div className="form-field" style={{ marginTop: 10, marginBottom: 0 }}>
                  <label>{t('field.classification')}</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input value={classificationDraft ?? selected.classification ?? ''} onChange={(e) => setClassificationDraft(e.target.value)} style={{ width: 160 }} />
                    {(classificationDraft ?? selected.classification ?? '') !== (selected.classification ?? '') && (
                      <button className="btn btn-secondary" disabled={busy === 'classification'} onClick={() => saveClassification(selected)}>
                        {t('action.save')}
                      </button>
                    )}
                  </div>
                </div>
                <div className="form-field" style={{ marginTop: 10, marginBottom: 0 }}>
                  <label>{t('field.order_workflow_policy')}</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select value={policyDraft ?? selected.orderWorkflowPolicy} onChange={(e) => setPolicyDraft(e.target.value)}>
                      <option value="standard">{t('workflow_policy.standard')}</option>
                      <option value="open_account">{t('workflow_policy.open_account')}</option>
                    </select>
                    {policyDraft && policyDraft !== selected.orderWorkflowPolicy && (
                      <button className="btn btn-secondary" disabled={busy === 'policy'} onClick={() => savePolicy(selected)}>
                        {t('action.save')}
                      </button>
                    )}
                  </div>
                </div>
                <div className="form-field" style={{ marginTop: 10, marginBottom: 0 }}>
                  <label>{t('field.customer_price_list')}</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select value={priceListDraft ?? selected.priceListId ?? ''} onChange={(e) => setPriceListDraft(e.target.value)}>
                      <option value="">{t('field.no_override')}</option>
                      {priceLists.map((pl) => (
                        <option key={pl.id} value={pl.id}>
                          {pl.code} — {pl.name}
                        </option>
                      ))}
                    </select>
                    {(priceListDraft ?? selected.priceListId ?? '') !== (selected.priceListId ?? '') && (
                      <button className="btn btn-secondary" disabled={busy === 'priceList'} onClick={() => savePriceList(selected)}>
                        {t('action.save')}
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
