import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

interface Unit {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
}
interface Grant {
  orgUnitId: string;
  includeDescendants: boolean;
  unitName?: string | null;
  unitType?: string | null;
}
interface WarehouseRef {
  id: string;
  code: string;
  name: string;
}
interface Effective {
  unrestricted: boolean;
  units: Array<{ id: string; name: string; type: string }>;
  warehouses: { visible: WarehouseRef[]; hidden: WarehouseRef[] } | null;
}
interface Decision {
  allowed: boolean;
  refusedBy: 'permission' | 'scope' | null;
}

/**
 * Authorization Foundation F6 — a member's ACCESS SCOPE (which organization units / warehouses they can work with) and the Effective Access Preview.
 * Permission says WHAT a person may do; scope says WHERE. The server decides everything (a grant outside the actor's own scope is refused, and every pilot route re-checks);
 * this panel only edits the grants and shows what the server resolved.
 */
export function AccessScopePanel({ userId, name, ar, canWrite, onClose }: { userId: string; name: string; ar: boolean; canWrite: boolean; onClose: () => void }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [addUnit, setAddUnit] = useState('');
  const [addDesc, setAddDesc] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [probeNode, setProbeNode] = useState('inventory.warehouse.edit');
  const [probeWh, setProbeWh] = useState('');
  const [decision, setDecision] = useState<Decision | null>(null);

  async function load() {
    try {
      const [u, s] = await Promise.all([api.get<Unit[]>('/organization/units'), api.get<{ grants: Grant[]; effective: Effective }>(`/company/users/${userId}/scopes`)]);
      setUnits(u);
      setGrants(s.grants.map((g) => ({ orgUnitId: g.orgUnitId, includeDescendants: g.includeDescendants, unitName: g.unitName, unitType: g.unitType })));
      setEffective(s.effective);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : ar ? 'تعذّر تحميل النطاق.' : 'Could not load the scope.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const unitName = (id: string) => units.find((u) => u.id === id)?.name ?? id;

  async function save(next: Grant[]) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.put(`/company/users/${userId}/scopes`, { grants: next.map((g) => ({ orgUnitId: g.orgUnitId, includeDescendants: g.includeDescendants })) });
      setNotice(ar ? 'تم حفظ النطاق.' : 'Scope saved.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? (ar ? 'هذه الوحدة خارج نطاقك أنت.' : 'That unit is outside your own scope.') : err instanceof ApiError ? err.message : ar ? 'تعذّر الحفظ.' : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function probe() {
    try {
      const q = new URLSearchParams({ node: probeNode, level: 'editable' });
      if (probeWh) q.set('warehouseId', probeWh);
      const res = await api.get<{ decision?: Decision }>(`/company/users/${userId}/effective-access?${q.toString()}`);
      setDecision(res.decision ?? null);
    } catch {
      setDecision(null);
    }
  }

  const available = units.filter((u) => !grants.some((g) => g.orgUnitId === u.id));
  const allWarehouses = [...(effective?.warehouses?.visible ?? []), ...(effective?.warehouses?.hidden ?? [])];

  return (
    <div className="card" style={{ marginTop: 16 }} data-testid="access-scope-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{ar ? `نطاق الوصول — ${name}` : `Access scope — ${name}`}</h3>
        <button className="btn btn-secondary" onClick={onClose}>{ar ? 'إغلاق' : 'Close'}</button>
      </div>
      <p style={{ color: '#6b7280' }}>
        {ar
          ? 'الصلاحية تحدّد ماذا يفعل الشخص، والنطاق يحدّد أين: أي الفروع والمخازن التي يعمل عليها. المخزن غير المرتبط بوحدة تنظيمية يراه الجميع.'
          : 'Permission says what a person may do; scope says where — which branches and warehouses they work with. A warehouse that is not linked to an organization unit is visible to everyone.'}
      </p>
      {error && <div className="error-text" role="alert">{error}</div>}
      {notice && <div className="success-text">{notice}</div>}

      <h4>{ar ? 'المنح الصريحة' : 'Explicit grants'}</h4>
      {grants.length === 0 ? (
        <div className="empty-state">{ar ? 'لا منح صريحة (يسري ما ينتمي إليه الشخص تنظيميًا فقط).' : 'No explicit grants (only the units the person belongs to apply).'}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{ar ? 'الوحدة' : 'Unit'}</th>
              <th>{ar ? 'تشمل الوحدات التابعة' : 'Includes sub-units'}</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.orgUnitId}>
                <td>{g.unitName ?? unitName(g.orgUnitId)} <span style={{ color: '#9ca3af' }}>({g.unitType ?? units.find((u) => u.id === g.orgUnitId)?.type})</span></td>
                <td>{g.includeDescendants ? (ar ? 'نعم' : 'Yes') : ar ? 'لا' : 'No'}</td>
                {canWrite && (
                  <td>
                    <button className="btn btn-secondary" disabled={busy} onClick={() => save(grants.filter((x) => x.orgUnitId !== g.orgUnitId))}>{ar ? 'إزالة' : 'Remove'}</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canWrite && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10 }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{ar ? 'إضافة وحدة' : 'Add a unit'}</label>
            <select value={addUnit} onChange={(e) => setAddUnit(e.target.value)}>
              <option value="">{ar ? '— اختر —' : '— choose —'}</option>
              {available.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.type})</option>
              ))}
            </select>
          </div>
          <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={addDesc} onChange={(e) => setAddDesc(e.target.checked)} />
            {ar ? 'تشمل الوحدات التابعة' : 'Include sub-units'}
          </label>
          <button className="btn btn-primary" disabled={busy || !addUnit} onClick={async () => { await save([...grants, { orgUnitId: addUnit, includeDescendants: addDesc }]); setAddUnit(''); }}>
            {ar ? 'إضافة' : 'Add'}
          </button>
        </div>
      )}

      <h4 style={{ marginTop: 20 }}>{ar ? 'ما يصل إليه فعليًا (معاينة الوصول الفعلي)' : 'What they can actually reach (effective access preview)'}</h4>
      {effective?.unrestricted ? (
        <div>{ar ? 'بلا قيود — كل الوحدات والمخازن.' : 'Unrestricted — every unit and warehouse.'}</div>
      ) : (
        <>
          <div>{ar ? 'الوحدات:' : 'Units:'} {effective?.units.length ? effective.units.map((u) => <span key={u.id} className="status-badge" style={{ marginInlineEnd: 4 }}>{u.name}</span>) : <span style={{ color: '#9ca3af' }}>—</span>}</div>
          {effective?.warehouses && (
            <div style={{ marginTop: 6 }}>
              <div>{ar ? 'مخازن يراها:' : 'Warehouses they see:'} {effective.warehouses.visible.length ? effective.warehouses.visible.map((w) => <span key={w.id} className="status-badge positive" style={{ marginInlineEnd: 4 }}>{w.code}</span>) : <span style={{ color: '#9ca3af' }}>—</span>}</div>
              <div>{ar ? 'مخازن لا يراها:' : 'Warehouses hidden from them:'} {effective.warehouses.hidden.length ? effective.warehouses.hidden.map((w) => <span key={w.id} className="status-badge" style={{ marginInlineEnd: 4 }}>{w.code}</span>) : <span style={{ color: '#9ca3af' }}>—</span>}</div>
            </div>
          )}
        </>
      )}

      <h4 style={{ marginTop: 20 }}>{ar ? 'اسأل: هل يستطيع؟' : 'Ask: can they?'}</h4>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{ar ? 'الصلاحية (تعديل)' : 'Permission (edit)'}</label>
          <input value={probeNode} onChange={(e) => setProbeNode(e.target.value)} style={{ direction: 'ltr' }} />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{ar ? 'المخزن' : 'Warehouse'}</label>
          <select value={probeWh} onChange={(e) => setProbeWh(e.target.value)}>
            <option value="">{ar ? '— بدون —' : '— none —'}</option>
            {allWarehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code}</option>
            ))}
          </select>
        </div>
        <button className="btn btn-secondary" onClick={probe}>{ar ? 'معاينة' : 'Preview'}</button>
        {decision && (
          <span className={decision.allowed ? 'status-badge positive' : 'status-badge'} data-testid="scope-decision">
            {decision.allowed ? (ar ? 'مسموح' : 'Allowed') : decision.refusedBy === 'scope' ? (ar ? 'مرفوض — خارج النطاق' : 'Refused — outside the scope') : ar ? 'مرفوض — لا يملك الصلاحية' : 'Refused — permission not held'}
          </span>
        )}
      </div>
    </div>
  );
}
