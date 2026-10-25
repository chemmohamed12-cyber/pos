import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { BlockedReason, DataTable, EmptyState, FormField } from '../../components/mfg';

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
 * Product units & pack conversions (Manufacturing Engine S2 / D-ME-2; UX redesign stage 3 - presentation only, no unit catalogue and no schema change).
 * The product's unit is its integer BASE unit; each row says "1 <unit> = <factor> base units". The form explains the rule, validates as you type and previews the exact sentence that will be saved.
 */
export function ProductUnits({ products }: { products: Array<{ id: string; sku: string; name: string }> }) {
  const { t } = useLanguage();
  const { can } = useAuth();
  const canEdit = can('manufacturing.bom.edit', 'editable');
  const [productId, setProductId] = useState('');
  const [view, setView] = useState<UnitsView | null>(null);
  const [unitCode, setUnitCode] = useState('');
  const [factor, setFactor] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const load = useCallback(
    async (id: string) => {
      if (!id) {
        setView(null);
        return;
      }
      try {
        setView(await api.get<UnitsView>(`/manufacturing/unit-conversions/${id}`));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
      }
    },
    [t],
  );
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
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    } finally {
      setBusy(false);
    }
  }

  const code = unitCode.trim();
  const f = Number(factor);
  const base = view?.baseUnit || t('mfg2.bom.base_unit');
  const codeError = !code ? t('mfg2.unit.err.code') : code.toLowerCase() === (view?.baseUnit ?? '').toLowerCase() ? t('mfg2.unit.err.same_as_base') : view?.conversions.some((c) => c.unitCode.toLowerCase() === code.toLowerCase()) ? t('mfg2.unit.err.exists') : null;
  const factorError = !factor.trim() ? t('mfg2.unit.err.factor') : !Number.isInteger(f) || f < 2 ? t('mfg2.unit.err.factor_int') : null;
  const valid = !codeError && !factorError;

  return (
    <section className="card" style={{ marginBlockStart: 20 }} data-testid="product-units" aria-labelledby="pu-title">
      <h2 id="pu-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
        {t('mfg2.unit.title')}
      </h2>
      <p className="mfg-note">{t('mfg2.unit.help')}</p>
      <div style={{ maxInlineSize: 420 }}>
        <FormField label={t('mfg2.unit.product')}>
          {(p) => (
            <select {...p} value={productId} onChange={(e) => { setProductId(e.target.value); setError(null); setTouched(false); }} data-testid="pu-product">
              <option value="">{t('mfg2.common.choose')}</option>
              {products.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.sku} — {x.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </div>
      {error && <BlockedReason danger>{error}</BlockedReason>}
      {view && (
        <>
          <DataTable
            caption={t('mfg2.unit.table')}
            rows={[{ id: 'base', unitCode: view.baseUnit, factor: 1, isBase: true } as Conversion & { isBase?: boolean }, ...view.conversions]}
            rowKey={(c) => c.id}
            empty={<EmptyState title={t('mfg2.unit.empty')} />}
            columns={[
              { key: 'u', header: t('mfg2.col.unit'), render: (c) => `${c.unitCode || '—'}${(c as { isBase?: boolean }).isBase ? ` (${t('mfg2.unit.base')})` : ''}` },
              { key: 'f', header: t('mfg2.unit.equals'), align: 'end', render: (c) => `${c.factor} ${base}` },
              {
                key: 'a',
                header: t('mfg2.pe.col.actions'),
                render: (c) =>
                  (c as { isBase?: boolean }).isBase || !canEdit ? null : (
                    <button className="btn btn-danger" type="button" disabled={busy} aria-label={`${t('mfg2.pe.remove')} ${c.unitCode}`} onClick={() => run(() => api.delete(`/manufacturing/unit-conversions/${productId}/${encodeURIComponent(c.unitCode)}`))}>
                      {t('mfg2.pe.remove')}
                    </button>
                  ),
              },
            ]}
          />
          {canEdit && (
            <div style={{ marginBlockStart: 14 }}>
              <h3 style={{ fontSize: '1rem', margin: '0 0 6px' }}>{t('mfg2.unit.add_title')}</h3>
              <div className="mfg-grid cols-3">
                <FormField label={t('mfg2.unit.code')} hint={t('mfg2.unit.code_hint')} error={touched ? codeError : null} required>
                  {(p) => <input {...p} value={unitCode} onChange={(e) => { setUnitCode(e.target.value); setTouched(true); }} data-testid="pu-code" />}
                </FormField>
                <FormField label={t('mfg2.unit.factor')} hint={`${t('mfg2.unit.factor_hint')} (${base})`} error={touched ? factorError : null} required>
                  {(p) => <input {...p} type="number" min={2} step={1} value={factor} onChange={(e) => { setFactor(e.target.value); setTouched(true); }} data-testid="pu-factor" />}
                </FormField>
                <div className="mfg-equiv" aria-live="polite">
                  <span className="mfg-check-label">{t('mfg2.unit.preview')}</span>
                  {valid ? (
                    <strong>
                      1 {code} = {f} {base}
                    </strong>
                  ) : (
                    <span className="mfg-note">—</span>
                  )}
                </div>
              </div>
              <button
                className="btn btn-primary"
                type="button"
                data-testid="pu-add"
                disabled={busy || !valid}
                onClick={() =>
                  run(async () => {
                    await api.post(`/manufacturing/unit-conversions/${productId}`, { unitCode: code, factor: f });
                    setUnitCode('');
                    setFactor('');
                    setTouched(false);
                  })
                }
              >
                {t('mfg2.unit.add')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
