import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { fmtDateTime } from '../../lib/formatDateTime';
import { loadingLabel } from '../../lib/displayNames';

interface Employee {
  id: string;
  code: string;
  fullName: string;
  status: 'active' | 'on_leave' | 'terminated';
}
interface Connector {
  id: string;
  name: string;
  connectorType: string;
  status: 'pending' | 'connected' | 'disconnected';
}
interface Mapping {
  id: string;
  connectorId: string;
  employeeId: string;
  deviceUserRef: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}
interface UnmappedRecord {
  id: string;
  sourceConnectorId: string | null;
  deviceEmployeeRef: string;
  punchTimestamp: string;
  punchType: string;
}

const PUNCH_TYPES = ['in', 'out', 'unknown'] as const;

/** ADR-065 (Attendance Phase 1) — connectors, employee/device mapping, unmapped-punches queue, and manual entry, combined (all "raw ingestion" concerns). */
export function AttendanceConnectors() {
  const { t, preload } = useLanguage();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [mappings, setMappings] = useState<Mapping[] | null>(null);
  const [unmapped, setUnmapped] = useState<UnmappedRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [connectorName, setConnectorName] = useState('');
  const [creatingConnector, setCreatingConnector] = useState(false);

  const [mapConnectorId, setMapConnectorId] = useState('');
  const [mapEmployeeId, setMapEmployeeId] = useState('');
  const [mapDeviceRef, setMapDeviceRef] = useState('');
  const [creatingMapping, setCreatingMapping] = useState(false);

  const [punchEmployeeId, setPunchEmployeeId] = useState('');
  const [punchTimestamp, setPunchTimestamp] = useState('');
  const [punchType, setPunchType] = useState<(typeof PUNCH_TYPES)[number]>('in');
  const [recordingPunch, setRecordingPunch] = useState(false);

  preload([
    'nav.attendance_connectors',
    'field.connector_name',
    'field.connector_type',
    'field.device_ref',
    'field.employee',
    'field.punch_timestamp',
    'field.punch_type',
    'field.status',
    'field.actions',
    'action.create_connector',
    'action.create_mapping',
    'action.close_mapping',
    'action.record_manual_punch',
    'action.confirm',
    'action.cancel',
    'panel.no_connectors_yet',
    'panel.no_mappings_yet',
    'panel.no_unmapped_records_yet',
    'value.connector_status.pending',
    'value.connector_status.connected',
    'value.connector_status.disconnected',
    ...PUNCH_TYPES.map((p) => `value.punch_type.${p}`),
  ]);

  async function loadEmployees() {
    try {
      setEmployees(await api.get<Employee[]>('/hr/employees'));
    } catch (err) {
      // Foundation fix: no error handling — the employee-label lookups silently stayed empty.
      setError(err instanceof ApiError ? err.message : 'Failed to load employees.');
    }
  }
  async function loadConnectors() {
    try {
      setConnectors(await api.get<Connector[]>('/attendance/connectors'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load connectors.');
    }
  }
  async function loadMappings() {
    try {
      setMappings(await api.get<Mapping[]>('/attendance/mappings'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load mappings.');
    }
  }
  async function loadUnmapped() {
    try {
      setUnmapped(await api.get<UnmappedRecord[]>('/attendance/raw-records/unmapped'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load unmapped records.');
    }
  }

  useEffect(() => {
    loadEmployees();
    loadConnectors();
    loadMappings();
    loadUnmapped();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreateConnector(e: FormEvent) {
    e.preventDefault();
    setCreatingConnector(true);
    setError(null);
    try {
      await api.post('/attendance/connectors', { name: connectorName, connectorType: 'manual' });
      setConnectorName('');
      await loadConnectors();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create connector.');
    } finally {
      setCreatingConnector(false);
    }
  }

  async function onCreateMapping(e: FormEvent) {
    e.preventDefault();
    setCreatingMapping(true);
    setError(null);
    try {
      await api.post('/attendance/mappings', { connectorId: mapConnectorId, employeeId: mapEmployeeId, deviceUserRef: mapDeviceRef });
      setMapDeviceRef('');
      await Promise.all([loadMappings(), loadUnmapped()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create mapping.');
    } finally {
      setCreatingMapping(false);
    }
  }

  async function closeMapping(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/attendance/mappings/${id}/close`);
      await loadMappings();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to close mapping.');
    } finally {
      setBusyId(null);
    }
  }

  async function onRecordPunch(e: FormEvent) {
    e.preventDefault();
    setRecordingPunch(true);
    setError(null);
    try {
      // `<input type="datetime-local">` has no timezone of its own — `new Date(...)` here
      // reads it as the ADMIN'S OWN browser-local time, and `.toISOString()` converts it to
      // a real UTC instant, so the server never has to guess (or assume its own timezone).
      await api.post('/attendance/manual-entries', { employeeId: punchEmployeeId, punchTimestamp: new Date(punchTimestamp).toISOString(), punchType });
      setPunchTimestamp('');
      await loadUnmapped();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record punch.');
    } finally {
      setRecordingPunch(false);
    }
  }

  const employeeLabel = (id: string) => {
    const emp = employees.find((e) => e.id === id);
    return emp ? `${emp.code} — ${emp.fullName}` : id.slice(0, 8);
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.attendance_connectors')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.create_connector')}</h3>
        <form onSubmit={onCreateConnector} style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.connector_name')}</label>
            <input value={connectorName} onChange={(e) => setConnectorName(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={creatingConnector}>
            {t('action.create_connector')}
          </button>
        </form>
      </div>

      {connectors === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : connectors.length === 0 ? (
        <div className="empty-state">{t('panel.no_connectors_yet')}</div>
      ) : (
        <table className="data-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>{t('field.connector_name')}</th>
              <th>{t('field.connector_type')}</th>
              <th>{t('field.status')}</th>
            </tr>
          </thead>
          <tbody>
            {connectors.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.connectorType}</td>
                <td>
                  <StatusBadge code={`value.connector_status.${c.status}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.create_mapping')}</h3>
        <form onSubmit={onCreateMapping} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 160 }}>
            <label>{t('field.connector_name')}</label>
            <select value={mapConnectorId} onChange={(e) => setMapConnectorId(e.target.value)} required>
              <option value="">—</option>
              {connectors?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
            <label>{t('field.employee')}</label>
            <select value={mapEmployeeId} onChange={(e) => setMapEmployeeId(e.target.value)} required>
              <option value="">—</option>
              {employees
                .filter((e) => e.status === 'active')
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code} — {e.fullName}
                  </option>
                ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.device_ref')}</label>
            <input value={mapDeviceRef} onChange={(e) => setMapDeviceRef(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={creatingMapping}>
            {t('action.create_mapping')}
          </button>
        </form>
      </div>

      {mappings === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : mappings.length === 0 ? (
        <div className="empty-state">{t('panel.no_mappings_yet')}</div>
      ) : (
        <table className="data-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>{t('field.employee')}</th>
              <th>{t('field.device_ref')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.id}>
                <td>{employeeLabel(m.employeeId)}</td>
                <td>{m.deviceUserRef}</td>
                <td>{m.effectiveTo ? t('value.connector_status.disconnected') : t('value.connector_status.connected')}</td>
                <td>
                  {!m.effectiveTo && (
                    <button className="btn btn-secondary" disabled={busyId === m.id} onClick={() => closeMapping(m.id)}>
                      {t('action.close_mapping')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.record_manual_punch')}</h3>
        <form onSubmit={onRecordPunch} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
            <label>{t('field.employee')}</label>
            <select value={punchEmployeeId} onChange={(e) => setPunchEmployeeId(e.target.value)} required>
              <option value="">—</option>
              {employees
                .filter((e) => e.status === 'active')
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code} — {e.fullName}
                  </option>
                ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.punch_timestamp')}</label>
            <input type="datetime-local" value={punchTimestamp} onChange={(e) => setPunchTimestamp(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.punch_type')}</label>
            <select value={punchType} onChange={(e) => setPunchType(e.target.value as never)}>
              {PUNCH_TYPES.map((p) => (
                <option key={p} value={p}>
                  {t(`value.punch_type.${p}`)}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={recordingPunch}>
            {t('action.record_manual_punch')}
          </button>
        </form>
      </div>

      <h3>{t('panel.no_unmapped_records_yet')}</h3>
      {unmapped === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : unmapped.length === 0 ? (
        <div className="empty-state">{t('panel.no_unmapped_records_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.device_ref')}</th>
              <th>{t('field.punch_timestamp')}</th>
              <th>{t('field.punch_type')}</th>
            </tr>
          </thead>
          <tbody>
            {unmapped.map((r) => (
              <tr key={r.id}>
                <td>{r.deviceEmployeeRef}</td>
                <td>{fmtDateTime(r.punchTimestamp)}</td>
                <td>{t(`value.punch_type.${r.punchType}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
