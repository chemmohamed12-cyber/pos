import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { AccessScopePanel } from '../components/AccessScopePanel';

interface MemberRow {
  userId: string;
  fullName: string;
  email: string;
  identityStatus: string;
  membership: { id: string; status: 'active' | 'suspended' | string; joinedAt: string; lastAccessAt: string | null; kind?: 'member' | 'support'; expiresAt?: string | null; reason?: string | null };
  roles: Array<{ key: string; type: string }>;
  isAdministrator: boolean;
}
interface RoleRow {
  key: string;
  type: string;
  assignable: boolean;
}
interface InvitationRow {
  id: string;
  email: string;
  fullName: string | null;
  roleKeys: string[];
  status: 'pending' | 'accepted' | 'revoked' | 'expired' | string;
  expiresAt: string;
  createdAt: string;
}
interface CreatedInvitation {
  invitation: InvitationRow;
  token: string;
  acceptPath: string;
}

const COMPANY_USERS_NODE = 'core.company.members.manage';

/** Stable backend error codes -> a message the administrator can act on. */
function explain(err: unknown, ar: boolean): string {
  if (!(err instanceof ApiError)) return ar ? 'تعذّر تنفيذ العملية.' : 'The operation failed.';
  const m: Record<string, [string, string]> = {
    LAST_ADMIN: ['لا يمكن إزالة أو إيقاف آخر مدير نشط للشركة — عيّن مديرًا آخر أولًا.', 'The Company must keep at least one active administrator — assign another one first.'],
    SELF_ROLE_CHANGE: ['لا يمكنك تغيير صلاحياتك أو حالتك بنفسك؛ اطلب من مدير آخر.', 'You cannot change your own roles or status; ask another administrator.'],
    ROLE_EXCEEDS_GRANTOR: ['لا يمكنك منح أو سحب دور يحمل صلاحيات لا تملكها أنت.', 'You can only assign or remove roles whose permissions you hold yourself.'],
    UNKNOWN_ROLE: ['دور غير معروف.', 'Unknown role.'],
    ALREADY_MEMBER: ['هذا الشخص عضو بالفعل في هذه الشركة.', 'This person is already a member of this Company.'],
    NOT_A_MEMBER: ['هذا المستخدم ليس عضوًا في هذه الشركة.', 'That user is not a member of this Company.'],
    INVALID_INPUT: ['بيانات غير صحيحة — تحقق من البريد الإلكتروني.', 'Invalid input — check the e-mail address.'],
  };
  const hit = m[err.code];
  return hit ? (ar ? hit[0] : hit[1]) : err.message;
}

/** Defined at module level: a component declared inside the page would get a new identity every render and remount (losing focus / DOM refs) on each keystroke. */
function RolePicker({ roles, selected, onToggle, ar }: { roles: RoleRow[]; selected: string[]; onToggle: (k: string) => void; ar: boolean }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 180, overflow: 'auto' }}>
      {roles.map((r) => (
        <label key={r.key} title={r.assignable ? '' : ar ? 'يتجاوز صلاحياتك' : 'Beyond your own authority'} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', opacity: r.assignable || selected.includes(r.key) ? 1 : 0.5 }}>
          <input type="checkbox" checked={selected.includes(r.key)} disabled={!r.assignable && !selected.includes(r.key)} onChange={() => onToggle(r.key)} />
          <span>{r.key}</span>
        </label>
      ))}
    </div>
  );
}

export function CompanyUsers() {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const { can, user, companyContext } = useAuth();
  const canWrite = can(COMPANY_USERS_NODE, 'editable');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [inviteRoles, setInviteRoles] = useState<string[]>([]);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [scopeFor, setScopeFor] = useState<{ userId: string; name: string } | null>(null);

  async function load() {
    try {
      const [m, r, i] = await Promise.all([api.get<MemberRow[]>('/company/users'), api.get<RoleRow[]>('/company/users/roles'), api.get<InvitationRow[]>('/company/users/invitations')]);
      setMembers(m);
      setRoles(r);
      setInvitations(i);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? (ar ? 'ليست لديك صلاحية إدارة مستخدمي الشركة.' : 'You do not have permission to manage Company users.') : explain(err, ar));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyContext?.companyId]);

  async function run(action: () => Promise<unknown>, okMessage?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (okMessage) setNotice(okMessage);
      await load();
    } catch (err) {
      setError(explain(err, ar));
    } finally {
      setBusy(false);
    }
  }

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const res = await api.post<CreatedInvitation>('/company/users/invitations', { email, fullName: fullName || undefined, roleKeys: inviteRoles });
      setCreated(res);
      setEmail('');
      setFullName('');
      setInviteRoles([]);
    });
  }

  const link = created ? `${window.location.origin}${created.acceptPath}` : '';
  const pending = useMemo(() => invitations.filter((i) => i.status === 'pending'), [invitations]);
  const toggle = (list: string[], set: (v: string[]) => void, key: string) => set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(ar ? 'ar-EG' : 'en-GB') : '—');
  const statusLabel = (s: string) => (s === 'active' ? (ar ? 'نشط' : 'Active') : s === 'suspended' ? (ar ? 'موقوف' : 'Suspended') : s);

  return (
    <div>
      <div className="page-header">
        <h1>{ar ? 'مستخدمو الشركة' : 'Company users'}</h1>
      </div>
      <p style={{ color: '#6b7280', marginTop: 0 }}>
        {ar ? 'الأعضاء الذين لهم وصول إلى هذه الشركة فقط. الدعوة تنشئ حسابًا عند القبول فقط.' : 'Only people who have access to this Company. An invitation creates nothing until it is accepted.'}
      </p>

      {error && <div className="error-text" role="alert">{error}</div>}
      {notice && <div className="success-text">{notice}</div>}

      {canWrite && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{ar ? 'دعوة مستخدم' : 'Invite a user'}</h3>
          <form onSubmit={onInvite}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{ar ? 'البريد الإلكتروني' : 'E-mail'}</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{ar ? 'الاسم (اختياري)' : 'Name (optional)'}</label>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
            </div>
            <div className="form-field" style={{ marginTop: 12 }}>
              <label>{ar ? 'الأدوار (يمكن اختيار أكثر من دور — بلا أدوار = لا يرى شيئًا)' : 'Roles (pick any number — no roles = sees nothing)'}</label>
              <RolePicker roles={roles} ar={ar} selected={inviteRoles} onToggle={(k) => toggle(inviteRoles, setInviteRoles, k)} />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {ar ? 'إنشاء دعوة' : 'Create invitation'}
            </button>
          </form>
          {created && (
            <div style={{ marginTop: 14, padding: 12, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6 }} data-testid="invitation-link">
              <div style={{ fontWeight: 600 }}>{ar ? 'تم إنشاء الدعوة — شارك هذا الرابط مع المدعو (يظهر مرة واحدة، ينتهي خلال 7 أيام):' : 'Invitation created — share this link with the invitee (shown once, expires in 7 days):'}</div>
              <input readOnly value={link} style={{ width: '100%', marginTop: 8, direction: 'ltr' }} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-secondary" style={{ marginTop: 8 }} type="button" onClick={() => navigator.clipboard?.writeText(link)}>
                {ar ? 'نسخ الرابط' : 'Copy link'}
              </button>
              <button className="btn btn-secondary" style={{ marginTop: 8, marginInlineStart: 8 }} type="button" onClick={() => setCreated(null)}>
                {ar ? 'إخفاء' : 'Hide'}
              </button>
            </div>
          )}
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>{ar ? 'الاسم' : 'Name'}</th>
            <th>{ar ? 'البريد' : 'E-mail'}</th>
            <th>{ar ? 'الأدوار' : 'Roles'}</th>
            <th>{ar ? 'الحالة' : 'Status'}</th>
            <th>{ar ? 'انضم' : 'Joined'}</th>
            <th>{ar ? 'آخر دخول' : 'Last access'}</th>
            {canWrite && <th />}
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const isSelf = m.userId === user?.id;
            return (
              <tr key={m.userId} data-testid={`member-${m.email}`}>
                <td>{m.fullName}{isSelf ? (ar ? ' (أنت)' : ' (you)') : ''}</td>
                <td style={{ direction: 'ltr', textAlign: 'start' }}>{m.email}</td>
                <td>
                  {m.membership.kind === 'support' ? (
                    <span className="status-badge" style={{ background: '#fef3c7', color: '#92400e' }} data-testid="support-badge" title={m.membership.reason ?? ''}>
                      {ar ? `وصول دعم المنصة (قراءة فقط) — ينتهي ${fmt(m.membership.expiresAt ?? null)}` : `Platform support access (read-only) — ends ${fmt(m.membership.expiresAt ?? null)}`}
                    </span>
                  ) : editing === m.userId ? (
                    <RolePicker roles={roles} ar={ar} selected={editRoles} onToggle={(k) => toggle(editRoles, setEditRoles, k)} />
                  ) : m.roles.length === 0 ? (
                    <span style={{ color: '#9ca3af' }}>{ar ? 'بلا أدوار' : 'no roles'}</span>
                  ) : (
                    m.roles.map((r) => (
                      <span key={r.key} className="status-badge" style={{ marginInlineEnd: 4 }}>{r.key}</span>
                    ))
                  )}
                </td>
                <td>{statusLabel(m.membership.status)}</td>
                <td>{fmt(m.membership.joinedAt)}</td>
                <td>{fmt(m.membership.lastAccessAt)}</td>
                {canWrite && (
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {isSelf ? (
                      <span style={{ color: '#9ca3af', fontSize: '0.85rem' }}>—</span>
                    ) : m.membership.kind === 'support' ? (
                      <button className="btn btn-secondary" disabled={busy} onClick={() => { if (window.confirm(ar ? 'إنهاء وصول الدعم الآن؟' : 'End this support access now?')) run(() => api.delete(`/company/users/${m.userId}`), ar ? 'تم إنهاء وصول الدعم.' : 'Support access ended.'); }}>
                        {ar ? 'إنهاء الوصول' : 'End access'}
                      </button>
                    ) : editing === m.userId ? (
                      <>
                        <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => { await api.put(`/company/users/${m.userId}/roles`, { roleKeys: editRoles }); setEditing(null); }, ar ? 'تم حفظ الأدوار.' : 'Roles saved.')}>
                          {ar ? 'حفظ' : 'Save'}
                        </button>{' '}
                        <button className="btn btn-secondary" onClick={() => setEditing(null)}>{ar ? 'إلغاء' : 'Cancel'}</button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-secondary" disabled={busy} onClick={() => { setEditing(m.userId); setEditRoles(m.roles.map((r) => r.key)); }}>
                          {ar ? 'الأدوار' : 'Roles'}
                        </button>{' '}
                        <button className="btn btn-secondary" disabled={busy} onClick={() => setScopeFor({ userId: m.userId, name: m.fullName })}>
                          {ar ? 'النطاق' : 'Scope'}
                        </button>{' '}
                        <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => api.patch(`/company/users/${m.userId}`, { status: m.membership.status === 'active' ? 'suspended' : 'active' }))}>
                          {m.membership.status === 'active' ? (ar ? 'إيقاف' : 'Suspend') : ar ? 'إعادة تفعيل' : 'Reactivate'}
                        </button>{' '}
                        <button className="btn btn-secondary" disabled={busy} onClick={() => { if (window.confirm(ar ? `إزالة ${m.fullName} من الشركة؟` : `Remove ${m.fullName} from this Company?`)) run(() => api.delete(`/company/users/${m.userId}`)); }}>
                          {ar ? 'إزالة' : 'Remove'}
                        </button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {scopeFor && <AccessScopePanel key={scopeFor.userId} userId={scopeFor.userId} name={scopeFor.name} ar={ar} canWrite={canWrite} onClose={() => setScopeFor(null)} />}

      <h3 style={{ marginTop: 28 }}>{ar ? 'الدعوات المعلّقة' : 'Pending invitations'}</h3>
      {pending.length === 0 ? (
        <div className="empty-state">{ar ? 'لا توجد دعوات معلّقة.' : 'No pending invitations.'}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{ar ? 'البريد' : 'E-mail'}</th>
              <th>{ar ? 'الأدوار' : 'Roles'}</th>
              <th>{ar ? 'تنتهي في' : 'Expires'}</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {pending.map((i) => (
              <tr key={i.id}>
                <td style={{ direction: 'ltr', textAlign: 'start' }}>{i.email}</td>
                <td>{i.roleKeys.length ? i.roleKeys.map((k) => <span key={k} className="status-badge" style={{ marginInlineEnd: 4 }}>{k}</span>) : '—'}</td>
                <td>{fmt(i.expiresAt)}</td>
                {canWrite && (
                  <td>
                    <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => api.delete(`/company/users/invitations/${i.id}`))}>
                      {ar ? 'إلغاء الدعوة' : 'Revoke'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
