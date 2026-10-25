import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { BlockedReason, FormField } from '../../components/mfg';

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
export function NewProcessOrder({ canReadProcesses }: { canReadProcesses: boolean }) {
  const { t } = useLanguage();
  const nav = useNavigate();
  const [versions, setVersions] = useState<ActiveVersion[] | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [versionId, setVersionId] = useState('');
  const [groups, setGroups] = useState<Array<{ key: string; op: string; group: string; options: Array<{ id: string; sku: string | null }> }>>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [qty, setQty] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [vs, wh] = await Promise.all([canReadProcesses ? api.get<ActiveVersion[]>('/manufacturing/processes') : Promise.resolve([]), api.get<Warehouse[]>('/inventory/warehouses')]);
        setVersions(vs.filter((v) => v.status === 'active'));
        setWarehouses(wh.filter((w) => w.kind !== 'operational'));
      } catch (err) {
        setVersions([]);
        setError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
      }
    })();
  }, [canReadProcesses, t]);

  async function pick(id: string) {
    setVersionId(id);
    setChoices({});
    setGroups([]);
    if (!id) return;
    try {
      const d = await api.get<VersionDetail>(`/manufacturing/processes/${id}`);
      const by = new Map<string, { op: string; group: string; options: Array<{ id: string; sku: string | null }> }>();
      for (const i of d.inputs) {
        if (!i.alternateGroup) continue;
        const key = `${i.operationCode}|${i.alternateGroup}`;
        const g = by.get(key) ?? { op: i.operationCode, group: i.alternateGroup, options: [] };
        g.options.push({ id: i.componentProductId, sku: i.componentSku });
        by.set(key, g);
      }
      setGroups([...by.entries()].map(([key, g]) => ({ key, ...g })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
    }
  }

  const v = versions?.find((x) => x.id === versionId);
  const qtyNum = Number(qty);
  const qtyError = qty.trim() !== '' && (!Number.isInteger(qtyNum) || qtyNum < 1) ? t('mfg2.qa.qty_invalid') : null;
  const missing = groups.filter((g) => !choices[g.key]);
  const ready = !!v && qtyNum > 0 && !qtyError && !!warehouseId && missing.length === 0;

  async function create() {
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const wo = await api.post<{ id: string }>('/manufacturing/process-orders', { finishedProductId: v.productId, quantityPlanned: qtyNum, warehouseId, alternateChoices: choices });
      nav(`/manufacturing/work-orders/${wo.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    } finally {
      setBusy(false);
    }
  }

  if (versions === null) return <div className="mfg-note">{t('mfg2.common.loading')}</div>;
  if (versions.length === 0) {
    return (
      <BlockedReason to={canReadProcesses ? '/manufacturing/processes' : undefined} linkText={canReadProcesses ? t('nav.manufacturing_processes') : undefined}>
        {t('mfg2.wo.no_active_process')}
      </BlockedReason>
    );
  }
  return (
    <div data-testid="new-process-order">
      <p className="mfg-note" style={{ marginBlockStart: 0 }}>
        {t('mfg2.wo.ms.help')}
      </p>
      {error && <BlockedReason danger>{error}</BlockedReason>}
      <div className="mfg-grid cols-3">
        <FormField label={t('mfg2.wo.ms.process')} hint={t('mfg2.wo.ms.process_hint')} required>
          {(p) => (
            <select {...p} value={versionId} onChange={(e) => void pick(e.target.value)} data-testid="npo-version">
              <option value="">{t('mfg2.common.choose')}</option>
              {versions.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.productSku} — {x.productName} (v{x.versionNo})
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label={t('field.quantity_planned')} hint={t('mfg2.qa.qty_hint')} error={qtyError} required>
          {(p) => <input {...p} type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} data-testid="npo-qty" />}
        </FormField>
        <FormField label={t('field.warehouse')} hint={t('mfg2.qa.warehouse_hint')} required>
          {(p) => (
            <select {...p} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} data-testid="npo-wh">
              <option value="">{t('mfg2.common.choose')}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </div>
      {groups.length > 0 && (
        <fieldset className="mfg-fieldset">
          <legend>{t('mfg2.wo.ms.alternatives')}</legend>
          <p className="mfg-note" style={{ marginBlockStart: 0 }}>
            {t('mfg2.wo.ms.alternatives_help')}
          </p>
          <div className="mfg-grid cols-3">
            {groups.map((g) => (
              <FormField key={g.key} label={`${g.op} / ${g.group}`} required>
                {(p) => (
                  <select {...p} value={choices[g.key] ?? ''} onChange={(e) => setChoices((c) => ({ ...c, [g.key]: e.target.value }))} data-testid={`npo-choice-${g.key}`}>
                    <option value="">{t('mfg2.common.choose')}</option>
                    {g.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.sku}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            ))}
          </div>
        </fieldset>
      )}
      <div className="mfg-actions">
        <button className="btn btn-primary" type="button" disabled={!ready || busy} aria-busy={busy} onClick={create} data-testid="npo-create">
          {t('mfg2.wo.ms.create')}
        </button>
        {!ready && <span className="mfg-note">{!v ? t('mfg2.wo.ms.need_process') : missing.length > 0 ? t('mfg2.wo.ms.need_choices') : t('mfg2.wo.need_fields')}</span>}
        {canReadProcesses && v && (
          <Link to="/manufacturing/processes" className="mfg-note">
            {t('nav.manufacturing_processes')}
          </Link>
        )}
      </div>
    </div>
  );
}
