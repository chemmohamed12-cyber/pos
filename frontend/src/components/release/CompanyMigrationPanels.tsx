import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { currentLang } from '../../lib/displayNames';

/**
 * Company migration panels for the Release Center (CTO 2026-10-21): the operator must be able to see, before and after activation, how many Company databases were
 * checked, migrated, failed or left stale - and whether every Company is current NOW. Both panels are read-only: they call
 *   GET /release/company-migrations                       (live, against the installed build: pending migrations + schema check per Company)
 *   GET /release/releases/:id/company-migration-report    (what the engine recorded for the latest deploy attempt of a release)
 * and never deploy, migrate or change anything.
 */
interface PlanCompany {
  name: string;
  database: string;
  pendingCount: number;
  schemaCheck?: { ran: boolean; error?: string; missingTableCount?: number; tablesWithMissingColumns?: number; missingTables?: string[] };
}
interface LiveStatus {
  installedBuild: string;
  configuredMode: string;
  modeExplicit: boolean;
  allCurrent: boolean;
  decision: string;
  blockers: string[];
  warnings: string[];
  counts: { evaluated: number; needingMigration: number; withSchemaFindings: number; staleSkipped: number; outOfScope: number };
  staleCompanies: Array<{ companyName: string | null; status: string | null }>;
  plan: { companies: PlanCompany[] };
}
interface Report {
  attempt: { outcome: string; mode: string | null; modeExplicit: boolean | null };
  counts: { evaluated: number; needingMigration: number; migrated: number; noop: number; failed: number; notAttempted: number; staleSkipped: number; outOfScope: number };
  gate: Array<{ phase: string; decision: string | null; blockers: string[]; warnings: string[] }>;
  companies: Array<{ company: string; status: string; executed: string[]; error: string | null; backupRunId: string | null }>;
  staleCompanies: Array<{ name: string | null; status: string | null }>;
  databasesAheadOfActiveApplication: boolean;
  headline: string;
}

const useL = () => {
  const ar = currentLang() === 'ar';
  return (a: string, e: string) => (ar ? a : e);
};

export function CompanyMigrationLivePanel() {
  const L = useL();
  const [data, setData] = useState<LiveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setData(await api.get<LiveStatus>('/release/company-migrations'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : L('تعذّر فحص قواعد الشركات.', 'Could not check the Company databases.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="label" style={{ margin: 0 }}>{L('قواعد بيانات الشركات مقابل الإصدار المثبّت', 'Company databases vs the installed build')}</div>
        <button className="btn btn-secondary" disabled={busy} onClick={load}>
          {busy ? '...' : L('فحص الآن (قراءة فقط)', 'Check now (read-only)')}
        </button>
      </div>
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      {data && (
        <div style={{ marginTop: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <span className={`status-badge ${data.allCurrent ? 'positive' : 'negative'}`}>
              {data.allCurrent ? L('كل الشركات محدّثة', 'Every Company is current') : L('توجد شركات متأخرة عن الإصدار', 'Some Companies are behind')}
            </span>{' '}
            <span className="muted">
              {L('الإصدار', 'Build')} {data.installedBuild} · {L('الشركات المفحوصة', 'checked')}: {data.counts.evaluated} · {L('تحتاج ترحيلًا', 'need migrations')}: {data.counts.needingMigration} ·{' '}
              {L('اختلاف مخطط', 'schema findings')}: {data.counts.withSchemaFindings} · {L('معلّقة (غير جاهزة)', 'stale (not READY)')}: {data.counts.staleSkipped}
            </span>
          </div>
          {data.blockers.length > 0 && (
            <ul className="error-text" style={{ margin: '0 0 8px', paddingInlineStart: 18 }}>
              {data.blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
          {data.warnings.length > 0 && (
            <ul className="muted" style={{ margin: '0 0 8px', paddingInlineStart: 18 }}>
              {data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          {data.plan.companies.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{L('الشركة', 'Company')}</th>
                  <th>{L('ترحيلات ناقصة', 'Pending migrations')}</th>
                  <th>{L('فحص المخطط', 'Schema check')}</th>
                </tr>
              </thead>
              <tbody>
                {data.plan.companies.map((c) => {
                  const s = c.schemaCheck;
                  const schemaText = !s
                    ? '—'
                    : !s.ran
                      ? L('تعذّر الفحص', 'could not run')
                      : (s.missingTableCount ?? 0) + (s.tablesWithMissingColumns ?? 0) === 0
                        ? L('مطابق', 'matches')
                        : `${s.missingTableCount ?? 0} ${L('جدول ناقص', 'missing table(s)')}, ${s.tablesWithMissingColumns ?? 0} ${L('جدول بأعمدة ناقصة', 'table(s) with missing columns')}`;
                  return (
                    <tr key={c.database}>
                      <td>{c.name}</td>
                      <td>{c.pendingCount}</td>
                      <td>{schemaText}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export function CompanyMigrationReportPanel({ releaseId }: { releaseId: string }) {
  const L = useL();
  const [data, setData] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setData(await api.get<Report>(`/release/releases/${releaseId}/company-migration-report`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : L('تعذّر تحميل تقرير ترحيل الشركات.', 'Could not load the Company migration report.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div className="label">{L('تقرير ترحيل الشركات (آخر محاولة نشر)', 'Company migration report (latest deploy attempt)')}</div>
        <button className="btn btn-secondary" disabled={busy} onClick={load}>
          {busy ? '...' : L('عرض التقرير', 'Show report')}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {data && (
        <div>
          <div style={{ marginBottom: 8 }}>
            <span className={`status-badge ${data.attempt.outcome === 'succeeded' || data.attempt.outcome === 'plan_only' ? 'positive' : data.attempt.outcome === 'failed' ? 'negative' : ''}`}>{data.attempt.outcome}</span>{' '}
            {data.headline}
          </div>
          {data.databasesAheadOfActiveApplication && (
            <div className="error-text" style={{ marginBottom: 8 }}>
              {L('قواعد البيانات أحدث من التطبيق النشط (الترحيلات إضافية فقط فيستمر التطبيق بالعمل). أصلح السبب وأعد تشغيل نفس الإصدار؛ لا تتكرر الترحيلات المكتملة.', 'The databases are ahead of the active application (migrations are expand-only, so it keeps working). Fix the cause and re-run the same release; completed migrations are not repeated.')}
            </div>
          )}
          {data.gate.map((g, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              <strong>{g.phase}</strong>: {g.decision}
              {g.blockers.length > 0 && <span className="error-text"> — {g.blockers.join(' | ')}</span>}
              {g.warnings.length > 0 && <span className="muted"> — {g.warnings.join(' | ')}</span>}
            </div>
          ))}
          {data.staleCompanies.length > 0 && (
            <div className="muted" style={{ marginBottom: 8 }}>
              {L('شركات معلّقة تحتاج استكمال قبل إعادة تفعيلها', 'STALE Companies - catch up before reactivation')}: {data.staleCompanies.map((s) => `${s.name} (${s.status})`).join(', ')}
            </div>
          )}
          {data.companies.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{L('الشركة', 'Company')}</th>
                  <th>{L('الحالة', 'Status')}</th>
                  <th>{L('ترحيلات نُفّذت', 'Migrations run')}</th>
                  <th>{L('نقطة الاستعادة', 'Restore point')}</th>
                  <th>{L('الخطأ', 'Error')}</th>
                </tr>
              </thead>
              <tbody>
                {data.companies.map((c) => (
                  <tr key={c.company}>
                    <td>{c.company}</td>
                    <td>{c.status}</td>
                    <td>{c.executed.length}</td>
                    <td>{c.backupRunId ?? '—'}</td>
                    <td>{c.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
