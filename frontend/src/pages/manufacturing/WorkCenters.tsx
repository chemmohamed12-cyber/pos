import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

interface WorkCenter {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive';
  routingOperationCount?: number;
}

/**
 * ADR-061 Addendum 1 (A1) — Work Centers master data: where an operation is performed.
 * Assignment only — no capacity, hours, rates or cost (ADR-060 D2/D3).
 */
export function WorkCenters() {
  const { t, preload } = useLanguage();
  const [rows, setRows] = useState<WorkCenter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkCenter | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  preload([
    'nav.manufacturing_work_centers',
    'field.name',
    'field.status',
    'field.actions',
    'action.save',
    'mfg.field.code',
    'mfg.field.description',
    'mfg.field.routing_usage',
    'mfg.status.active',
    'mfg.status.inactive',
    'mfg.action.new_work_center',
    'mfg.action.edit',
    'mfg.action.activate',
    'mfg.action.deactivate',
    'mfg.action.delete',
    'mfg.action.close',
    'mfg.panel.no_work_centers',
  ]);

  async function load() {
    try {
      setRows(await api.get<WorkCenter[]>('/manufacturing/work-centers'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load work centers.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  function reset() {
    setEditing(null);
    setCode('');
    setName('');
    setDescription('');
  }

  function startEdit(wc: WorkCenter) {
    setEditing(wc);
    setCode(wc.code);
    setName(wc.name);
    setDescription(wc.description ?? '');
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editing) await api.post(`/manufacturing/work-centers/${editing.id}`, { name, description });
      else await api.post('/manufacturing/work-centers', { code, name, description: description || undefined });
      reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save work center.');
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(wc: WorkCenter, status: 'active' | 'inactive') {
    setError(null);
    try {
      await api.post(`/manufacturing/work-centers/${wc.id}`, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change status.');
    }
  }

  async function remove(wc: WorkCenter) {
    setError(null);
    try {
      await api.delete(`/manufacturing/work-centers/${wc.id}`);
      if (editing?.id === wc.id) reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete work center.');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.manufacturing_work_centers')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={onSubmit} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, width: 160 }}>
            <label>{t('mfg.field.code')}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} required disabled={!!editing} maxLength={32} />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.name')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={255} />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 260, flex: 1 }}>
            <label>{t('mfg.field.description')}</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {editing ? t('action.save') : t('mfg.action.new_work_center')}
          </button>
          {editing && (
            <button className="btn btn-secondary" type="button" onClick={reset}>
              {t('mfg.action.close')}
            </button>
          )}
        </form>
      </div>

      {error && <div className="error-text">{error}</div>}

      {rows === null ? (
        <div className="empty-state">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('mfg.panel.no_work_centers')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('mfg.field.code')}</th>
              <th>{t('field.name')}</th>
              <th>{t('mfg.field.description')}</th>
              <th>{t('mfg.field.routing_usage')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((wc) => (
              <tr key={wc.id}>
                <td>{wc.code}</td>
                <td>{wc.name}</td>
                <td>{wc.description ?? '—'}</td>
                <td>{wc.routingOperationCount ?? 0}</td>
                <td>
                  <StatusBadge code={`mfg.status.${wc.status}`} />
                </td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary" type="button" onClick={() => startEdit(wc)}>
                    {t('mfg.action.edit')}
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => setStatus(wc, wc.status === 'active' ? 'inactive' : 'active')}>
                    {wc.status === 'active' ? t('mfg.action.deactivate') : t('mfg.action.activate')}
                  </button>
                  <button className="btn btn-danger" type="button" onClick={() => remove(wc)}>
                    {t('mfg.action.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
