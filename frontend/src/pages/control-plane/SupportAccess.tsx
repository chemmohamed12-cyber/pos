import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';

interface CompanyView {
  id: string;
  name: string;
  status: string;
}
interface PlatformUser {
  id: string;
  fullName: string;
  email: string;
  roles: string[];
}
interface SupportRow {
  companyId: string;
  companyName: string | null;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  reason: string;
  grantedBy: string | null;
  expiresAt: string;
}

const PLATFORM_ROLES = ['admin', 'platform_super_admin', 'company_manager', 'support_operations', 'platform_audit_readonly'];

/**
 * XNEXUS Control Plane — Support access (F4). Explicit, reason-required, time-boxed (≤ 8 h), audited and visible to the Company: the only way a platform user enters
 * a Company. Real `GET/POST/DELETE /platform/support-access`; nothing here reads Company data.
 */
export function SupportAccess() {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const { canPlatform } = useAuth();
  const canGrant = canPlatform('platform.support.grant', 'editable');
  const canRevoke = canPlatform('platform.support.revoke', 'editable');
  const [rows, setRows] = useState<SupportRow[]>([]);
  const [companies, setCompanies] = useState<CompanyView[]>([]);
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [r, c] = await Promise.all([api.get<SupportRow[]>('/platform/support-access'), api.get<CompanyView[]>('/installation/companies')]);
      setRows(r);
      setCompanies(c.filter((x) => x.status === 'READY'));
      try {
        setUsers((await api.get<PlatformUser[]>('/admin/users')).filter((u) => u.roles.some((k) => PLATFORM_ROLES.includes(k))));
      } catch {
        setUsers([]); // no platform.user.view: the grantor can still open access for themselves
      }
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ar ? 'تعذّر التحميل.' : 'Failed to load.');
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function onGrant(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/platform/support-access', { companyId, userId: userId || undefined, reason, hours });
      setReason('');
      setNotice(ar ? 'تم فتح وصول الدعم (يظهر للشركة ويُسجَّل في التدقيق).' : 'Support access opened (visible to the Company and audited).');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ar ? 'تعذّر فتح الوصول.' : 'Could not open access.');
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(r: SupportRow) {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/platform/support-access/${r.companyId}/${r.userId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString(ar ? 'ar-EG' : 'en-GB');
  return (
    <div>
      <div className="page-header">
        <h1>{ar ? 'وصول الدعم إلى الشركات' : 'Support access to Companies'}</h1>
      </div>
      <p style={{ color: '#6b7280', marginTop: 0 }}>
        {ar ? 'وصول صريح، محدد المدة (حتى 8 ساعات)، بسبب موثق، للقراءة فقط، يظهر لمدراء الشركة ويُسجَّل في سجل تدقيقها. لا يوجد وصول دائم.' : 'Explicit, time-boxed (up to 8 hours), reason-required, read-only, visible to the Company administrators and recorded in its audit. There is no standing access.'}
      </p>
      {error && <div className="error-text" role="alert">{error}</div>}
      {notice && <div className="success-text">{notice}</div>}
      {canGrant && (
        <form onSubmit={onGrant} className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{ar ? 'الشركة' : 'Company'}</label>
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} required data-testid="support-company">
                <option value="">—</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{ar ? 'لصالح (افتراضيًا: أنت)' : 'For (default: yourself)'}</label>
              <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">{ar ? 'أنا' : 'Me'}</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{ar ? 'المدة (ساعات)' : 'Hours'}</label>
              <input type="number" min={1} max={8} value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ width: 80 }} />
            </div>
          </div>
          <div className="form-field" style={{ marginTop: 12 }}>
            <label>{ar ? 'السبب (إلزامي، 10 أحرف على الأقل)' : 'Reason (required, at least 10 characters)'}</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} style={{ width: '100%' }} required minLength={10} data-testid="support-reason" />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy || reason.trim().length < 10 || !companyId}>{ar ? 'فتح وصول الدعم' : 'Open support access'}</button>
        </form>
      )}
      <table className="data-table">
        <thead>
          <tr>
            <th>{ar ? 'الشركة' : 'Company'}</th>
            <th>{ar ? 'الشخص' : 'Person'}</th>
            <th>{ar ? 'السبب' : 'Reason'}</th>
            <th>{ar ? 'ينتهي' : 'Ends'}</th>
            {canRevoke && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={5} style={{ color: '#9ca3af' }}>{ar ? 'لا يوجد وصول دعم نشط.' : 'No active support access.'}</td></tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.companyId}-${r.userId}`} data-testid={`support-${r.userEmail}`}>
              <td>{r.companyName}</td>
              <td>{r.userName} <span style={{ color: '#9ca3af', direction: 'ltr' }}>{r.userEmail}</span></td>
              <td>{r.reason}</td>
              <td>{fmt(r.expiresAt)}</td>
              {canRevoke && <td><button className="btn btn-secondary" disabled={busy} onClick={() => onRevoke(r)}>{ar ? 'إنهاء الآن' : 'End now'}</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
