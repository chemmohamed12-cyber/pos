import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface Conversion {
  id: string;
  unitCode: string;
  factor: number;
}
interface UnitsView {
  baseUnit: string;
  conversions: Conversion[];
}

/**
 * Manufacturing Engine S2 (D-ME-2) — product units & pack conversions. The product's unit is its integer BASE unit; each row says "1 <unit> = <factor> base units"
 * (kg = 1000 g, pack = 12, carton = 240). Recipes and screens that accept a decimal quantity in one of these units convert it exactly to whole base units.
 */
export function ProductUnits({ products }: { products: Array<{ id: string; sku: string; name: string }> }) {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const [productId, setProductId] = useState('');
  const [view, setView] = useState<UnitsView | null>(null);
  const [unitCode, setUnitCode] = useState('');
  const [factor, setFactor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (id: string) => {
    if (!id) {
      setView(null);
      return;
    }
    try {
      setView(await api.get<UnitsView>(`/manufacturing/unit-conversions/${id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    }
  }, []);
  useEffect(() => {
    void load(productId);
  }, [productId, load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load(productId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 20 }} data-testid="product-units">
      <h3 style={{ marginTop: 0 }}>{ar ? 'وحدات الصنف وتحويلات العبوات' : 'Product units & pack conversions'}</h3>
      <div className="muted" style={{ marginBottom: 8 }}>
        {ar ? 'وحدة الصنف هي الوحدة الأساسية (عدد صحيح). كل تحويل = كم وحدة أساسية في الوحدة الأكبر (مثلاً: كجم = 1000 جم، كرتونة = 240).' : 'The product unit is its whole-number base unit. A conversion says how many base units one larger unit holds (e.g. kg = 1000 g, carton = 240).'}
      </div>
      <select value={productId} onChange={(e) => setProductId(e.target.value)} data-testid="pu-product">
        <option value="">{ar ? 'اختر الصنف' : 'Select product'}</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.sku} — {p.name}
          </option>
        ))}
      </select>
      {error && <div className="error-text">{error}</div>}
      {view && (
        <>
          <table className="data-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>{ar ? 'الوحدة' : 'Unit'}</th>
                <th>{ar ? 'تساوي (وحدات أساسية)' : 'Equals (base units)'}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  {view.baseUnit || '—'} <span className="muted">({ar ? 'أساسية' : 'base'})</span>
                </td>
                <td>1</td>
                <td />
              </tr>
              {view.conversions.map((c) => (
                <tr key={c.id}>
                  <td>{c.unitCode}</td>
                  <td>{c.factor}</td>
                  <td>
                    <button className="btn btn-danger" type="button" disabled={busy} onClick={() => run(() => api.delete(`/manufacturing/unit-conversions/${productId}/${encodeURIComponent(c.unitCode)}`))}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
            <input placeholder={ar ? 'الوحدة (كجم، علبة، كرتونة)' : 'Unit (kg, pack, carton)'} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} style={{ minWidth: 200 }} data-testid="pu-code" />
            <input type="number" min={2} step={1} placeholder={ar ? 'عدد الوحدات الأساسية' : 'Base units'} value={factor} onChange={(e) => setFactor(e.target.value)} style={{ width: 150 }} data-testid="pu-factor" />
            <button
              className="btn btn-primary"
              type="button"
              data-testid="pu-add"
              disabled={busy || !unitCode.trim() || !(Number(factor) >= 2)}
              onClick={() =>
                run(async () => {
                  await api.post(`/manufacturing/unit-conversions/${productId}`, { unitCode: unitCode.trim(), factor: Number(factor) });
                  setUnitCode('');
                  setFactor('');
                })
              }
            >
              {ar ? 'إضافة تحويل' : 'Add conversion'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
