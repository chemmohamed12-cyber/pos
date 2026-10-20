import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { loadingLabel } from '../../lib/displayNames';

interface DimensionType {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}
interface DimensionValue {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

const PRELOAD = [
  'nav.dimensions',
  'field.dimension_type',
  'field.dimension_value',
  'field.dimension_type_code',
  'field.dimension_value_code',
  'field.code',
  'field.name',
  'field.status',
  'field.actions',
  'action.create_dimension_type',
  'action.create_dimension_value',
  'action.deactivate',
  'action.activate',
  'panel.no_dimensions_yet',
];

/** F11 — Cost Centers & Dimensions (ADR-044). Dimension type CRUD + per-type value CRUD. */
export function Dimensions() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [types, setTypes] = useState<DimensionType[] | null>(null);
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [values, setValues] = useState<DimensionValue[] | null>(null);
  const [typeCode, setTypeCode] = useState('');
  const [typeName, setTypeName] = useState('');
  const [valueCode, setValueCode] = useState('');
  const [valueName, setValueName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadTypes() {
    try {
      setTypes(await api.get<DimensionType[]>('/accounting/dimension-types'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load dimension types.');
    }
  }

  useEffect(() => {
    loadTypes();
  }, []);

  async function loadValues(typeId: string) {
    try {
      setValues(await api.get<DimensionValue[]>(`/accounting/dimension-types/${typeId}/values`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load dimension values.');
    }
  }

  useEffect(() => {
    if (selectedTypeId) loadValues(selectedTypeId);
    else setValues(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTypeId]);

  async function onCreateType(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/dimension-types', { code: typeCode, name: typeName });
      setTypeCode('');
      setTypeName('');
      await loadTypes();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create dimension type.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleTypeActive(dt: DimensionType) {
    setBusy(true);
    setError(null);
    try {
      if (dt.isActive) await api.post(`/accounting/dimension-types/${dt.id}/deactivate`);
      else await api.post(`/accounting/dimension-types/${dt.id}`, { isActive: true });
      await loadTypes();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update dimension type.');
    } finally {
      setBusy(false);
    }
  }

  async function onCreateValue(e: FormEvent) {
    e.preventDefault();
    if (!selectedTypeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/dimension-types/${selectedTypeId}/values`, { code: valueCode, name: valueName });
      setValueCode('');
      setValueName('');
      await loadValues(selectedTypeId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create dimension value.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleValueActive(v: DimensionValue) {
    if (!selectedTypeId) return;
    setBusy(true);
    setError(null);
    try {
      if (v.isActive) await api.post(`/accounting/dimension-values/${v.id}/deactivate`);
      else await api.post(`/accounting/dimension-values/${v.id}`, { isActive: true });
      await loadValues(selectedTypeId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update dimension value.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.dimensions')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 20 }}>
        <div className="card" style={{ flex: '1 1 45%' }}>
          <h3 style={{ marginTop: 0 }}>{t('field.dimension_type')}</h3>
          <form onSubmit={onCreateType} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.dimension_type_code')}</label>
              <input value={typeCode} onChange={(e) => setTypeCode(e.target.value)} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.name')}</label>
              <input value={typeName} onChange={(e) => setTypeName(e.target.value)} required />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('action.create_dimension_type')}
            </button>
          </form>

          {types === null ? (
            <div className="empty-state">{loadingLabel()}</div>
          ) : types.length === 0 ? (
            <div className="empty-state">{t('panel.no_dimensions_yet')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.code')}</th>
                  <th>{t('field.name')}</th>
                  <th>{t('field.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {types.map((dt) => (
                  <tr key={dt.id} className={selectedTypeId === dt.id ? 'active' : ''} style={{ cursor: 'pointer', opacity: dt.isActive ? 1 : 0.5 }} onClick={() => setSelectedTypeId(dt.id)}>
                    <td>{dt.code}</td>
                    <td>{dt.name}</td>
                    <td>
                      <button className="btn btn-secondary" disabled={busy} onClick={(e) => { e.stopPropagation(); toggleTypeActive(dt); }}>
                        {t(dt.isActive ? 'action.deactivate' : 'action.activate')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selectedTypeId && (
          <div className="card" style={{ flex: '1 1 45%' }}>
            <h3 style={{ marginTop: 0 }}>{t('field.dimension_value')}</h3>
            <form onSubmit={onCreateValue} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.dimension_value_code')}</label>
                <input value={valueCode} onChange={(e) => setValueCode(e.target.value)} required />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.name')}</label>
                <input value={valueName} onChange={(e) => setValueName(e.target.value)} required />
              </div>
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {t('action.create_dimension_value')}
              </button>
            </form>

            {values === null ? (
              <div className="empty-state">{loadingLabel()}</div>
            ) : values.length === 0 ? (
              <div className="empty-state">{t('panel.no_dimensions_yet')}</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.code')}</th>
                    <th>{t('field.name')}</th>
                    <th>{t('field.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {values.map((v) => (
                    <tr key={v.id} style={{ opacity: v.isActive ? 1 : 0.5 }}>
                      <td>{v.code}</td>
                      <td>{v.name}</td>
                      <td>
                        <button className="btn btn-secondary" disabled={busy} onClick={() => toggleValueActive(v)}>
                          {t(v.isActive ? 'action.deactivate' : 'action.activate')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
