import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';

interface PlatformNode {
  node: string;
  risk: 'low' | 'sensitive' | 'platform-critical';
  titleEn: string;
  titleAr: string;
}
interface PlatformRole {
  key: string;
  type: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  grants: Array<{ node: string; access: string }> | string;
  holders: number;
}
interface AdminUser {
  id: string;
  fullName: string;
  email: string;
  roles: string[];
}

/** XNEXUS Control Plane — the platform roles and who holds them (F4). Platform authority is separate from every Company's authority. */
export function PlatformRoles() {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const { canPlatform } = useAuth();
  const canManage = canPlatform('platform.role.manage', 'editable');
  const [roles, setRoles] = useState<PlatformRole[]>([]);
  const [nodes, setNodes] = useState<PlatformNode[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userId, setUserId] = useState('');
  const [roleKey, setRoleKey] = useState('support_operations');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      const [r, n] = await Promise.all([api.get<PlatformRole[]>('/platform/roles'), api.get<PlatformNode[]>('/platform/nodes')]);
      setRoles(r);
      setNodes(n);
      try {
        setUsers(await api.get<AdminUser[]>('/admin/users'));
      } catch {
        setUsers([]);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function act(path: 'assign' | 'revoke') {
    setError(null);
    setNotice(null);
    try {
      await api.post(`/admin/roles/${path}`, { userId, roleKey });
      setNotice(path === 'assign' ? (ar ? 'تم إسناد الدور.' : 'Role assigned.') : ar ? 'تم سحب الدور.' : 'Role revoked.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    }
  }

  const titleOf = (n: string) => nodes.find((x) => x.node === n);
  return (
    <div>
      <div className="page-header">
        <h1>{ar ? 'أدوار المنصة' : 'Platform roles'}</h1>
      </div>
      <p style={{ color: '#6b7280', marginTop: 0 }}>
        {ar ? 'صلاحيات المنصة مستقلة تمامًا عن صلاحيات أي شركة: لا تمنح وصولًا إلى بيانات شركة، والعكس صحيح.' : 'Platform authority is entirely separate from any Company authority: it never grants access to a Company’s data, and a Company role never grants platform power.'}
      </p>
      {error && <div className="error-text" role="alert">{error}</div>}
      {notice && <div className="success-text">{notice}</div>}
      {roles.map((r) => (
        <div key={r.key} className="card" style={{ marginBottom: 12 }} data-testid={`prole-${r.key}`}>
          <h3 style={{ marginTop: 0 }}>{ar ? r.nameAr : r.nameEn} <small style={{ color: '#9ca3af', direction: 'ltr' }}>{r.key}</small> <span className="status-badge">{r.holders} {ar ? 'عضو' : 'holder(s)'}</span></h3>
          <div style={{ color: '#6b7280' }}>{ar ? r.descriptionAr : r.descriptionEn}</div>
          {Array.isArray(r.grants) ? (
            <div style={{ marginTop: 8 }}>
              {r.grants.map((g) => {
                const n = titleOf(g.node);
                return (
                  <span key={g.node} className="status-badge" style={{ marginInlineEnd: 4, background: n?.risk === 'platform-critical' ? '#fee2e2' : undefined }} title={g.node}>
                    {n ? (ar ? n.titleAr : n.titleEn) : g.node}{g.access === 'editable' ? '' : ' (view)'}
                  </span>
                );
              })}
            </div>
          ) : (
            <div style={{ marginTop: 8, color: '#6b7280' }}>{ar ? 'كل صلاحيات المنصة (مرادف مدير المنصة الأعلى).' : 'Every platform capability (alias of Platform Super Admin).'}</div>
          )}
        </div>
      ))}
      {canPlatform('platform.role.assign', 'editable') && (
        <div className="card" style={{ marginTop: 20 }}>
          <h3 style={{ marginTop: 0 }}>{ar ? 'إسناد / سحب دور منصة' : 'Assign / revoke a platform role'}</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <select value={userId} onChange={(e) => setUserId(e.target.value)} data-testid="prole-user">
                <option value="">—</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.fullName} ({u.roles.join(', ') || '—'})</option>)}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)} data-testid="prole-role">
                {roles.filter((r) => r.key !== 'admin' || canManage).map((r) => <option key={r.key} value={r.key}>{ar ? r.nameAr : r.nameEn}</option>)}
              </select>
            </div>
            <button className="btn btn-primary" disabled={!userId} onClick={() => act('assign')}>{ar ? 'إسناد' : 'Assign'}</button>
            <button className="btn btn-secondary" disabled={!userId} onClick={() => act('revoke')}>{ar ? 'سحب' : 'Revoke'}</button>
          </div>
          {!canManage && <p style={{ color: '#92400e' }}>{ar ? 'إسناد أدوار المنصة يحتاج صلاحية إدارة أدوار المنصة.' : 'Assigning platform roles needs the platform-role management capability.'}</p>}
        </div>
      )}
    </div>
  );
}
