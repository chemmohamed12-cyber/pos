import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

type Level = 'hidden' | 'read-only' | 'editable';
interface RoleRow {
  id: string;
  key: string;
  type: 'system' | 'template' | 'custom' | 'legacy';
  titleCode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  isActive: boolean;
  templateKey: string | null;
  templateVersion: number | null;
  customized: boolean | null;
  memberCount: number;
  grantCount: number;
  criticalNodes: string[];
  templateUpdateAvailable: boolean;
}
interface GrantRow {
  node: string;
  access: Level;
  titleEn: string;
  titleAr: string;
  risk: 'low' | 'sensitive' | 'critical';
  module: string | null;
  dormant: boolean;
}
interface CatalogNode {
  node: string;
  module: string | null;
  resource: string | null;
  scope: 'module' | 'resource' | 'action';
  risk: 'low' | 'sensitive' | 'critical';
  titleEn: string;
  titleAr: string;
}
interface TemplateRow {
  key: string;
  module: string;
  version: number;
  entitled: boolean;
  instantiated: boolean;
  criticalNodes: string[];
}
interface TemplateDiff {
  fromVersion: number;
  toVersion: number;
  customized: boolean;
  added: Array<{ node: string; access: string }>;
  changed: Array<{ node: string; from: string; to: string }>;
  removedFromTemplate: Array<{ node: string; access: string }>;
  introducesCritical: string[];
}

const NODE = 'core.company.roles.manage';
const TYPE_LABEL: Record<string, [string, string]> = { system: ['نظام', 'System'], template: ['قالب', 'Template'], custom: ['مخصّص', 'Custom'], legacy: ['قديم', 'Legacy'] };

function explain(err: unknown, ar: boolean): string {
  if (!(err instanceof ApiError)) return ar ? 'تعذّر تنفيذ العملية.' : 'The operation failed.';
  const m: Record<string, [string, string]> = {
    ROLE_PROTECTED: ['أدوار النظام والأدوار القديمة محمية ولا يمكن تعديلها أو حذفها.', 'System and legacy roles are protected and cannot be edited or deleted.'],
    ROLE_IN_USE: ['الدور مُسند لأعضاء؛ أزله منهم أولًا.', 'The role is held by members; remove it from them first.'],
    ROLE_EXISTS: ['يوجد دور بنفس المفتاح بالفعل.', 'A role with this key already exists.'],
    ROLE_CUSTOMIZED: ['تم تخصيص هذا الدور؛ تحديثات القالب للاطلاع فقط.', 'This role was customised; template updates are informational only.'],
    NODE_NOT_ENTITLED: ['هذه الصلاحية تتبع وحدة غير مشمولة بباقة الشركة.', 'That permission belongs to a module outside the Company package.'],
    ROLE_EXCEEDS_GRANTOR: ['الصلاحيات الحرجة لا يمنحها إلا من يملكها صراحةً.', 'Critical permissions can only be granted by someone who holds them explicitly.'],
    ADMINISTRATION_WOULD_BE_LOST: ['هذا التعديل سيترك الشركة بلا عضو نشط يستطيع إدارة المستخدمين والأدوار.', 'This change would leave the Company with no active member who can manage users and roles.'],
    INVALID_INPUT: ['بيانات غير صحيحة.', 'Invalid input.'],
    ROLE_NOT_FOUND: ['الدور غير موجود.', 'Role not found.'],
  };
  const hit = m[err.code];
  return hit ? (ar ? hit[0] : hit[1]) : err.message;
}

export function CompanyRoles() {
  const { lang, t, preload } = useLanguage();
  const ar = lang === 'ar';
  const { can, companyContext } = useAuth();
  const canWrite = can(NODE, 'editable');
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ nameEn: string; nameAr: string; descriptionEn: string; descriptionAr: string; isActive: boolean; levels: Record<string, Level>; dormant: GrantRow[] } | null>(null);
  const [diff, setDiff] = useState<TemplateDiff | null>(null);
  const [newName, setNewName] = useState('');

  async function load() {
    try {
      const [r, t, c] = await Promise.all([api.get<RoleRow[]>('/company/roles'), api.get<TemplateRow[]>('/company/roles/templates'), api.get<CatalogNode[]>('/company/roles/catalog')]);
      setRoles(r);
      setTemplates(t);
      setCatalog(c);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? (ar ? 'ليست لديك صلاحية إدارة أدوار الشركة.' : 'You do not have permission to manage Company roles.') : explain(err, ar));
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyContext?.companyId]);
  useEffect(() => {
    const codes = roles.map((r) => r.titleCode).filter((c): c is string => !!c);
    if (codes.length) preload(codes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles]);

  async function run(action: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (ok) setNotice(ok);
      await load();
    } catch (err) {
      setError(explain(err, ar));
    } finally {
      setBusy(false);
    }
  }

  const label = (r: RoleRow) => {
    const named = ar ? r.nameAr ?? r.nameEn : r.nameEn ?? r.nameAr;
    return named ?? (r.titleCode && t(r.titleCode) !== r.titleCode ? t(r.titleCode) : r.key);
  };

  async function openEditor(r: RoleRow) {
    setError(null);
    setNotice(null);
    setDiff(null);
    try {
      const d = await api.get<{ role: RoleRow; grants: GrantRow[] }>(`/company/roles/${r.id}`);
      const levels: Record<string, Level> = {};
      for (const g of d.grants) if (!g.dormant) levels[g.node] = g.access;
      setDraft({ nameEn: r.nameEn ?? '', nameAr: r.nameAr ?? '', descriptionEn: r.descriptionEn ?? '', descriptionAr: r.descriptionAr ?? '', isActive: r.isActive, levels, dormant: d.grants.filter((g) => g.dormant) });
      setEditingId(r.id);
      if (r.templateUpdateAvailable) setDiff(await api.get<TemplateDiff | null>(`/company/roles/${r.id}/template-update`));
    } catch (err) {
      setError(explain(err, ar));
    }
  }

  const byModule = useMemo(() => {
    const m = new Map<string, CatalogNode[]>();
    for (const c of catalog) m.set(c.module ?? 'core', [...(m.get(c.module ?? 'core') ?? []), c]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog]);

  async function save(r: RoleRow) {
    if (!draft) return;
    const grants = [
      ...Object.entries(draft.levels).filter(([, l]) => l !== 'hidden').map(([node, access]) => ({ node, access })),
      ...draft.dormant.map((g) => ({ node: g.node, access: g.access })),
    ];
    await run(async () => {
      const res = await api.put<{ autoAdded: string[] }>(`/company/roles/${r.id}`, {
        nameEn: draft.nameEn,
        nameAr: draft.nameAr,
        descriptionEn: draft.descriptionEn,
        descriptionAr: draft.descriptionAr,
        isActive: draft.isActive,
        ...(r.type === 'template' || r.type === 'custom' ? { grants } : {}),
      });
      if (res.autoAdded?.length) setNotice(ar ? `أُضيفت صلاحيات العرض المطلوبة تلقائيًا (${res.autoAdded.length}).` : `Required view permissions were added automatically (${res.autoAdded.length}).`);
      setEditingId(null);
      setDraft(null);
    }, ar ? 'تم حفظ الدور.' : 'Role saved.');
  }

  const editable = (r: RoleRow) => r.type === 'template' || r.type === 'custom';

  return (
    <div>
      <div className="page-header">
        <h1>{ar ? 'أدوار الشركة' : 'Company roles'}</h1>
      </div>
      <p style={{ color: '#6b7280', marginTop: 0 }}>
        {ar ? 'الدور حزمة صلاحيات. العضو يمكن أن يحمل أكثر من دور وتُجمع صلاحياته. الصلاحيات الحرجة تُمنح فقط ممن يملكها صراحةً.' : 'A role is a bundle of permissions. A member can hold several roles; their permissions add up. Critical permissions are granted only by someone who holds them explicitly.'}
      </p>
      {error && <div className="error-text" role="alert">{error}</div>}
      {notice && <div className="success-text">{notice}</div>}

      {canWrite && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{ar ? 'إنشاء دور' : 'Create a role'}</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{ar ? 'اسم دور مخصّص' : 'Custom role name'}</label>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} data-testid="new-role-name" />
            </div>
            <button className="btn btn-primary" disabled={busy || !newName.trim()} onClick={() => run(async () => { await api.post('/company/roles', { nameEn: newName, nameAr: newName, grants: [] }); setNewName(''); }, ar ? 'تم إنشاء الدور (بلا صلاحيات بعد).' : 'Role created (no permissions yet).')}>
              {ar ? 'إنشاء' : 'Create'}
            </button>
          </div>
          <div style={{ marginTop: 14 }}>
            <b>{ar ? 'أو ابدأ من قالب:' : 'Or start from a template:'}</b>{' '}
            {templates.filter((t) => t.entitled && !t.instantiated).map((t) => (
              <button key={t.key} className="btn btn-secondary" style={{ margin: 3 }} disabled={busy} title={t.criticalNodes.length ? (ar ? 'يحتوي صلاحيات حرجة' : 'Contains critical permissions') : ''} onClick={() => run(() => api.post('/company/roles/from-template', { templateKey: t.key }), ar ? 'تم إنشاء الدور من القالب (غير مُسند لأحد).' : 'Role created from the template (assigned to no one).')}>
                {t.key}{t.criticalNodes.length ? ' ⚠' : ''}
              </button>
            ))}
            {templates.filter((t) => t.entitled && !t.instantiated).length === 0 && <span style={{ color: '#9ca3af' }}>{ar ? 'كل قوالب باقتك موجودة بالفعل.' : 'All templates of your package already exist.'}</span>}
          </div>
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>{ar ? 'الدور' : 'Role'}</th>
            <th>{ar ? 'النوع' : 'Type'}</th>
            <th>{ar ? 'الأعضاء' : 'Members'}</th>
            <th>{ar ? 'الصلاحيات' : 'Permissions'}</th>
            <th>{ar ? 'حرجة' : 'Critical'}</th>
            <th>{ar ? 'الحالة' : 'State'}</th>
            {canWrite && <th />}
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id} data-testid={`role-${r.key}`}>
              <td>
                <div>{label(r)}</div>
                <div style={{ color: '#9ca3af', fontSize: '0.8rem', direction: 'ltr', textAlign: 'start' }}>{r.key}</div>
              </td>
              <td><span className="status-badge">{TYPE_LABEL[r.type]?.[ar ? 0 : 1] ?? r.type}</span></td>
              <td>{r.memberCount}</td>
              <td>{r.grantCount}</td>
              <td>{r.criticalNodes.length ? <span className="status-badge" style={{ background: '#fee2e2', color: '#991b1b' }}>{r.criticalNodes.length}</span> : '—'}</td>
              <td>
                {!r.isActive && <span className="status-badge">{ar ? 'غير نشط' : 'Inactive'}</span>}{' '}
                {r.customized && <span className="status-badge">{ar ? 'مخصّص' : 'Customised'}</span>}{' '}
                {r.templateUpdateAvailable && <span className="status-badge" style={{ background: '#fef3c7', color: '#92400e' }}>{ar ? 'تحديث قالب متاح' : 'Template update'}</span>}
              </td>
              {canWrite && (
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-secondary" disabled={busy} onClick={() => openEditor(r)}>{editable(r) ? (ar ? 'تعديل' : 'Edit') : ar ? 'عرض' : 'View'}</button>{' '}
                  <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => api.post(`/company/roles/${r.id}/clone`, {}), ar ? 'تم نسخ الدور.' : 'Role cloned.')}>{ar ? 'نسخ' : 'Clone'}</button>{' '}
                  {editable(r) && (
                    <button className="btn btn-secondary" disabled={busy} onClick={() => { if (window.confirm(ar ? 'حذف هذا الدور؟' : 'Delete this role?')) run(() => api.delete(`/company/roles/${r.id}`), ar ? 'تم حذف الدور.' : 'Role deleted.'); }}>{ar ? 'حذف' : 'Delete'}</button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {editingId && draft && (() => {
        const r = roles.find((x) => x.id === editingId);
        if (!r) return null;
        const ro = !editable(r) || !canWrite;
        return (
          <div className="card" style={{ marginTop: 20 }} data-testid="role-editor">
            <h3 style={{ marginTop: 0 }}>{ar ? 'الدور: ' : 'Role: '}{label(r)} {ro && <small style={{ color: '#9ca3af' }}>({ar ? 'للعرض فقط' : 'read-only'})</small>}</h3>
            {diff && (
              <div style={{ padding: 10, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, marginBottom: 12 }}>
                <b>{ar ? `تحديث قالب متاح (v${diff.fromVersion} ← v${diff.toVersion})` : `Template update available (v${diff.fromVersion} → v${diff.toVersion})`}</b>
                <ul>
                  {diff.added.map((g) => <li key={g.node}>+ {g.node} ({g.access})</li>)}
                  {diff.changed.map((c) => <li key={c.node}>~ {c.node}: {c.from} → {c.to}</li>)}
                  {diff.removedFromTemplate.map((g) => <li key={g.node} style={{ color: '#6b7280' }}>− {g.node} {ar ? '(لن يُزال تلقائيًا)' : '(never removed automatically)'}</li>)}
                </ul>
                {diff.introducesCritical.length > 0 && <div className="error-text">{ar ? 'يضيف صلاحيات حرجة: ' : 'Introduces critical permissions: '}{diff.introducesCritical.join(', ')}</div>}
                {diff.customized ? <div>{ar ? 'الدور مخصّص — للاطلاع فقط.' : 'The role is customised — informational only.'}</div> : (
                  <>
                    <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => { await api.post(`/company/roles/${r.id}/template-update/apply`, { apply: 'all' }); setEditingId(null); setDraft(null); }, ar ? 'تم تطبيق التحديث.' : 'Update applied.')}>{ar ? 'تطبيق الكل' : 'Apply all'}</button>{' '}
                    <button className="btn btn-secondary" disabled={busy} onClick={() => run(async () => { await api.post(`/company/roles/${r.id}/template-update/ignore`, {}); setEditingId(null); setDraft(null); }, ar ? 'تم تجاهل التحديث.' : 'Update ignored.')}>{ar ? 'تجاهل' : 'Ignore'}</button>
                  </>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-field" style={{ marginBottom: 0 }}><label>{ar ? 'الاسم (عربي)' : 'Name (Arabic)'}</label><input disabled={ro} value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} /></div>
              <div className="form-field" style={{ marginBottom: 0 }}><label>{ar ? 'الاسم (إنجليزي)' : 'Name (English)'}</label><input disabled={ro} value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })} /></div>
              <label style={{ alignSelf: 'flex-end' }}><input type="checkbox" disabled={ro} checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> {ar ? 'نشط (يمكن إسناده)' : 'Active (assignable)'}</label>
            </div>
            {draft.dormant.length > 0 && (
              <p style={{ color: '#92400e' }}>{ar ? `${draft.dormant.length} صلاحية معطّلة لأن وحدتها خارج الباقة؛ تُحفظ وتعود بعودة الوحدة.` : `${draft.dormant.length} permission(s) are dormant because their module is not in the package; they are kept and return with the module.`}</p>
            )}
            {editable(r) && byModule.map(([module, nodes]) => (
              <details key={module} style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{module} <small style={{ color: '#9ca3af' }}>({nodes.filter((n) => (draft.levels[n.node] ?? 'hidden') !== 'hidden').length}/{nodes.length})</small></summary>
                <table className="data-table" style={{ marginTop: 6 }}>
                  <tbody>
                    {nodes.map((n) => (
                      <tr key={n.node} data-testid={`grant-${n.node}`}>
                        <td style={{ width: '55%' }}>
                          {ar ? n.titleAr : n.titleEn} {n.risk === 'critical' && <span className="status-badge" style={{ background: '#fee2e2', color: '#991b1b' }}>{ar ? 'حرجة' : 'Critical'}</span>}{n.risk === 'sensitive' && <span className="status-badge" style={{ background: '#fef3c7', color: '#92400e' }}>{ar ? 'حساسة' : 'Sensitive'}</span>}
                          <div style={{ color: '#9ca3af', fontSize: '0.75rem', direction: 'ltr', textAlign: 'start' }}>{n.node}</div>
                        </td>
                        <td>
                          <select disabled={ro} value={draft.levels[n.node] ?? 'hidden'} onChange={(e) => setDraft({ ...draft, levels: { ...draft.levels, [n.node]: e.target.value as Level } })}>
                            <option value="hidden">{ar ? 'لا شيء' : 'None'}</option>
                            <option value="read-only">{ar ? 'قراءة' : 'Read'}</option>
                            <option value="editable">{ar ? 'تنفيذ/تعديل' : 'Edit / act'}</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
            <div style={{ marginTop: 12 }}>
              {!ro && <button className="btn btn-primary" disabled={busy} onClick={() => save(r)}>{ar ? 'حفظ' : 'Save'}</button>}{' '}
              <button className="btn btn-secondary" onClick={() => { setEditingId(null); setDraft(null); setDiff(null); }}>{ar ? 'إغلاق' : 'Close'}</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
