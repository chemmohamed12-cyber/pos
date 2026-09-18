import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface Department {
  id: string;
  code: string;
  name: string;
  createdAt: string;
}

/** HR (ADR-029) — Departments screen: flat list + create form, same shape as `TreasuryAccounts.tsx`'s account-type panel. */
export function HrDepartments() {
  const { t, preload } = useLanguage();
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.hr_departments',
    'field.code',
    'field.name',
    'field.created_at',
    'action.create_department',
    'panel.no_departments_yet',
  ]);

  async function load() {
    try {
      setDepartments(await api.get<Department[]>('/hr/departments'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load departments.');
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
      await api.post('/hr/departments', { code, name });
      setCode('');
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create department.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.hr_departments')}</h1>
      </div>

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
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {t('action.create_department')}
          </button>
        </form>
      </div>

      {error && <div className="error-text">{error}</div>}

      {departments === null ? (
        <div className="empty-state">Loading…</div>
      ) : departments.length === 0 ? (
        <div className="empty-state">{t('panel.no_departments_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.code')}</th>
              <th>{t('field.name')}</th>
              <th>{t('field.created_at')}</th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.id}>
                <td>{d.code}</td>
                <td>{d.name}</td>
                <td>{new Date(d.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
