import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface Warehouse {
  id: string;
  code: string;
  name: string;
  /** 'operational' = a Work Order's WIP sub-warehouse (ADR-061 Option A) — never a place to assemble or plan into. */
  kind?: 'main' | 'operational';
}
interface BomListEntry {
  finishedProductId: string;
  sku: string;
  name: string;
  status: 'active' | 'inactive';
}
interface BomView {
  components: Array<{ componentProductId: string; sku: string; productName: string; unit: string | null; quantityPerUnit: number }>;
}

/**
 * ADR-061 Addendum 1 (A4) — Assembly: a direct, single-step build of a finished product from its active BOM
 * (ADR-061 D5 retrofit path — `POST /inventory/assemble`, permission `inventory.assembly.create`, unchanged).
 * For tracked, multi-step production use Work Orders.
 */
export function Assembly() {
  const { t, preload } = useLanguage();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [boms, setBoms] = useState<BomListEntry[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [preview, setPreview] = useState<BomView | null>(null);
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.manufacturing_assembly',
    'field.warehouse',
    'field.finished_product',
    'field.component',
    'field.quantity_per_unit',
    'field.assembly_reference',
    'action.assemble',
    'panel.assembly_success',
    'mfg.field.quantity_to_assemble',
    'mfg.field.required_quantity',
    'mfg.field.unit',
    'mfg.panel.assembly_hint',
    'mfg.panel.assembly_no_boms',
  ]);

  useEffect(() => {
    (async () => {
      try {
        const [wh, list] = await Promise.all([api.get<Warehouse[]>('/inventory/warehouses'), api.get<BomListEntry[]>('/manufacturing/boms')]);
        setWarehouses(wh.filter((w) => w.kind !== 'operational'));
        setBoms(list.filter((b) => b.status === 'active'));
        const main = wh.filter((w) => w.kind !== 'operational');
        if (main[0]) setWarehouseId(main[0].id);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load assembly data.');
      }
    })();
  }, []);

  useEffect(() => {
    setPreview(null);
    if (!productId) return;
    api
      .get<BomView>(`/manufacturing/boms/${productId}`)
      .then(setPreview)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load Bill of Materials.'));
  }, [productId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setReference(null);
    try {
      const result = await api.post<{ assemblyReference: string }>('/inventory/assemble', {
        warehouseId,
        finishedProductId: productId,
        quantity: Number(quantity),
      });
      setReference(result.assemblyReference);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assemble product.');
    } finally {
      setBusy(false);
    }
  }

  const qty = Number(quantity) > 0 ? Number(quantity) : 0;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.manufacturing_assembly')}</h1>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('mfg.panel.assembly_hint')}
      </p>

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={onSubmit} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 240 }}>
            <label>{t('field.finished_product')}</label>
            <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
              <option value="">—</option>
              {boms.map((b) => (
                <option key={b.finishedProductId} value={b.finishedProductId}>
                  {b.sku} — {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
            <label>{t('field.warehouse')}</label>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0, width: 140 }}>
            <label>{t('mfg.field.quantity_to_assemble')}</label>
            <input type="number" min={1} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy || !productId || !warehouseId}>
            {t('action.assemble')}
          </button>
        </form>
        {boms.length === 0 && <div className="empty-state" style={{ marginTop: 12 }}>{t('mfg.panel.assembly_no_boms')}</div>}
      </div>

      {error && <div className="error-text">{error}</div>}
      {reference && (
        <div className="card" style={{ marginBottom: 20 }}>
          {t('panel.assembly_success')} — {t('field.assembly_reference')}: <strong>{reference}</strong>
        </div>
      )}

      {preview && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.component')}</th>
              <th>{t('field.quantity_per_unit')}</th>
              <th>{t('mfg.field.required_quantity')}</th>
              <th>{t('mfg.field.unit')}</th>
            </tr>
          </thead>
          <tbody>
            {preview.components.map((c) => (
              <tr key={c.componentProductId}>
                <td>
                  {c.sku} — {c.productName}
                </td>
                <td>{c.quantityPerUnit}</td>
                <td>{c.quantityPerUnit * qty}</td>
                <td>{c.unit ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
