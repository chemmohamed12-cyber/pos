import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

interface OrgUnit {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
}
interface AdminUser {
  id: string;
  fullName: string;
}

const UNIT_TYPES = ['company', 'branch', 'department', 'team', 'warehouse'];

export function Organization() {
  const { hasRole } = useAuth();
  const { t, preload } = useLanguage();
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [members, setMembers] = useState<Record<string, string[]>>({});
  const [type, setType] = useState('branch');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [memberSelections, setMemberSelections] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.organization',
    'field.name',
    'field.parent',
    'unit_type.company',
    'unit_type.branch',
    'unit_type.department',
    'unit_type.team',
    'unit_type.warehouse',
    'panel.no_org_units_yet',
    'panel.members',
    'action.create',
    'action.assign',
  ]);

  async function load() {
    try {
      const unitsData = await api.get<OrgUnit[]>('/organization/units');
      setUnits(unitsData);
      const memberEntries = await Promise.all(unitsData.map(async (u) => [u.id, await api.get<string[]>(`/organization/units/${u.id}/members`)] as const));
      setMembers(Object.fromEntries(memberEntries));
      if (hasRole('admin')) {
        const usersData = await api.get<AdminUser[]>('/admin/users');
        setUsers(usersData);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load organization units.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/organization/units', { type, name, parentId: parentId || undefined });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create unit.');
    } finally {
      setCreating(false);
    }
  }

  async function assignMember(unitId: string) {
    const userId = memberSelections[unitId];
    if (!userId) return;
    setError(null);
    try {
      await api.post(`/organization/units/${unitId}/members`, { userId });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign member.');
    }
  }

  const unitName = (id: string | null) => (id ? units.find((u) => u.id === id)?.name ?? id : '—');
  const userName = (id: string) => users.find((u) => u.id === id)?.fullName ?? id;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.organization')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      {hasRole('admin') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>Type</label>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {UNIT_TYPES.map((ut) => (
                  <option key={ut} value={ut}>
                    {t(`unit_type.${ut}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.name')}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.parent')}</label>
              <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">—</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary" type="submit" disabled={creating}>
              {t('action.create')}
            </button>
          </form>
        </div>
      )}

      {units.length === 0 ? (
        <div className="empty-state">{t('panel.no_org_units_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>{t('field.name')}</th>
              <th>{t('field.parent')}</th>
              <th>{t('panel.members')}</th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.id}>
                <td>{t(`unit_type.${u.type}`)}</td>
                <td>{u.name}</td>
                <td>{unitName(u.parentId)}</td>
                <td>
                  <div style={{ marginBottom: 6 }}>
                    {(members[u.id] ?? []).map((uid) => (
                      <span key={uid} className="status-badge" style={{ marginInlineEnd: 4 }}>
                        {hasRole('admin') ? userName(uid) : uid}
                      </span>
                    ))}
                    {(members[u.id] ?? []).length === 0 && <span style={{ color: '#9ca3af', fontSize: '0.85rem' }}>—</span>}
                  </div>
                  {hasRole('admin') && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select
                        value={memberSelections[u.id] ?? ''}
                        onChange={(e) => setMemberSelections((prev) => ({ ...prev, [u.id]: e.target.value }))}
                      >
                        <option value="">—</option>
                        {users.map((usr) => (
                          <option key={usr.id} value={usr.id}>
                            {usr.fullName}
                          </option>
                        ))}
                      </select>
                      <button className="btn btn-secondary" disabled={!memberSelections[u.id]} onClick={() => assignMember(u.id)}>
                        {t('action.assign')}
                      </button>
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
