import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface ActiveVersion {
  id: string;
  productId: string;
  versionNo: number;
  status: string;
  productSku: string | null;
  productName: string | null;
}
interface VersionDetail {
  inputs: Array<{ operationCode: string; componentProductId: string; componentSku: string | null; alternateGroup: string | null }>;
}
interface Warehouse {
  id: string;
  code: string;
  name: string;
  kind?: string;
}

/** Manufacturing Engine S4 - create a Work Order that runs a product's ACTIVE process version (one explicit choice per alternate group). */
export function NewProcessOrder() {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const nav = useNavigate();
  const [versions, setVersions] = useState<ActiveVersion[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [versionId, setVersionId] = useState('');
  const [groups, setGroups] = useState<Array<{ key: string; label: string; options: Array<{ id: string; sku: string | null }> }>>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [qty, setQty] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [vs, wh] = await Promise.all([api.get<ActiveVersion[]>('/manufacturing/processes'), api.get<Warehouse[]>('/inventory/warehouses')]);
        setVersions(vs.filter((v) => v.status === 'active'));
        setWarehouses(wh.filter((w) => w.kind !== 'operational'));
      } catch {
        /* the card simply stays empty when the process list is not readable */
      }
    })();
  }, []);

  async function pick(id: string) {
    setVersionId(id);
    setChoices({});
    setGroups([]);
    if (!id) return;
    try {
      const d = await api.get<VersionDetail>(`/manufacturing/processes/${id}`);
      const by = new Map<string, Array<{ id: string; sku: string | null }>>();
      for (const i of d.inputs) if (i.alternateGroup) (by.get(`${i.operationCode}|${i.alternateGroup}`) ?? by.set(`${i.operationCode}|${i.alternateGroup}`, []).get(`${i.operationCode}|${i.alternateGroup}`)!).push({ id: i.componentProductId, sku: i.componentSku });
      setGroups([...by.entries()].map(([key, options]) => ({ key, label: key.replace('|', ' / '), options })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    }
  }

  const v = versions.find((x) => x.id === versionId);
  const ready = !!v && Number(qty) > 0 && !!warehouseId && groups.every((g) => choices[g.key]);

  async function create() {
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const wo = await api.post<{ id: string }>('/manufacturing/process-orders', { finishedProductId: v.productId, quantityPlanned: Number(qty), warehouseId, alternateChoices: choices });
      nav(`/manufacturing/work-orders/${wo.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  if (versions.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="new-process-order">
      <h3 style={{ marginTop: 0 }}>{ar ? 'أمر تشغيل بعملية (إصدار عملية نشط)' : 'Process work order (active process version)'}</h3>
      {error && <div className="error-text">{error}</div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <select value={versionId} onChange={(e) => void pick(e.target.value)} data-testid="npo-version">
          <option value="">{ar ? 'اختر العملية' : 'Select process'}</option>
          {versions.map((x) => (
            <option key={x.id} value={x.id}>
              {x.productSku} — {x.productName} (v{x.versionNo})
            </option>
          ))}
        </select>
        <input type="number" min={1} placeholder={ar ? 'الكمية المخططة' : 'Planned quantity'} value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 140 }} data-testid="npo-qty" />
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} data-testid="npo-wh">
          <option value="">{ar ? 'المخزن' : 'Warehouse'}</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} — {w.name}
            </option>
          ))}
        </select>
        {groups.map((g) => (
          <label key={g.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {ar ? 'بديل' : 'Alternative'} {g.label}
            <select value={choices[g.key] ?? ''} onChange={(e) => setChoices((c) => ({ ...c, [g.key]: e.target.value }))} data-testid={`npo-choice-${g.key}`}>
              <option value="">—</option>
              {g.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.sku}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button className="btn btn-primary" type="button" disabled={!ready || busy} onClick={create} data-testid="npo-create">
          {ar ? 'إنشاء أمر العملية' : 'Create process order'}
        </button>
      </div>
    </div>
  );
}
