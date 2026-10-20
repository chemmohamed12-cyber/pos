import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { ErrorState } from '../../components/ErrorState';
import { loadingLabel } from '../../lib/displayNames';

interface CatalogModule {
  code: string;
  titleCode: string;
  dependsOn: string[];
  closure: string[];
  licensed: boolean;
}
interface PlanView {
  code: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  moduleCodes: string[];
  companyCount: number;
}
interface SaveResult {
  plan?: PlanView;
  addedByDependency: string[];
  affectedCompanyIds?: string[];
  addedModules?: string[];
  removedModules?: string[];
}

/**
 * XNEXUS Control Plane — Company Plans / Packages (Super Admin). A Plan is a
 * named set of modules a Company can be given. Real `GET /installation/module-catalog`,
 * `GET/POST /installation/plans[/:code]` only. Choosing a module also selects
 * everything it depends on (the dependency graph is cyclic, so e.g. Sales brings
 * Inventory, Finance and Accounting) — the server enforces the same closure and
 * rejects modules the installation licence does not include.
 */
export function Plans() {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const [catalog, setCatalog] = useState<CatalogModule[] | null>(null);
  const [plans, setPlans] = useState<PlanView[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [editing, setEditing] = useState<string | null>(null); // plan code being edited, or '' for create, null = form closed
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const [c, p] = await Promise.all([api.get<CatalogModule[]>('/installation/module-catalog'), api.get<PlanView[]>('/installation/plans')]);
      setCatalog(c);
      setPlans(p);
    } catch (err) {
      setLoadError(err);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const byCode = useMemo(() => new Map((catalog ?? []).map((m) => [m.code, m])), [catalog]);

  function openCreate() {
    setEditing('');
    setCode('');
    setName('');
    setDescription('');
    setSelected(new Set());
    setError(null);
    setNotice(null);
  }

  function openEdit(p: PlanView) {
    setEditing(p.code);
    setCode(p.code);
    setName(p.name);
    setDescription(p.description ?? '');
    setSelected(new Set(p.moduleCodes));
    setError(null);
    setNotice(null);
  }

  function toggle(m: CatalogModule, on: boolean) {
    const next = new Set(selected);
    if (on) {
      next.add(m.code);
      for (const dep of m.closure) next.add(dep); // the same closure the server stores
    } else {
      next.delete(m.code);
      // un-ticking a module also un-ticks anything that needs it
      for (const other of catalog ?? []) if (other.closure.includes(m.code)) next.delete(other.code);
    }
    setSelected(next);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = { name, description: description || undefined, moduleCodes: [...selected] };
      const res =
        editing === ''
          ? await api.post<SaveResult>('/installation/plans', { code, ...body })
          : await api.post<SaveResult>(`/installation/plans/${editing}`, body);
      const added = res.addedByDependency ?? [];
      const removed = res.removedModules ?? [];
      const gained = res.addedModules ?? [];
      const companies = res.affectedCompanyIds?.length ?? 0;
      let message = (ar ? 'تم حفظ الباقة.' : 'Plan saved.') + (added.length ? (ar ? ` أُضيفت تلقائيًا بسبب الاعتمادية: ${added.join('، ')}` : ` Added automatically as dependencies: ${added.join(', ')}.`) : '');
      // The change is enforced immediately for every Company on this plan; nothing is deleted.
      if (companies > 0 && (removed.length || gained.length)) {
        message += ar
          ? ` أثّر التغيير فورًا على ${companies} شركة${gained.length ? ` — أُضيفت: ${gained.join('، ')}` : ''}${removed.length ? ` — أُزيلت: ${removed.join('، ')} (تُحفظ البيانات والأدوار لكن يُمنع الوصول)` : ''}.`
          : ` Applied immediately to ${companies} company(ies)${gained.length ? ` — gained: ${gained.join(', ')}` : ''}${removed.length ? ` — lost: ${removed.join(', ')} (their data and roles are kept, access is blocked)` : ''}.`;
      }
      setNotice(message);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ar ? 'تعذر حفظ الباقة.' : 'Could not save the plan.');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(p: PlanView, status: 'active' | 'archived') {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/installation/plans/${p.code}`, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the plan status.');
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <ErrorState error={loadError} onRetry={load} />;

  return (
    <div data-testid="plans-page">
      <div className="page-header">
        <h1>{ar ? 'الباقات' : 'Plans / Packages'}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/control-plane" className="btn btn-secondary">
            {ar ? 'سجل الشركات' : 'Company registry'}
          </Link>
          <button className="btn btn-primary" onClick={openCreate} disabled={busy || editing !== null}>
            {ar ? 'إنشاء باقة' : 'Create plan'}
          </button>
        </div>
      </div>

      {notice && <div className="success-text" data-testid="plans-notice">{notice}</div>}
      {error && <div className="error-text">{error}</div>}

      {editing !== null && catalog && (
        <form onSubmit={onSubmit} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640, marginBottom: 16 }} data-testid="plan-form">
          <h2 style={{ margin: 0 }}>{editing === '' ? (ar ? 'باقة جديدة' : 'New plan') : ar ? 'تعديل الباقة' : 'Edit plan'}</h2>
          <div className="form-field">
            <label>{ar ? 'الرمز (حروف صغيرة وأرقام و - _)' : 'Code (lowercase, digits, - _)'}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} required disabled={busy || editing !== ''} />
          </div>
          <div className="form-field">
            <label>{ar ? 'الاسم' : 'Name'}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required disabled={busy} />
          </div>
          <div className="form-field">
            <label>{ar ? 'الوصف' : 'Description'}</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
          </div>
          <div className="form-field">
            <label>{ar ? 'الوحدات' : 'Modules'}</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {catalog.map((m) => (
                <label key={m.code} style={{ display: 'flex', gap: 8, alignItems: 'baseline', opacity: m.licensed ? 1 : 0.5 }}>
                  <input
                    type="checkbox"
                    data-module={m.code}
                    checked={selected.has(m.code)}
                    disabled={busy || !m.licensed}
                    onChange={(e) => toggle(m, e.target.checked)}
                  />
                  <span>
                    <strong>{m.code}</strong>
                    {m.closure.length > 0 && (
                      <small style={{ marginInlineStart: 6 }}>
                        {ar ? 'يتطلب:' : 'needs:'} {m.closure.join(', ')}
                      </small>
                    )}
                    {!m.licensed && <small style={{ marginInlineStart: 6 }}>{ar ? '(غير مشمول بالترخيص)' : '(not in the installation licence)'}</small>}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" type="submit" disabled={busy || selected.size === 0 || !name.trim() || (editing === '' && !code.trim())}>
              {ar ? 'حفظ' : 'Save'}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setEditing(null)} disabled={busy}>
              {ar ? 'إلغاء' : 'Cancel'}
            </button>
          </div>
        </form>
      )}

      {plans === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : plans.length === 0 ? (
        <div className="empty-state">{ar ? 'لا توجد باقات بعد.' : 'No plans yet.'}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{ar ? 'الباقة' : 'Plan'}</th>
              <th>{ar ? 'الوحدات' : 'Modules'}</th>
              <th>{ar ? 'الشركات' : 'Companies'}</th>
              <th>{ar ? 'الحالة' : 'Status'}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.code} data-plan={p.code}>
                <td>
                  <strong>{p.name}</strong>
                  <div>
                    <small>{p.code}</small>
                  </div>
                </td>
                <td>{p.moduleCodes.filter((m) => byCode.has(m) || !catalog).join(', ')}</td>
                <td>{p.companyCount}</td>
                <td>{p.status === 'active' ? (ar ? 'نشطة' : 'active') : ar ? 'مؤرشفة' : 'archived'}</td>
                <td style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-secondary" disabled={busy || editing !== null} onClick={() => openEdit(p)}>
                    {ar ? 'تعديل' : 'Edit'}
                  </button>
                  {p.status === 'active' ? (
                    <button className="btn btn-secondary" disabled={busy} onClick={() => setStatus(p, 'archived')}>
                      {ar ? 'أرشفة' : 'Archive'}
                    </button>
                  ) : (
                    <button className="btn btn-secondary" disabled={busy} onClick={() => setStatus(p, 'active')}>
                      {ar ? 'استعادة' : 'Restore'}
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
