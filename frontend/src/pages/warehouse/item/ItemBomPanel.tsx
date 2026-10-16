import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../../lib/api';
import { useAuth } from '../../../context/AuthContext';
import { useLanguage } from '../../../context/LanguageContext';
import { StatusBadge } from '../../../components/StatusBadge';
import { ProductCombobox, type ProductOption } from '../../../components/ProductCombobox';

interface BomComponentView {
  componentProductId: string;
  sku: string;
  productName: string;
  quantityPerUnit: number;
}
interface BomView {
  status?: 'active' | 'inactive';
  components: BomComponentView[];
}
interface DraftLine {
  componentProductId: string;
  label: string;
  quantityPerUnit: number;
}


/**
 * Master data step 1 — the item's Bill of Materials, on the ONE BOM store through the Manufacturing facade (`/manufacturing/boms`,
 * `manufacturing.bom.*`); users without manufacturing access read it through the Catalog facade (`/bom`). No second BOM
 * implementation, no client-side rule: quantities are whole numbers ≥ 1 in the component's base unit (D-MD5), enforced by the API.
 */
export function ItemBomPanel({ productId, originWarehouseId, onChanged }: { productId: string; originWarehouseId: string; onChanged?: (exists: boolean) => void }) {
  const { can } = useAuth();
  const { t } = useLanguage();
  const canView = can('manufacturing.bom.view', 'read-only');
  const canCreate = can('manufacturing.bom.create', 'editable');
  const canEdit = can('manufacturing.bom.edit', 'editable');

  const [bom, setBom] = useState<BomView | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [catalog, setCatalog] = useState<ProductOption[]>([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    const result = await api.get<BomView>(canView ? `/manufacturing/boms/${productId}` : `/bom/${productId}`).catch(() => null);
    setBom(result);
    onChanged?.(!!result);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  async function startEdit() {
    setError(null);
    setDraft((bom?.components ?? []).map((c) => ({ componentProductId: c.componentProductId, label: `${c.sku} — ${c.productName}`, quantityPerUnit: Number(c.quantityPerUnit) })));
    if (catalog.length === 0) setCatalog((await api.get<ProductOption[]>('/products/all').catch(() => [])).filter((p) => p.id !== productId));
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const components = draft.map((d) => ({ componentProductId: d.componentProductId, quantityPerUnit: d.quantityPerUnit }));
      await api.post(bom ? `/manufacturing/boms/${productId}/replace` : `/manufacturing/boms/${productId}`, { components });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the Bill of Materials.');
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(status: 'active' | 'inactive') {
    setError(null);
    try {
      await api.post(`/manufacturing/boms/${productId}/status`, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change the status.');
    }
  }

  const itemLink = (id: string) => `/inventory/items/${id}${originWarehouseId ? `?warehouseId=${originWarehouseId}` : ''}`;

  if (bom === undefined) return <div className="empty-state">Loading…</div>;

  if (editing) {
    return (
      <>
        {error && <div className="error-text">{error}</div>}
        <p className="item-note">{t('panel.item_bom_integer_note')}</p>
        <table className="data-table" data-testid="bom-editor">
          <thead>
            <tr>
              <th>{t('field.component')}</th>
              <th>{t('field.quantity_per_unit')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.map((d, i) => (
              <tr key={d.componentProductId}>
                <td>{d.label}</td>
                <td>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={d.quantityPerUnit}
                    style={{ maxWidth: 110 }}
                    onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, quantityPerUnit: Number(e.target.value) } : x)))}
                  />
                </td>
                <td>
                  <button type="button" className="btn btn-secondary" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
                    {t('action.remove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="item-filters" style={{ marginBlock: 12 }}>
          <div className="form-field" style={{ minWidth: 280 }}>
            <label>{t('action.add_component')}</label>
            <ProductCombobox
              products={catalog.filter((p) => !draft.some((d) => d.componentProductId === p.id))}
              value={pick}
              onValueChange={setPick}
              onSelect={(p) => {
                setDraft([...draft, { componentProductId: p.id, label: `${p.sku} — ${p.name}`, quantityPerUnit: 1 }]);
                setPick('');
              }}
              placeholder={t('field.search_product_placeholder')}
              clearOnSelect
            />
          </div>
        </div>
        <div className="action-row">
          <button className="btn btn-primary" disabled={saving || draft.length === 0} onClick={() => void save()} data-testid="bom-save">
            {t('action.save')}
          </button>
          <button className="btn btn-secondary" disabled={saving} onClick={() => setEditing(false)}>
            {t('action.cancel')}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {error && <div className="error-text">{error}</div>}
      <div className="action-row" style={{ marginBottom: 12, alignItems: 'center' }}>
        {bom?.status && <StatusBadge code={`mfg.status.${bom.status}`} />}
        {bom ? canEdit && <button className="btn btn-primary" onClick={() => void startEdit()}>{t('mfg.action.edit')}</button> : canCreate && <button className="btn btn-primary" onClick={() => void startEdit()}>{t('mfg.action.new_bom')}</button>}
        {bom && canEdit && bom.status === 'active' && (
          <button className="btn btn-secondary" onClick={() => void setStatus('inactive')}>
            {t('mfg.action.deactivate')}
          </button>
        )}
        {bom && canEdit && bom.status === 'inactive' && (
          <button className="btn btn-secondary" onClick={() => void setStatus('active')}>
            {t('mfg.action.activate')}
          </button>
        )}
        {canView && <Link to="/manufacturing/boms">{t('nav.manufacturing_boms')}</Link>}
      </div>
      {!bom || bom.components.length === 0 ? (
        <div className="empty-state">{t('panel.item_no_bom')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.component')}</th>
              <th>{t('field.quantity_per_unit')}</th>
            </tr>
          </thead>
          <tbody>
            {bom.components.map((c) => (
              <tr key={c.componentProductId}>
                <td>
                  <Link to={itemLink(c.componentProductId)}>
                    {c.sku} — {c.productName}
                  </Link>
                </td>
                <td>{String(c.quantityPerUnit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
