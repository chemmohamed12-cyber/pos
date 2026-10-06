import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface PackageView {
  companyId: string;
  source: 'package' | 'installation';
  plan: { code: string; name: string; status: string; moduleCodes: string[] } | null;
  effectiveModules: string[];
  unlicensedPlanModules: string[];
  assignedAt: string | null;
}
interface PlanOption {
  code: string;
  name: string;
  status: 'active' | 'archived';
  moduleCodes: string[];
}
interface AssignResult {
  package: PackageView;
  rolesSynced: boolean;
  addedModules?: string[];
  removedModules?: string[];
}

/**
 * XNEXUS Control Plane — the Company's Package (Super Admin). Real
 * `GET/POST /installation/companies/:id/package` and `GET /installation/plans`.
 * "Effective modules" is what the Company can actually use right now:
 * its package intersected with the installation licence. A Company with no
 * package inherits the installation licence unchanged.
 */
export function CompanyPackage({ companyId, enabled }: { companyId: string; enabled: boolean }) {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const [view, setView] = useState<PackageView | null>(null);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [planCode, setPlanCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [v, p] = await Promise.all([
        api.get<PackageView>(`/installation/companies/${companyId}/package`),
        api.get<PlanOption[]>('/installation/plans'),
      ]);
      setView(v);
      setPlans(p.filter((x) => x.status === 'active'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ar ? 'تعذر تحميل الباقة.' : 'Failed to load the package.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function onAssign(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<AssignResult>(`/installation/companies/${companyId}/package`, { planCode });
      setView(res.package);
      const lost = res.removedModules ?? [];
      const gained = res.addedModules ?? [];
      setNotice(
        (ar ? 'تم إسناد الباقة وتطبيقها فورًا.' : 'Package assigned and enforced immediately.') +
          (gained.length ? (ar ? ` أُضيفت: ${gained.join('، ')}.` : ` Gained: ${gained.join(', ')}.`) : '') +
          (lost.length ? (ar ? ` فقدت الشركة الوصول إلى: ${lost.join('، ')} (البيانات والأدوار محفوظة).` : ` The company lost access to: ${lost.join(', ')} (its data and roles are kept).`) : '') +
          (res.rolesSynced ? '' : ar ? ' (تعذر تجهيز أدوار قاعدة بيانات الشركة.)' : ' (The company database roles could not be prepared.)'),
      );
      setPlanCode('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ar ? 'تعذر إسناد الباقة.' : 'Could not assign the package.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 16, maxWidth: 640 }} data-testid="company-package">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ marginTop: 0 }}>{ar ? 'باقة الشركة' : 'Company package'}</h2>
        <Link to="/control-plane/plans">{ar ? 'إدارة الباقات' : 'Manage plans'}</Link>
      </div>
      {error && <div className="error-text">{error}</div>}
      {notice && <div className="success-text">{notice}</div>}

      {view && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div data-testid="package-current">
            <strong>{ar ? 'الباقة الحالية: ' : 'Current package: '}</strong>
            {view.source === 'package' && view.plan ? `${view.plan.name} (${view.plan.code})` : ar ? 'لا توجد باقة — تُطبَّق صلاحيات الترخيص كاملة' : 'none — the installation licence applies in full'}
          </div>
          <div data-testid="package-modules">
            <strong>{ar ? 'الوحدات المتاحة فعليًا: ' : 'Effective modules: '}</strong>
            {view.effectiveModules.length ? view.effectiveModules.join(', ') : '—'}
          </div>
          {view.unlicensedPlanModules.length > 0 && (
            <div className="error-text">
              {ar ? 'وحدات في الباقة غير مشمولة بالترخيص: ' : 'Plan modules not covered by the installation licence: '}
              {view.unlicensedPlanModules.join(', ')}
            </div>
          )}
        </div>
      )}

      <form onSubmit={onAssign} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'flex-end' }}>
        <div className="form-field">
          <label>{ar ? 'إسناد باقة' : 'Assign package'}</label>
          <select value={planCode} onChange={(e) => setPlanCode(e.target.value)} required disabled={busy || !enabled}>
            <option value="">—</option>
            {plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name} ({p.moduleCodes.length} {ar ? 'وحدة' : 'modules'})
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy || !enabled || !planCode}>
          {ar ? 'إسناد' : 'Assign'}
        </button>
      </form>
    </div>
  );
}
