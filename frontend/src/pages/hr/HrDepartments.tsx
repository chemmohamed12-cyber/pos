import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface Department {
  id: string;
  name: string;
  code: string | null;
  createdAt: string;
}

/** ADR-059 (HR Phase 1) — Departments screen: now a thin view over `OrgUnit(type='department')` (D1); `hr_departments` is retired. Codes are `NumberingService`-issued (D4), never client-supplied. */
export function HrDepartments() {
  const { t, preload } = useLanguage();
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.hr_departments',
    'field.code',
    'field.name',
    'field.created_at',
    'field.actions',
    'action.create_department',
    'action.edit_department',
    'action.save',
    'action.cancel',
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
      await api.post('/hr/departments', { name });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create department.');
    } finally {
      setCreating(false);
    }
  }

  function startEdit(d: Department) {
    setEditingId(d.id);
    setEditName(d.name);
  }

  async function saveEdit(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/hr/departments/${id}`, { name: editName });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to edit department.');
    } finally {
      setBusy(false);
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
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.id}>
                <td>{d.code ?? '—'}</td>
                <td>
                  {editingId === d.id ? (
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} style={{ width: 200 }} />
                  ) : (
                    d.name
                  )}
                </td>
                <td>{new Date(d.createdAt).toLocaleDateString()}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  {editingId === d.id ? (
                    <>
                      <button className="btn btn-primary" disabled={busy} onClick={() => saveEdit(d.id)}>
                        {t('action.save')}
                      </button>
                      <button className="btn btn-secondary" disabled={busy} onClick={() => setEditingId(null)}>
                        {t('action.cancel')}
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-secondary" onClick={() => startEdit(d)}>
                      {t('action.edit_department')}
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
