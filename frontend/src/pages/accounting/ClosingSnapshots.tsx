import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { fmtDateTime } from '../../lib/formatDateTime';
import { loadingLabel } from '../../lib/displayNames';

interface ClosingSnapshotRun {
  id: string;
  closeSequence: number;
  supersedesSnapshotId: string | null;
  approvalRequestId: string;
  status: 'pending' | 'complete' | 'failed';
  contentHash: string | null;
  manifestHash: string | null;
  signingKeyId: string | null;
  generatedAt: string | null;
  createdAt: string;
}
interface VerifyResult {
  ok: boolean;
  contentHashMatches: boolean;
  signatureValid: boolean;
  chainValid: boolean | null;
  reason?: string;
}

const PRELOAD = [
  'nav.closing_snapshots',
  'field.close_sequence',
  'field.supersedes_snapshot',
  'field.snapshot_status',
  'field.content_hash',
  'field.manifest_hash',
  'field.signing_key_id',
  'field.generated_at',
  'field.actions',
  'value.snapshot_status.pending',
  'value.snapshot_status.complete',
  'value.snapshot_status.failed',
  'action.verify_snapshot',
  'panel.no_closing_snapshots_yet',
  'panel.snapshot_verify_result',
  'panel.snapshot_content_hash_matches',
  'panel.snapshot_signature_valid',
  'panel.snapshot_chain_valid',
  'panel.snapshot_chain_no_predecessor',
];

/**
 * ADR-058 (Wave 1 Frontend Completion) — Immutable Black Box: Closing Snapshot list + verify.
 * Deliberately read-only: no delete, edit, regenerate, or download control — the backend has no
 * mutating endpoint for any of those (ADR-051's own "no destructive actions" requirement).
 * `supersedesSnapshotId` renders the close/reclose chain a period may accumulate over time.
 */
export function ClosingSnapshots() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const { periodId } = useParams<{ periodId: string }>();

  const [snapshots, setSnapshots] = useState<ClosingSnapshotRun[] | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!periodId) return;
    try {
      setSnapshots(await api.get<ClosingSnapshotRun[]>(`/accounting/fiscal-periods/${periodId}/closing-snapshots`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load closing snapshots.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  async function verify(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const result = await api.post<VerifyResult>(`/accounting/closing-snapshots/${id}/verify`);
      setVerifyResults((prev) => ({ ...prev, [id]: result }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to verify snapshot.');
    } finally {
      setBusyId(null);
    }
  }

  function chainLabel(v: boolean | null) {
    if (v === null) return t('panel.snapshot_chain_no_predecessor');
    return v ? '✓' : '✗';
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.closing_snapshots')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      {snapshots === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : snapshots.length === 0 ? (
        <div className="empty-state">{t('panel.no_closing_snapshots_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.close_sequence')}</th>
              <th>{t('field.supersedes_snapshot')}</th>
              <th>{t('field.snapshot_status')}</th>
              <th>{t('field.content_hash')}</th>
              <th>{t('field.signing_key_id')}</th>
              <th>{t('field.generated_at')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((s) => (
              <tr key={s.id}>
                <td>{s.closeSequence}</td>
                <td>{s.supersedesSnapshotId ? `#${s.supersedesSnapshotId.slice(0, 8)}` : '—'}</td>
                <td>
                  <StatusBadge code={`value.snapshot_status.${s.status}`} />
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.contentHash ? s.contentHash.slice(0, 20) + '…' : '—'}</td>
                <td>{s.signingKeyId ?? '—'}</td>
                <td>{s.generatedAt ? fmtDateTime(s.generatedAt) : '—'}</td>
                <td>
                  {s.status === 'complete' && (
                    <button className="btn btn-secondary" disabled={busyId === s.id} onClick={() => verify(s.id)}>
                      {t('action.verify_snapshot')}
                    </button>
                  )}
                  {verifyResults[s.id] && (
                    <div style={{ fontSize: 12, marginTop: 6 }}>
                      <div>{t('panel.snapshot_verify_result')}: {verifyResults[s.id].ok ? '✓' : '✗'}</div>
                      <div>
                        {t('panel.snapshot_content_hash_matches')}: {verifyResults[s.id].contentHashMatches ? '✓' : '✗'}
                      </div>
                      <div>
                        {t('panel.snapshot_signature_valid')}: {verifyResults[s.id].signatureValid ? '✓' : '✗'}
                      </div>
                      <div>
                        {t('panel.snapshot_chain_valid')}: {chainLabel(verifyResults[s.id].chainValid)}
                      </div>
                      {verifyResults[s.id].reason && <div className="error-text">{verifyResults[s.id].reason}</div>}
                    </div>
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
