import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { PasswordInput } from '../components/PasswordInput';

interface Connector {
  id: string;
  connectorType: string;
  name: string;
  status: 'pending' | 'connected' | 'error' | 'disconnected';
  config: { apiUrl?: string; systemUserId?: string };
}
interface Mapping {
  id: string;
  daiiProductId: string;
  externalProductId: string;
}
interface SyncLog {
  id: string;
  direction: string;
  eventType: string;
  externalReference: string | null;
  status: string;
  detail: string | null;
  createdAt: string;
}
interface AdminUser {
  id: string;
  email: string;
  fullName: string;
}

export function ExternalIntegrations() {
  const { t, preload } = useLanguage();
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [systemUserId, setSystemUserId] = useState('');
  const [creating, setCreating] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedView, setExpandedView] = useState<'mappings' | 'logs' | null>(null);
  const [mappings, setMappings] = useState<Mapping[] | null>(null);
  const [logs, setLogs] = useState<SyncLog[] | null>(null);
  const [pairingTokens, setPairingTokens] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  preload([
    'nav.integrations',
    'field.name',
    'field.connector_type',
    'field.api_url',
    'field.system_user',
    'field.pairing_token',
    'field.status',
    'field.actions',
    'action.create',
    'action.pair',
    'action.test_connection',
    'action.disconnect',
    'action.publish_products',
    'action.publish_availability',
    'action.view_logs',
    'action.view_mappings',
    'panel.no_connectors_yet',
    'panel.no_mappings_yet',
    'panel.no_logs_yet',
    'connector_status.pending',
    'connector_status.connected',
    'connector_status.error',
    'connector_status.disconnected',
  ]);

  async function load() {
    try {
      const [list, adminUsers] = await Promise.all([
        api.get<Connector[]>('/integrations/connectors'),
        api.get<AdminUser[]>('/admin/users'),
      ]);
      setConnectors(list);
      setUsers(adminUsers);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load integrations.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!systemUserId) return;
    setCreating(true);
    setError(null);
    try {
      await api.post('/integrations/connectors', {
        connectorType: 'qr_store',
        name,
        config: { apiUrl, systemUserId },
      });
      setName('');
      setApiUrl('');
      setSystemUserId('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create connector.');
    } finally {
      setCreating(false);
    }
  }

  async function pair(connectorId: string) {
    const pairingToken = pairingTokens[connectorId];
    if (!pairingToken) return;
    setBusyId(connectorId);
    setError(null);
    try {
      await api.post(`/integrations/connectors/${connectorId}/pair`, { pairingToken });
      setPairingTokens((prev) => ({ ...prev, [connectorId]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to pair connector.');
    } finally {
      setBusyId(null);
    }
  }

  async function testConnection(connectorId: string) {
    setBusyId(connectorId);
    setError(null);
    try {
      const result = await api.post<{ ok: boolean; error?: string }>(`/integrations/connectors/${connectorId}/test`, {});
      if (!result.ok) setError(result.error ?? 'Connection test failed.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to test connection.');
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(connectorId: string) {
    setBusyId(connectorId);
    setError(null);
    try {
      await api.post(`/integrations/connectors/${connectorId}/disconnect`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to disconnect.');
    } finally {
      setBusyId(null);
    }
  }

  async function publishProducts(connectorId: string) {
    setBusyId(connectorId);
    setError(null);
    try {
      await api.post(`/integrations/connectors/${connectorId}/publish/products`, {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to publish products.');
    } finally {
      setBusyId(null);
    }
  }

  async function publishAvailability(connectorId: string) {
    setBusyId(connectorId);
    setError(null);
    try {
      await api.post(`/integrations/connectors/${connectorId}/publish/availability`, {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to publish availability.');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleView(connectorId: string, view: 'mappings' | 'logs') {
    if (expandedId === connectorId && expandedView === view) {
      setExpandedId(null);
      setExpandedView(null);
      return;
    }
    setExpandedId(connectorId);
    setExpandedView(view);
    setError(null);
    try {
      if (view === 'mappings') setMappings(await api.get<Mapping[]>(`/integrations/connectors/${connectorId}/mappings`));
      else setLogs(await api.get<SyncLog[]>(`/integrations/connectors/${connectorId}/logs`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.integrations')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.connector_type')}</label>
            <select value="qr_store" disabled>
              <option value="qr_store">QR Store</option>
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.name')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.api_url')}</label>
            <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://qr.example.com" required />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
            <label>{t('field.system_user')}</label>
            <select value={systemUserId} onChange={(e) => setSystemUserId(e.target.value)} required>
              <option value="" disabled>
                —
              </option>
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

      {error && <div className="error-text">{error}</div>}

      {connectors === null ? (
        <div className="empty-state">Loading…</div>
      ) : connectors.length === 0 ? (
        <div className="empty-state">{t('panel.no_connectors_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.name')}</th>
              <th>{t('field.api_url')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.pairing_token')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {connectors.map((c) => (
              <Fragment key={c.id}>
                <tr>
                  <td>{c.name}</td>
                  <td>{c.config.apiUrl ?? '—'}</td>
                  <td>
                    <StatusBadge code={`connector_status.${c.status}`} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <PasswordInput
                        placeholder="•••••••••"
                        value={pairingTokens[c.id] ?? ''}
                        onChange={(v) => setPairingTokens((prev) => ({ ...prev, [c.id]: v }))}
                        style={{ width: 140 }}
                      />
                      <button className="btn btn-secondary" disabled={busyId === c.id || !pairingTokens[c.id]} onClick={() => pair(c.id)}>
                        {t('action.pair')}
                      </button>
                    </div>
                  </td>
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn btn-secondary" disabled={busyId === c.id} onClick={() => testConnection(c.id)}>
                      {t('action.test_connection')}
                    </button>
                    <button className="btn btn-secondary" disabled={busyId === c.id} onClick={() => publishProducts(c.id)}>
                      {t('action.publish_products')}
                    </button>
                    <button className="btn btn-secondary" disabled={busyId === c.id} onClick={() => publishAvailability(c.id)}>
                      {t('action.publish_availability')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => toggleView(c.id, 'mappings')}>
                      {t('action.view_mappings')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => toggleView(c.id, 'logs')}>
                      {t('action.view_logs')}
                    </button>
                    <button className="btn btn-danger" disabled={busyId === c.id} onClick={() => disconnect(c.id)}>
                      {t('action.disconnect')}
                    </button>
                  </td>
                </tr>
                {expandedId === c.id && expandedView === 'mappings' && (
                  <tr>
                    <td colSpan={5}>
                      <div className="card" style={{ margin: '8px 0' }}>
                        {mappings === null ? (
                          <div className="empty-state">Loading…</div>
                        ) : mappings.length === 0 ? (
                          <div className="empty-state">{t('panel.no_mappings_yet')}</div>
                        ) : (
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>{t('field.name')}</th>
                                <th>{t('field.external_id')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {mappings.map((m) => (
                                <tr key={m.id}>
                                  <td>{m.daiiProductId}</td>
                                  <td>{m.externalProductId}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                {expandedId === c.id && expandedView === 'logs' && (
                  <tr>
                    <td colSpan={5}>
                      <div className="card" style={{ margin: '8px 0' }}>
                        {logs === null ? (
                          <div className="empty-state">Loading…</div>
                        ) : logs.length === 0 ? (
                          <div className="empty-state">{t('panel.no_logs_yet')}</div>
                        ) : (
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>{t('field.created_at')}</th>
                                <th>Direction</th>
                                <th>Event</th>
                                <th>{t('field.status')}</th>
                                <th>Detail</th>
                              </tr>
                            </thead>
                            <tbody>
                              {logs.map((l) => (
                                <tr key={l.id}>
                                  <td>{new Date(l.createdAt).toLocaleString()}</td>
                                  <td>{l.direction}</td>
                                  <td>{l.eventType}</td>
                                  <td>
                                    <span className={`status-badge ${l.status === 'success' ? 'positive' : l.status === 'failed' ? 'negative' : ''}`}>
                                      {l.status}
                                    </span>
                                  </td>
                                  <td>{l.detail ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
