import { useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { useLanguage } from '../../../context/LanguageContext';
import { loadingLabel } from '../../../lib/displayNames';

interface Barcode {
  id: string;
  barcode: string;
  packLabel: string | null;
  isPrimary: boolean;
}


/**
 * Master data step 1 (D-MD11) — the item's barcodes: many per item, unique per Company, never equal to a SKU (server rules).
 * `packLabel` is information only — there is no unit conversion until a unit-of-measure engine is approved (D-MD3).
 * A keyboard-wedge scanner works in the input as-is (it types the code and presses Enter, which submits the form).
 */
export function ItemBarcodesPanel({ productId, unit, canEdit }: { productId: string; unit: string | null; canEdit: boolean }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<Barcode[] | null>(null);
  const [barcode, setBarcode] = useState('');
  const [packLabel, setPackLabel] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setRows(await api.get<Barcode[]>(`/products/${productId}/barcodes`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load barcodes.');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/products/${productId}/barcodes`, { barcode: barcode.trim(), packLabel: packLabel.trim() || null, isPrimary });
      setBarcode('');
      setPackLabel('');
      setIsPrimary(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add the barcode.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api.post(`/products/${productId}/barcodes/${id}/remove`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove the barcode.');
    }
  }

  return (
    <>
      <div className="detail-grid">
        <div className="detail-field">
          <div className="label">{t('field.base_unit')}</div>
          <div className="value">{unit ?? '—'}</div>
        </div>
      </div>
      <p className="item-note">{t('panel.item_barcode_rules')}</p>
      {error && <div className="error-text">{error}</div>}
      {canEdit && (
        <form
          className="item-filters"
          style={{ marginBottom: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (barcode.trim()) void add();
          }}
        >
          <div className="form-field">
            <label>{t('field.barcode')}</label>
            <input value={barcode} maxLength={64} autoComplete="off" onChange={(e) => setBarcode(e.target.value)} data-testid="barcode-input" />
          </div>
          <div className="form-field">
            <label>{t('field.pack_label')}</label>
            <input value={packLabel} maxLength={64} onChange={(e) => setPackLabel(e.target.value)} />
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
            {t('field.primary_barcode')}
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !barcode.trim()}>
            {t('action.add_barcode')}
          </button>
        </form>
      )}
      {rows === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('panel.item_no_barcodes')}</div>
      ) : (
        <table className="data-table" data-testid="barcode-table">
          <thead>
            <tr>
              <th>{t('field.barcode')}</th>
              <th>{t('field.pack_label')}</th>
              <th>{t('field.primary_barcode')}</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="item-doc-number" style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>
                  {r.barcode}
                </td>
                <td>{r.packLabel ?? '—'}</td>
                <td>{r.isPrimary ? '✓' : ''}</td>
                {canEdit && (
                  <td>
                    <button className="btn btn-secondary" onClick={() => void remove(r.id)}>
                      {t('action.remove')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
