import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { currentLang } from '../lib/displayNames';

interface Definition {
  key: string;
  labelEn: string;
  labelAr: string;
  definition: string;
  source: string;
  kind: string;
}
interface Row {
  bucket: 'branch' | 'unit' | 'company_level' | 'unassigned';
  unitId: string | null;
  name: string;
  metrics: Record<string, number | null>;
  hasActivity: boolean;
}
interface Report {
  period: { from: string | null; to: string | null; basis: string };
  definitions: Definition[];
  rows: Row[];
  totals: Record<string, number | null>;
  reconciliation: Array<{ metric: string; reportTotal: number | null; sourceTotal: number | null; reconciles: boolean | null }>;
  costCenters: Array<{ valueId: string; code: string; name: string; debitBase: number; creditBase: number }> | null;
}
interface Unit {
  id: string;
  name: string;
  type: string;
}

/** Organizational report: Company / branch / unit / cost centre / period. `—` = the module is not installed (NOT zero); `0` = installed, nothing happened. */
export function OrganizationReport() {
  const ar = currentLang() === 'ar';
  const tr = (a: string, e: string) => (ar ? a : e);
  const [report, setReport] = useState<Report | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [unitId, setUnitId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (unitId) qs.set('unitId', unitId);
      setReport(await api.get<Report>(`/reports/organization/overview${qs.size ? `?${qs}` : ''}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the report.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api.get<Array<Unit & { status?: string }>>('/organization/units').then((all) => setUnits(all.filter((u) => (u.status ?? 'active') === 'active'))).catch(() => undefined);
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cell = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString(ar ? 'ar-EG' : 'en-US', { maximumFractionDigits: 2 }));
  const rowName = (r: Row) => (r.bucket === 'unassigned' ? tr('غير مرتبط بفرع (سجلات قديمة)', 'Unassigned (legacy records)') : r.bucket === 'company_level' ? tr('مستوى الشركة (بلا فرع)', 'Company level (no branch)') : r.name);

  return (
    <div>
      <div className="page-header">
        <h1>{tr('التقرير التنظيمي', 'Organizational report')}</h1>
        <Link className="btn btn-secondary" to="/organization">
          {tr('الهيكل التنظيمي', 'Organization')}
        </Link>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{tr('من', 'From')}</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{tr('إلى', 'To')}</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{tr('الوحدة', 'Unit')}</label>
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">{tr('كل الشركة (تجميع حسب الفرع)', 'Whole Company (by branch)')}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" onClick={run} disabled={loading}>
          {tr('عرض', 'Run')}
        </button>
      </div>

      {report && (
        <>
          <table className="data-table" data-testid="org-report-table">
            <thead>
              <tr>
                <th>{tr('الفرع / الوحدة', 'Branch / unit')}</th>
                {report.definitions.map((d) => (
                  <th key={d.key} title={`${d.definition}\n${d.source}`}>
                    {ar ? d.labelAr : d.labelEn}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={(r.unitId ?? r.bucket) + r.bucket} style={r.hasActivity ? undefined : { opacity: 0.6 }}>
                  <td>{rowName(r)}</td>
                  {report.definitions.map((d) => (
                    <td key={d.key}>{cell(r.metrics[d.key])}</td>
                  ))}
                </tr>
              ))}
              <tr style={{ fontWeight: 600 }}>
                <td>{tr('الإجمالي', 'Total')}</td>
                {report.definitions.map((d) => (
                  <td key={d.key}>{cell(report.totals[d.key])}</td>
                ))}
              </tr>
            </tbody>
          </table>
          <p style={{ fontSize: '0.85rem', opacity: 0.8 }}>
            {tr('— تعني أن الوحدة غير مفعّلة في هذه الشركة (وليست صفراً). الصفر يعني عدم وجود نشاط. الفترة بالأيام حسب التوقيت العالمي.', '"—" means the module is not installed in this Company (not zero). 0 means no activity. Periods are UTC calendar days.')}{' '}
            {report.reconciliation.some((x) => x.reconciles === false)
              ? tr('تنبيه: يوجد فرق بين مجموع التقرير ومصدره.', 'Warning: the report total differs from its source.')
              : report.reconciliation.some((x) => x.reconciles === true)
                ? tr('المجاميع مطابقة لمصادرها.', 'Totals reconcile with their sources.')
                : ''}
          </p>
          {report.costCenters && report.costCenters.length > 0 && (
            <>
              <h3>{tr('مراكز التكلفة', 'Cost centres')}</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{tr('الكود', 'Code')}</th>
                    <th>{tr('الاسم', 'Name')}</th>
                    <th>{tr('مدين', 'Debit')}</th>
                    <th>{tr('دائن', 'Credit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.costCenters.map((c) => (
                    <tr key={c.valueId}>
                      <td>{c.code}</td>
                      <td>{c.name}</td>
                      <td>{cell(c.debitBase)}</td>
                      <td>{cell(c.creditBase)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
