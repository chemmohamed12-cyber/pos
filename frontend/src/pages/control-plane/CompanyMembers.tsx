import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  status: string;
}
interface MembershipRow {
  id: string;
  userId: string;
  companyId: string;
  roleKey: string;
}

/**
 * The role catalog every Company database is provisioned with
 * (`company-role-seeding.ts` + the core role migrations). A Membership can
 * only grant a role that exists in that Company's own database
 * (`provisionUserRoleForMembership`), so the picker is limited to it.
 */
const COMPANY_ROLE_KEYS = [
  'admin',
  'finance',
  'sales_manager',
  'sales_supervisor',
  'sales_rep',
  'inventory_controller',
  'warehouse_supervisor',
  'warehouse_worker',
  'driver',
];

/**
 * XNEXUS Control Plane — Company Members. Real Installation-level
 * `GET/POST/DELETE /installation/companies/:companyId/memberships` only
 * (platform `admin`; see `InstallationMembershipController`). Users come
 * from the real `GET /admin/users`. A role is changed by removing and
 * re-adding the Membership — the shared `api` helper has no PATCH.
 */
export function CompanyMembers({ companyId, enabled }: { companyId: string; enabled: boolean }) {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [rows, setRows] = useState<MembershipRow[]>([]);
  const [userId, setUserId] = useState('');
  const [roleKey, setRoleKey] = useState('admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [u, m] = await Promise.all([
        api.get<AdminUser[]>('/admin/users'),
        api.get<MembershipRow[]>(`/installation/companies/${companyId}/memberships`),
      ]);
      setUsers(u);
      setRows(m);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ar ? 'تعذر تحميل الأعضاء.' : 'Failed to load members.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const byId = new Map(users.map((u) => [u.id, u]));
  const assignable = users.filter((u) => !rows.some((r) => r.userId === u.id));

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/installation/companies/${companyId}/memberships`, { userId, roleKey });
      setUserId('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ar ? 'تعذر إضافة العضو.' : 'Could not add member.');
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(uid: string) {
    if (!window.confirm(ar ? 'إزالة هذا المستخدم من الشركة؟' : 'Remove this user from the company?')) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/installation/companies/${companyId}/memberships/${uid}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ar ? 'تعذرت إزالة العضو.' : 'Could not remove member.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 16, maxWidth: 640 }} data-testid="company-members">
      <h2 style={{ marginTop: 0 }}>{ar ? 'أعضاء الشركة' : 'Company members'}</h2>
      {error && <div className="error-text">{error}</div>}

      {rows.length === 0 ? (
        <div className="empty-state">{ar ? 'لا يوجد أعضاء.' : 'No members yet.'}</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{ar ? 'المستخدم' : 'User'}</th>
              <th>{ar ? 'الدور' : 'Role'}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const u = byId.get(r.userId);
              return (
                <tr key={r.id}>
                  <td>{u ? `${u.fullName} — ${u.email}` : r.userId}</td>
                  <td>{r.roleKey}</td>
                  <td>
                    <button className="btn btn-secondary" disabled={busy || !enabled} onClick={() => onRemove(r.userId)}>
                      {ar ? 'إزالة' : 'Remove'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <form onSubmit={onAdd} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'flex-end' }}>
        <div className="form-field">
          <label>{ar ? 'المستخدم' : 'User'}</label>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required disabled={busy || !enabled}>
            <option value="">—</option>
            {assignable.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName} — {u.email}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>{ar ? 'الدور' : 'Role'}</label>
          <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)} disabled={busy || !enabled}>
            {COMPANY_ROLE_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy || !enabled || !userId}>
          {ar ? 'إضافة عضو' : 'Add member'}
        </button>
      </form>
    </div>
  );
}
