import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { ExcelImportExport } from '../components/ExcelImportExport';

interface Warehouse {
  id: string;
  code: string;
  name: string;
  location: string | null;
  responsibleUserId: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
}
interface AdminUser {
  id: string;
  email: string;
  fullName: string;
}

const NEXT_STATUS: Record<'active' | 'inactive', 'active' | 'inactive'> = { active: 'inactive', inactive: 'active' };

export function Warehouses() {
  const { hasRole } = useAuth();
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [responsibleUserId, setResponsibleUserId] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyStatus, setBusyStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.warehouses',
    'field.code',
    'field.name',
    'field.location',
    'field.responsible_user',
    'field.created_at',
    'field.status',
    'action.create',
    'action.view_inventory',
    'action.activate_warehouse',
    'action.deactivate_warehouse',
    'field.actions',
    'panel.no_warehouses_yet',
    'action.download_template',
    'action.export_excel',
    'action.import_excel',
    'field.total_rows',
    'field.succeeded_rows',
    'field.rejected_rows',
    'field.row',
    'field.errors',
  ]);

  async function load() {
    try {
      const data = await api.get<Warehouse[]>('/inventory/warehouses');
      setWarehouses(data);
      if (hasRole('admin')) {
        const u = await api.get<AdminUser[]>('/admin/users');
        setUsers(u);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load warehouses.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/inventory/warehouses', {
        code,
        name,
        location: location || undefined,
        responsibleUserId: responsibleUserId || undefined,
      });
      setCode('');
      setName('');
      setLocation('');
      setResponsibleUserId('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create warehouse.');
    } finally {
      setCreating(false);
    }
  }

  async function toggleStatus(w: Warehouse) {
    setBusyStatus(w.id);
    setError(null);
    try {
      await api.post(`/inventory/warehouses/${w.id}/status`, { status: NEXT_STATUS[w.status] });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change warehouse status.');
    } finally {
      setBusyStatus(null);
    }
  }

  const userName = (id: string | null) => (id ? users.find((u) => u.id === id)?.fullName ?? id : '—');

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.warehouses')}</h1>
      </div>

      {hasRole('admin') && (
        <ExcelImportExport
          templateUrl="/api/inventory/warehouses/import-template"
          exportUrl="/api/inventory/warehouses/export"
          importUrl="/api/inventory/warehouses/import"
          onImported={load}
        />
      )}

      {hasRole('admin') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.code')}</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.name')}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.location')}</label>
              <input value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 180 }}>
              <label>{t('field.responsible_user')}</label>
              <select value={responsibleUserId} onChange={(e) => setResponsibleUserId(e.target.value)}>
                <option value="">—</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary" type="submit" disabled={creating}>
              {t('action.create')}
            </button>
          </form>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      {warehouses === null ? (
        <div className="empty-state">Loading…</div>
      ) : warehouses.length === 0 ? (
        <div className="empty-state">{t('panel.no_warehouses_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.code')}</th>
              <th>{t('field.name')}</th>
              <th>{t('field.location')}</th>
              <th>{t('field.responsible_user')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.created_at')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {warehouses.map((w) => (
              <tr key={w.id}>
                <td>{w.code}</td>
                <td>{w.name}</td>
                <td>{w.location ?? '—'}</td>
                <td>{userName(w.responsibleUserId)}</td>
                <td>
                  <StatusBadge code={`warehouse_status.${w.status}`} />
                </td>
                <td>{new Date(w.createdAt).toLocaleDateString()}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary" onClick={() => navigate(`/inventory?warehouseId=${w.id}`)}>
                    {t('action.view_inventory')}
                  </button>
                  {hasRole('admin') && (
                    <button className="btn btn-secondary" disabled={busyStatus === w.id} onClick={() => toggleStatus(w)}>
                      {t(w.status === 'active' ? 'action.deactivate_warehouse' : 'action.activate_warehouse')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
