import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { currentLang, nameOf, ORG_UNIT_TYPES } from '../lib/displayNames';

interface OrgUnit {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
  status?: 'active' | 'archived';
}
interface AdminUser {
  id: string;
  fullName: string;
}
interface Impact {
  unit: OrgUnit;
  activeChildren: number;
  members: number;
  grants: number;
  blocking: Array<{ table: string; labelEn: string; labelAr: string; count: number }>;
  historical: Array<{ table: string; count: number }>;
  canArchive: boolean;
  reasons: string[];
}

/** Which parent types a unit type may sit under — mirrors the server's matrix (the server is authoritative and re-validates). The "warehouse" type is no longer offered. */
const PARENT_TYPES: Record<string, readonly string[]> = {
  company: [],
  branch: ['company'],
  department: ['company', 'branch', 'department'],
  team: ['company', 'branch', 'department', 'team'],
  warehouse: ['company', 'branch'],
};
const CREATABLE_TYPES = ['company', 'branch', 'department', 'team'];

export function Organization() {
  const { can, canPlatform } = useAuth();
  const { t, preload } = useLanguage();
  const ar = currentLang() === 'ar';
  const tr = (a: string, e: string) => (ar ? a : e);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [members, setMembers] = useState<Record<string, string[]>>({});
  const [type, setType] = useState('branch');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [memberSelections, setMemberSelections] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; parentId: string } | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = can('core.company.organization.manage', 'editable');

  preload([
    'nav.organization',
    'field.name',
    'field.parent',
    'panel.no_org_units_yet',
    'panel.members',
    'action.create',
    'action.assign',
    'action.save',
    'action.cancel',
  ]);

  async function load() {
    try {
      const unitsData = await api.get<OrgUnit[]>('/organization/units');
      setUnits(unitsData);
      const memberEntries = await Promise.all(unitsData.map(async (u) => [u.id, await api.get<string[]>(`/organization/units/${u.id}/members`)] as const));
      setMembers(Object.fromEntries(memberEntries));
      if (canPlatform('platform.user.view')) {
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

  const isActive = (u: OrgUnit) => (u.status ?? 'active') === 'active';
  const activeRoot = units.find((u) => u.type === 'company' && !u.parentId && isActive(u));
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, OrgUnit[]>();
    for (const u of units) {
      const key = u.parentId && units.some((p) => p.id === u.parentId) ? u.parentId : null;
      map.set(key, [...(map.get(key) ?? []), u]);
    }
    return map;
  }, [units]);

  /** Depth-first tree order with indentation depth; archived units appear only when asked for. */
  const rows = useMemo(() => {
    const out: Array<{ unit: OrgUnit; depth: number }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const u of childrenOf.get(parent) ?? []) {
        if (!showArchived && !isActive(u)) continue;
        out.push({ unit: u, depth });
        walk(u.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childrenOf, showArchived]);

  const descendantsOf = (id: string): Set<string> => {
    const found = new Set<string>();
    const walk = (p: string) => {
      for (const c of childrenOf.get(p) ?? []) {
        found.add(c.id);
        walk(c.id);
      }
    };
    walk(id);
    return found;
  };

  const parentChoices = (unitType: string, excludeId?: string) => {
    const blocked = excludeId ? new Set([excludeId, ...descendantsOf(excludeId)]) : new Set<string>();
    return units.filter((u) => isActive(u) && !blocked.has(u.id) && PARENT_TYPES[unitType]?.includes(u.type));
  };

  // a new unit defaults under the Company root when its type may sit there
  useEffect(() => {
    if (!parentId && activeRoot && PARENT_TYPES[type]?.includes('company') && type !== 'company') setParentId(activeRoot.id);
    if (type === 'company') setParentId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, activeRoot?.id]);

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

  async function onSaveEdit() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const current = units.find((u) => u.id === editing.id);
      const body: { name?: string; parentId?: string | null } = { name: editing.name };
      if (current && (current.parentId ?? '') !== editing.parentId) body.parentId = editing.parentId || null;
      await api.patch(`/organization/units/${editing.id}`, body);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setBusy(false);
    }
  }

  async function openArchive(id: string) {
    setError(null);
    try {
      setImpact(await api.get<Impact>(`/organization/units/${id}/impact`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to read the impact.');
    }
  }

  async function confirmArchive() {
    if (!impact) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/organization/units/${impact.unit.id}/archive`, { confirm: true });
      setImpact(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to archive.');
    } finally {
      setBusy(false);
    }
  }

  async function reactivate(id: string) {
    setError(null);
    try {
      await api.post(`/organization/units/${id}/activate`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reactivate.');
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

  const userName = (id: string) => users.find((u) => u.id === id)?.fullName ?? id;
  const typeName = (ty: string) => nameOf(ORG_UNIT_TYPES, ty, ar ? 'ar' : 'en');
  const creatableTypes = CREATABLE_TYPES.filter((ty) => ty !== 'company' || !activeRoot);
  const createParents = parentChoices(type);

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.organization')}</h1>
        <Link className="btn btn-secondary" to="/organization/report">
          {tr('التقرير التنظيمي', 'Organizational report')}
        </Link>
        <label style={{ fontSize: '0.9rem' }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {tr('عرض المؤرشف', 'Show archived')}
        </label>
      </div>

      {error && <div className="error-text">{error}</div>}

      {canManage && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{tr('النوع', 'Type')}</label>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {creatableTypes.map((ut) => (
                  <option key={ut} value={ut}>
                    {typeName(ut)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.name')}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            {type !== 'company' && (
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.parent')}</label>
                <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">—</option>
                  {createParents.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({typeName(u.type)})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button className="btn btn-primary" type="submit" disabled={creating}>
              {t('action.create')}
            </button>
          </form>
        </div>
      )}

      {editing && (
        <div className="card" style={{ marginBottom: 20, borderInlineStart: '4px solid #2563eb' }} data-testid="org-edit">
          <h3 style={{ marginTop: 0 }}>{tr('تعديل وحدة', 'Edit unit')}</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.name')}</label>
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            {units.find((u) => u.id === editing.id)?.type !== 'company' && (
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{tr('نقل تحت', 'Move under')}</label>
                <select value={editing.parentId} onChange={(e) => setEditing({ ...editing, parentId: e.target.value })}>
                  <option value="">—</option>
                  {parentChoices(units.find((u) => u.id === editing.id)?.type ?? 'department', editing.id).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({typeName(u.type)})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button className="btn btn-primary" disabled={busy || !editing.name.trim()} onClick={onSaveEdit}>
              {t('action.save')}
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(null)}>
              {t('action.cancel')}
            </button>
          </div>
        </div>
      )}

      {impact && (
        <div className="card" style={{ marginBottom: 20, borderInlineStart: `4px solid ${impact.canArchive ? '#d97706' : '#dc2626'}` }} data-testid="org-archive-impact">
          <h3 style={{ marginTop: 0 }}>
            {tr('أرشفة', 'Archive')} «{impact.unit.name}»
          </h3>
          <p style={{ margin: '4px 0' }}>
            {tr('لن يتم حذف أي شيء. تبقى المستندات التاريخية كما هي، ولا تقبل الوحدة المؤرشفة سجلات جديدة.', 'Nothing is deleted. Historical documents stay as they are, and an archived unit accepts no new records.')}
          </p>
          <ul style={{ margin: '8px 0', paddingInlineStart: 20 }}>
            <li>
              {tr('وحدات فرعية فعّالة', 'Active sub-units')}: {impact.activeChildren}
            </li>
            <li>
              {tr('أعضاء مرتبطون', 'Members')}: {impact.members} · {tr('صلاحيات نطاق صريحة', 'Explicit scope grants')}: {impact.grants}
            </li>
            {impact.blocking.map((b) => (
              <li key={b.table} style={{ color: '#b91c1c' }}>
                {ar ? b.labelAr : b.labelEn}: {b.count}
              </li>
            ))}
            {impact.historical.length > 0 && (
              <li>
                {tr('مستندات تاريخية تشير إليها (تبقى صحيحة)', 'Historical records referencing it (stay valid)')}: {impact.historical.map((h) => `${h.table} ${h.count}`).join(' · ')}
              </li>
            )}
          </ul>
          {!impact.canArchive && <div className="error-text">{impact.reasons.join(' ')}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={busy || !impact.canArchive} onClick={confirmArchive}>
              {tr('تأكيد الأرشفة', 'Confirm archive')}
            </button>
            <button className="btn btn-secondary" onClick={() => setImpact(null)}>
              {t('action.cancel')}
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_org_units_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{tr('النوع', 'Type')}</th>
              <th>{t('field.name')}</th>
              <th>{tr('الحالة', 'Status')}</th>
              <th>{t('panel.members')}</th>
              {canManage && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ unit: u, depth }) => (
              <tr key={u.id} style={isActive(u) ? undefined : { opacity: 0.6 }}>
                <td>{typeName(u.type)}</td>
                <td style={{ paddingInlineStart: 12 + depth * 20 }}>{u.name}</td>
                <td>
                  <span className="status-badge">{isActive(u) ? tr('فعّال', 'Active') : tr('مؤرشف', 'Archived')}</span>
                </td>
                <td>
                  <div style={{ marginBottom: 6 }}>
                    {(members[u.id] ?? []).map((uid) => (
                      <span key={uid} className="status-badge" style={{ marginInlineEnd: 4 }}>
                        {canPlatform('platform.user.view') ? userName(uid) : uid}
                      </span>
                    ))}
                    {(members[u.id] ?? []).length === 0 && <span style={{ color: '#9ca3af', fontSize: '0.85rem' }}>—</span>}
                  </div>
                  {canManage && isActive(u) && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select value={memberSelections[u.id] ?? ''} onChange={(e) => setMemberSelections((prev) => ({ ...prev, [u.id]: e.target.value }))}>
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
                {canManage && (
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {isActive(u) ? (
                      <>
                        <button className="btn btn-secondary" onClick={() => setEditing({ id: u.id, name: u.name, parentId: u.parentId ?? '' })}>
                          {tr('تعديل', 'Edit')}
                        </button>{' '}
                        <button className="btn btn-secondary" onClick={() => openArchive(u.id)}>
                          {tr('أرشفة', 'Archive')}
                        </button>
                      </>
                    ) : (
                      <button className="btn btn-secondary" onClick={() => reactivate(u.id)}>
                        {tr('إعادة تفعيل', 'Reactivate')}
                      </button>
                    )}
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
