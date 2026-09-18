import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

interface Supplier {
  id: string;
  code: string;
  legalName: string;
  tradingName: string | null;
  supplierType: 'company' | 'individual';
  paymentTermsDays: number;
  creditLimitBase: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
}
interface SupplierContact {
  id: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
}
interface SupplierAddress {
  id: string;
  label: string | null;
  addressLine: string;
  city: string | null;
  governorate: string | null;
}
interface SupplierBankAccount {
  id: string;
  bankName: string;
  accountNumber: string;
  iban: string | null;
  approvalStatus: 'pending' | 'approved' | 'rejected';
}
interface SupplierDetail {
  supplier: Supplier;
  contacts: SupplierContact[];
  addresses: SupplierAddress[];
  bankAccounts: SupplierBankAccount[];
}

const NEXT_STATUS: Record<'active' | 'inactive', 'active' | 'inactive'> = { active: 'inactive', inactive: 'active' };

/**
 * ADR-048 — Procurement's Supplier Master screen. First operational UI
 * for the new Procurement module; Purchase Order / Goods Receipt /
 * Supplier Invoice screens land in later slices and will reference
 * suppliers created here by id (never by free-text name).
 */
export function Suppliers() {
  const { hasRole } = useAuth();
  const { t, preload } = useLanguage();
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupplierDetail | null>(null);

  const [code, setCode] = useState('');
  const [legalName, setLegalName] = useState('');
  const [supplierType, setSupplierType] = useState<'company' | 'individual'>('company');
  const [paymentTermsDays, setPaymentTermsDays] = useState('0');
  const [creating, setCreating] = useState(false);

  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [iban, setIban] = useState('');
  const [addingBank, setAddingBank] = useState(false);

  const [busyStatus, setBusyStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.suppliers',
    'field.supplier_code',
    'field.legal_name',
    'field.trading_name',
    'field.supplier_type',
    'value.supplier_type.company',
    'value.supplier_type.individual',
    'field.payment_terms_days',
    'field.credit_limit',
    'field.status',
    'action.add_supplier',
    'action.create',
    'action.activate_supplier',
    'action.deactivate_supplier',
    'field.actions',
    'panel.no_suppliers_yet',
    'field.bank_name',
    'field.account_number',
    'field.iban',
    'field.approval_status',
    'value.approval_status.pending',
    'value.approval_status.approved',
    'value.approval_status.rejected',
    'action.add_bank_account',
  ]);

  async function load() {
    try {
      const data = await api.get<Supplier[]>('/procurement/suppliers');
      setSuppliers(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load suppliers.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function loadDetail(id: string) {
    setSelectedId(id);
    const data = await api.get<SupplierDetail>(`/procurement/suppliers/${id}`);
    setDetail(data);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/procurement/suppliers', {
        code,
        legalName,
        supplierType,
        paymentTermsDays: Number(paymentTermsDays) || 0,
      });
      setCode('');
      setLegalName('');
      setSupplierType('company');
      setPaymentTermsDays('0');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create supplier.');
    } finally {
      setCreating(false);
    }
  }

  async function toggleStatus(s: Supplier) {
    setBusyStatus(s.id);
    setError(null);
    try {
      await api.post(`/procurement/suppliers/${s.id}/status`, { status: NEXT_STATUS[s.status] });
      await load();
      if (selectedId === s.id) await loadDetail(s.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change supplier status.');
    } finally {
      setBusyStatus(null);
    }
  }

  async function onAddBankAccount(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setAddingBank(true);
    setError(null);
    try {
      await api.post(`/procurement/suppliers/${selectedId}/bank-accounts`, { bankName, accountNumber, iban: iban || undefined });
      setBankName('');
      setAccountNumber('');
      setIban('');
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add bank account.');
    } finally {
      setAddingBank(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.suppliers')}</h1>
      </div>

      {hasRole('admin') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.supplier_code')}</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
              <label>{t('field.legal_name')}</label>
              <input value={legalName} onChange={(e) => setLegalName(e.target.value)} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.supplier_type')}</label>
              <select value={supplierType} onChange={(e) => setSupplierType(e.target.value as 'company' | 'individual')}>
                <option value="company">{t('value.supplier_type.company')}</option>
                <option value="individual">{t('value.supplier_type.individual')}</option>
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.payment_terms_days')}</label>
              <input type="number" min={0} value={paymentTermsDays} onChange={(e) => setPaymentTermsDays(e.target.value)} style={{ width: 90 }} />
            </div>
            <button className="btn btn-primary" type="submit" disabled={creating}>
              {t('action.add_supplier')}
            </button>
          </form>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          {suppliers === null ? (
            <div className="empty-state">Loading…</div>
          ) : suppliers.length === 0 ? (
            <div className="empty-state">{t('panel.no_suppliers_yet')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.supplier_code')}</th>
                  <th>{t('field.legal_name')}</th>
                  <th>{t('field.supplier_type')}</th>
                  <th>{t('field.payment_terms_days')}</th>
                  <th>{t('field.status')}</th>
                  <th>{t('field.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => loadDetail(s.id)}>
                    <td>{s.code}</td>
                    <td>{s.legalName}</td>
                    <td>{t(`value.supplier_type.${s.supplierType}`)}</td>
                    <td>{s.paymentTermsDays}</td>
                    <td>
                      <StatusBadge code={`supplier_status.${s.status}`} />
                    </td>
                    <td>
                      {hasRole('admin') && (
                        <button
                          className="btn btn-secondary"
                          disabled={busyStatus === s.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleStatus(s);
                          }}
                        >
                          {t(s.status === 'active' ? 'action.deactivate_supplier' : 'action.activate_supplier')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {detail && (
          <div className="card" style={{ width: 380, flexShrink: 0 }}>
            <h3 style={{ marginTop: 0 }}>{detail.supplier.legalName}</h3>

            <div className="detail-field" style={{ marginBottom: 14 }}>
              <div className="label">{t('field.bank_name')}</div>
            </div>
            {detail.bankAccounts.length === 0 ? (
              <div className="empty-state" style={{ padding: 10 }}>
                —
              </div>
            ) : (
              <table className="data-table" style={{ marginBottom: 14 }}>
                <thead>
                  <tr>
                    <th>{t('field.bank_name')}</th>
                    <th>{t('field.account_number')}</th>
                    <th>{t('field.approval_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.bankAccounts.map((b) => (
                    <tr key={b.id}>
                      <td>{b.bankName}</td>
                      <td>{b.accountNumber}</td>
                      <td>
                        <StatusBadge code={`value.approval_status.${b.approvalStatus}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {hasRole('admin') && (
              <form onSubmit={onAddBankAccount} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.bank_name')}</label>
                  <input value={bankName} onChange={(e) => setBankName(e.target.value)} required />
                </div>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.account_number')}</label>
                  <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} required />
                </div>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.iban')}</label>
                  <input value={iban} onChange={(e) => setIban(e.target.value)} />
                </div>
                <button className="btn btn-secondary" type="submit" disabled={addingBank}>
                  {t('action.add_bank_account')}
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
