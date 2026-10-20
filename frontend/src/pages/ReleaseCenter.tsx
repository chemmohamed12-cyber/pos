import { Fragment, useEffect, useState } from 'react';
import { api, ApiError, getAccessToken } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { fmtDateTime } from '../lib/formatDateTime';

type ReleasePackageType = 'full' | 'delta';
type ReleaseStatus =
  | 'registered'
  | 'validation_failed'
  | 'validated'
  | 'backup_verified'
  | 'deploying'
  | 'migrating'
  | 'health_checking'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
  | 'failed_safe';

interface Release {
  id: string;
  version: string;
  packageType: ReleasePackageType;
  baseVersion: string | null;
  status: ReleaseStatus;
  uploadedAt: string;
  backupRunId: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}
interface BackupRun {
  id: string;
  trigger: string;
  status: string;
  sourceAppVersion: string;
  startedAt: string;
}
interface ReleaseMigrationRun {
  id: string;
  migrationName: string;
  startedAt: string;
  completedAt: string | null;
  success: boolean;
  errorMessage: string | null;
}

/** Mirrors `upgrade-resolver.ts`'s `UpgradeChainStep`/`UpgradeResolution` — read-only planning data, never re-derived client-side. */
interface UpgradeChainStep {
  fromVersion: string;
  toVersion: string;
  releaseId?: string;
}
interface UpgradeResolution {
  valid: boolean;
  reason: string;
  chain: UpgradeChainStep[];
}

/**
 * Release Center — Execution Layer UI. Deliberately minimal (CTO
 * directive: "not a huge dashboard, but functional"): current version,
 * upload, per-release status at every pipeline stage, deploy/rollback
 * actions gated by permission, a per-release migration log, and (Release
 * Engine overhaul, stage 4) a per-release Upgrade Path panel that surfaces
 * `GET /release/releases/:id/upgrade-path` — "can the currently installed
 * version reach this release at all, and through which intermediate
 * releases?" — a read-only planning question, distinct from the deployment
 * gate. Real enforcement is the server's `RolesGuard` + `PermissionGuard`
 * on every `/release/*` route — this page's own `canPlatform` checks only
 * avoid showing controls a click would just 404/403 on.
 */
export function ReleaseCenter() {
  const { canPlatform } = useAuth();
  const canDeploy = canPlatform('platform.release.deploy', 'editable');
  const { t, preload } = useLanguage();

  const [version, setVersion] = useState<string | null>(null);
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [backups, setBackups] = useState<BackupRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [packageType, setPackageType] = useState<ReleasePackageType>('delta');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [migrationsByRelease, setMigrationsByRelease] = useState<Record<string, ReleaseMigrationRun[]>>({});
  const [upgradePathByRelease, setUpgradePathByRelease] = useState<Record<string, UpgradeResolution>>({});
  const [selectedBackupByRelease, setSelectedBackupByRelease] = useState<Record<string, string>>({});
  const [busyReleaseId, setBusyReleaseId] = useState<string | null>(null);
  const [creatingBackup, setCreatingBackup] = useState(false);

  preload([
    'nav.release_center',
    'field.current_version',
    'field.release_version',
    'field.package_type',
    'package_type.full',
    'package_type.delta',
    'field.status',
    'field.uploaded_at',
    'field.backup',
    'field.actions',
    'field.error',
    'field.migrations',
    'field.migration_name',
    'field.upgrade_path',
    'field.upgrade_path_reachable',
    'field.upgrade_path_unreachable',
    'field.upgrade_path_chain',
    'action.upload_release',
    'action.deploy_release',
    'action.rollback_release',
    'action.link_backup',
    'action.select_backup',
    'action.view_migrations',
    'action.create_backup',
    'action.check_upgrade_path',
    'panel.no_releases_yet',
    'panel.no_backups_yet',
    'panel.no_upgrade_path_checked',
    'release_status.registered',
    'release_status.validation_failed',
    'release_status.validated',
    'release_status.backup_verified',
    'release_status.deploying',
    'release_status.migrating',
    'release_status.health_checking',
    'release_status.succeeded',
    'release_status.failed',
    'release_status.rolled_back',
    'release_status.failed_safe',
    'backup_run_status.running',
    'backup_run_status.completed',
    'backup_run_status.failed',
    'backup_run_status.partially_failed',
  ]);

  async function load() {
    try {
      const [v, r, b] = await Promise.all([
        api.get<{ version: string }>('/release/version'),
        api.get<Release[]>('/release/releases'),
        api.get<BackupRun[]>('/release/backups'),
      ]);
      setVersion(v.version);
      setReleases(r);
      setBackups(b);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Release Center data.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onCreateBackup() {
    setCreatingBackup(true);
    setError(null);
    try {
      await api.post('/release/backups');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create backup.');
    } finally {
      setCreatingBackup(false);
    }
  }

  async function onUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('packageType', packageType);
      const res = await fetch('/api/release/releases/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAccessToken()}` },
        body: formData,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? 'Upload failed.');
      setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function loadMigrations(releaseId: string) {
    try {
      const data = await api.get<ReleaseMigrationRun[]>(`/release/releases/${releaseId}/migrations`);
      setMigrationsByRelease((prev) => ({ ...prev, [releaseId]: data }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load migration log.');
    }
  }

  /** Read-only planning call — `GET /release/releases/:id/upgrade-path` never deploys or blocks anything itself. */
  async function loadUpgradePath(releaseId: string) {
    try {
      const data = await api.get<UpgradeResolution>(`/release/releases/${releaseId}/upgrade-path`);
      setUpgradePathByRelease((prev) => ({ ...prev, [releaseId]: data }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to resolve upgrade path.');
    }
  }

  async function toggleExpand(release: Release) {
    if (expandedId === release.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(release.id);
    await Promise.all([loadMigrations(release.id), loadUpgradePath(release.id)]);
  }

  async function onLinkBackup(release: Release) {
    const backupRunId = selectedBackupByRelease[release.id];
    if (!backupRunId) return;
    setBusyReleaseId(release.id);
    setError(null);
    try {
      await api.post(`/release/releases/${release.id}/link-backup`, { backupRunId });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to link backup.');
    } finally {
      setBusyReleaseId(null);
    }
  }

  async function onDeploy(release: Release) {
    setBusyReleaseId(release.id);
    setError(null);
    try {
      await api.post(`/release/releases/${release.id}/deploy`);
      await load();
      await loadMigrations(release.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Deploy failed.');
    } finally {
      setBusyReleaseId(null);
    }
  }

  async function onRollback(release: Release) {
    setBusyReleaseId(release.id);
    setError(null);
    try {
      await api.post(`/release/releases/${release.id}/rollback`);
      await load();
      await loadMigrations(release.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rollback failed.');
    } finally {
      setBusyReleaseId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.release_center')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="detail-grid">
          <div className="detail-field">
            <div className="label">{t('field.current_version')}</div>
            <div className="value">{version ?? '—'}</div>
          </div>
        </div>
      </div>

      {error && <div className="error-text" style={{ marginBottom: 16 }}>{error}</div>}

      {canDeploy && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.package_type')}</label>
              <select value={packageType} onChange={(e) => setPackageType(e.target.value as ReleasePackageType)}>
                <option value="delta">{t('package_type.delta')}</option>
                <option value="full">{t('package_type.full')}</option>
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>ZIP</label>
              <input type="file" accept=".zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <button className="btn btn-primary" disabled={!file || uploading} onClick={onUpload}>
              {uploading ? '...' : t('action.upload_release')}
            </button>
            <button className="btn btn-secondary" disabled={creatingBackup} onClick={onCreateBackup}>
              {creatingBackup ? '...' : t('action.create_backup')}
            </button>
          </div>
        </div>
      )}

      {releases === null ? (
        <div className="empty-state">Loading…</div>
      ) : releases.length === 0 ? (
        <div className="empty-state">{t('panel.no_releases_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.release_version')}</th>
              <th>{t('field.package_type')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.uploaded_at')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((r) => {
              const isBusy = busyReleaseId === r.id;
              const upgradePath = upgradePathByRelease[r.id];
              return (
                <Fragment key={r.id}>
                  <tr>
                    <td>{r.version}</td>
                    <td>{t(`package_type.${r.packageType}`)}</td>
                    <td>
                      <StatusBadge code={`release_status.${r.status}`} />
                    </td>
                    <td>{fmtDateTime(r.uploadedAt)}</td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn btn-secondary" onClick={() => toggleExpand(r)}>
                        {t('action.view_migrations')}
                      </button>
                      {canDeploy && r.status === 'backup_verified' && (
                        <button className="btn btn-primary" disabled={isBusy} onClick={() => onDeploy(r)}>
                          {isBusy ? '...' : t('action.deploy_release')}
                        </button>
                      )}
                      {canDeploy && r.status === 'failed' && (
                        <button className="btn btn-danger" disabled={isBusy} onClick={() => onRollback(r)}>
                          {isBusy ? '...' : t('action.rollback_release')}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedId === r.id && (
                    <tr>
                      <td colSpan={5}>
                        <div className="card" style={{ margin: '8px 0' }}>
                          {r.errorMessage && (
                            <div className="detail-field" style={{ marginBottom: 12 }}>
                              <div className="label">{t('field.error')}</div>
                              <div className="value error-text">{r.errorMessage}</div>
                            </div>
                          )}

                          {canDeploy && r.status === 'validated' && (
                            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16 }}>
                              <div className="form-field" style={{ marginBottom: 0 }}>
                                <label>{t('field.backup')}</label>
                                <select
                                  value={selectedBackupByRelease[r.id] ?? ''}
                                  onChange={(e) => setSelectedBackupByRelease((prev) => ({ ...prev, [r.id]: e.target.value }))}
                                >
                                  <option value="" disabled>
                                    {t('action.select_backup')}
                                  </option>
                                  {(backups ?? []).map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.sourceAppVersion} — {fmtDateTime(b.startedAt)} — {t(`backup_run_status.${b.status}`)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <button
                                className="btn btn-primary"
                                disabled={!selectedBackupByRelease[r.id] || busyReleaseId === r.id}
                                onClick={() => onLinkBackup(r)}
                              >
                                {t('action.link_backup')}
                              </button>
                            </div>
                          )}

                          {/* Upgrade Resolver (Release Engine overhaul, stage 3/4) — read-only planning panel: "can the currently installed version reach THIS release, and how?" Never deploys or blocks anything itself. */}
                          <div style={{ marginBottom: 16 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                              <div className="label">{t('field.upgrade_path')}</div>
                              <button className="btn btn-secondary" onClick={() => loadUpgradePath(r.id)}>
                                {t('action.check_upgrade_path')}
                              </button>
                            </div>
                            {!upgradePath ? (
                              <div className="empty-state">{t('panel.no_upgrade_path_checked')}</div>
                            ) : (
                              <div className="detail-grid">
                                <div className="detail-field">
                                  <div className="label">{t('field.status')}</div>
                                  <div className="value">
                                    <span className={`status-badge ${upgradePath.valid ? 'positive' : 'negative'}`}>
                                      {upgradePath.valid ? t('field.upgrade_path_reachable') : t('field.upgrade_path_unreachable')}
                                    </span>
                                  </div>
                                </div>
                                <div className="detail-field">
                                  <div className="label">{t('field.error')}</div>
                                  <div className="value">{upgradePath.reason}</div>
                                </div>
                                {upgradePath.chain.length > 0 && (
                                  <div className="detail-field" style={{ gridColumn: '1 / -1' }}>
                                    <div className="label">{t('field.upgrade_path_chain')}</div>
                                    <div className="value">
                                      {upgradePath.chain.map((step, i) => (
                                        <span key={i}>
                                          {i > 0 && ' → '}
                                          {step.fromVersion} → {step.toVersion}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          <div className="label" style={{ marginBottom: 8 }}>
                            {t('field.migrations')}
                          </div>
                          {(migrationsByRelease[r.id] ?? []).length === 0 ? (
                            <div className="empty-state">—</div>
                          ) : (
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>{t('field.migration_name')}</th>
                                  <th>{t('field.status')}</th>
                                  <th>{t('field.error')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(migrationsByRelease[r.id] ?? []).map((m) => (
                                  <tr key={m.id}>
                                    <td>{m.migrationName}</td>
                                    <td>{m.success ? '✓' : '✗'}</td>
                                    <td>{m.errorMessage ?? '—'}</td>
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
              );
            })}
          </tbody>
        </table>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="label" style={{ marginBottom: 8 }}>
          {t('nav.release_center')} — {t('field.backup')}
        </div>
        {backups === null ? (
          <div className="empty-state">Loading…</div>
        ) : backups.length === 0 ? (
          <div className="empty-state">{t('panel.no_backups_yet')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.release_version')}</th>
                <th>{t('field.status')}</th>
                <th>{t('field.uploaded_at')}</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <td>{b.sourceAppVersion}</td>
                  <td>
                    <StatusBadge code={`backup_run_status.${b.status}`} />
                  </td>
                  <td>{fmtDateTime(b.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
