import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  status: string;
  roles: string[];
}
interface CreatedCompany {
  company: { id: string; name: string; status: string; databaseStatus: string | null };
}

/**
 * XNEXUS Control Plane — Create Company (P1.4). Real `POST
 * /installation/companies` (`CompanyRegistryController`) only — `name` +
 * `initialAdminUserId` are the exact DTO fields, no invented ones.
 * `initialAdminUserId` must reference an EXISTING User (D1), so it's a
 * picker over the real `GET /admin/users` (already used by `Admin.tsx`),
 * never free text. Synchronous endpoint — the whole provisioning pipeline
 * (migrations, role seeding, initial admin, health check) runs inside this
 * one request, so the wait state is a real "please wait", not a spinner
 * hiding an instant response.
 */
export function CreateCompany() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The installation's entitled modules. The API's own default for `roleModuleCodes`
  // is `[]` ("does not guess an entitlement"), which leaves a new Company's `admin`
  // without any module grants — so the UI states the entitlement it actually has.
  const [entitledModules, setEntitledModules] = useState<string[]>([]);
  // Company Plans / Packages: the Super Admin may pick the Company's package at creation.
  const [plans, setPlans] = useState<{ code: string; name: string; status: string; moduleCodes: string[] }[]>([]);
  const [planCode, setPlanCode] = useState('');
  const [packageNote, setPackageNote] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [initialAdminUserId, setInitialAdminUserId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedCompany | null>(null);

  preload([
    'module.control_plane',
    'action.create_company',
    'field.company_name',
    'field.initial_admin',
    'panel.company_provisioning_wait',
    'value.company_status.ready',
  ]);

  useEffect(() => {
    (async () => {
      try {
        setUsers(await api.get<AdminUser[]>('/admin/users'));
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load users.');
      }
      try {
        const all = await api.get<{ code: string; name: string; status: string; moduleCodes: string[] }[]>('/installation/plans');
        setPlans(all.filter((p) => p.status === 'active'));
      } catch {
        setPlans([]);
      }
      try {
        const ent = await api.get<{ modules: string[] }>('/me/entitlements');
        setEntitledModules(ent.modules ?? []);
      } catch {
        // Not fatal: without it the Company is created with the API's own default.
        setEntitledModules([]);
      }
    })();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      // With a package the Company's role catalog is prepared for exactly that package's modules; without one, for the installation's.
      const chosen = plans.find((p) => p.code === planCode);
      const roleModules = chosen ? chosen.moduleCodes : entitledModules;
      const data = await api.post<CreatedCompany>('/installation/companies', {
        name,
        initialAdminUserId,
        ...(roleModules.length > 0 ? { roleModuleCodes: roleModules } : {}),
      });
      if (chosen) {
        try {
          await api.post(`/installation/companies/${data.company.id}/package`, { planCode: chosen.code });
          setPackageNote(`${chosen.name} (${chosen.code})`);
        } catch (err) {
          setPackageNote(null);
          setError(`Company created, but assigning the package failed: ${err instanceof ApiError ? err.message : 'unknown error'}. Assign it from the company page.`);
        }
      }
      setResult(data);
    } catch (err) {
      // A failed provisioning attempt can still leave a real Company row
      // behind (see `CompanyRegistryController` doc comment) — the error
      // response carries only a message string, no companyId, so the
      // Registry list (not this page) is where that row shows up.
      setError(err instanceof ApiError ? err.message : 'Failed to create company.');
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div>
        <div className="page-header">
          <h1>{t('action.create_company')}</h1>
        </div>
        <div className="card">
          <p>
            <strong>{result.company.name}</strong> — {t(`value.company_status.${result.company.status.toLowerCase()}`)}
          </p>
          {packageNote && <p data-testid="created-package">Package: {packageNote}</p>}
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary" onClick={() => navigate('/control-plane')}>
            {t('nav.company_registry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('action.create_company')}</h1>
      </div>

      {loadError && <div className="error-text">{loadError}</div>}
      {error && <div className="error-text">{error}</div>}

      <form onSubmit={onSubmit} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
        <div className="form-field">
          <label>{t('field.company_name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required disabled={submitting} />
        </div>
        <div className="form-field">
          <label>{t('field.initial_admin')}</label>
          <select value={initialAdminUserId} onChange={(e) => setInitialAdminUserId(e.target.value)} required disabled={submitting}>
            <option value="">—</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName} — {u.email}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>Package</label>
          <select value={planCode} onChange={(e) => setPlanCode(e.target.value)} disabled={submitting}>
            <option value="">—</option>
            {plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name} ({p.moduleCodes.length})
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" type="submit" disabled={submitting || !name || !initialAdminUserId}>
          {submitting ? t('panel.company_provisioning_wait') : t('action.create_company')}
        </button>
      </form>
    </div>
  );
}
