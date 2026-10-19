import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
}

interface ProductComboboxProps {
  products: ProductOption[];
  value: string;
  onValueChange: (text: string) => void;
  onSelect: (product: ProductOption) => void;
  placeholder: string;
  /** Clears the input after selection instead of filling it with the selected product's name — for "search to add a line" flows. */
  clearOnSelect?: boolean;
  maxResults?: number;
  /** Items hidden from the LIST (e.g. already on the document). A scanned or typed exact code still resolves them, so the caller can warn instead of the scan being refused. */
  excludedIds?: ReadonlySet<string>;
  /** Scan-or-type (master data step 2): Enter resolves the typed text as an exact item code / barcode (`GET /products/lookup`). Default on; the list stays the manual fallback. */
  scanLookup?: boolean;
}

/**
 * Product Search / Selection UI/UX Requirement (2026-09-17) — a proper
 * searchable dropdown/combobox keyed on product NAME, not code: click (or
 * focus) to browse every product, type to filter by name, select directly
 * from the list. The product's id/sku are still retained internally for
 * the caller (addLine / name-based filter) — never required as search
 * input. Shared by the Warehouse transaction line-item search and the
 * Inventory grid's product filter.
 *
 * Scan-or-type (master data step 2, 2026-10-16): pressing Enter — which is how a barcode scanner ends a scan — resolves the text as
 * an exact SKU first, then an exact barcode, and selects that item. Nothing else changes: typing still filters the list and a
 * click still selects. An unknown or unselectable code shows a message and leaves the text and the list in place, so the user
 * can always pick the item by hand. Enter never submits the surrounding form from this field.
 */
export function ProductCombobox({ products, value, onValueChange, onSelect, placeholder, clearOnSelect, maxResults = 50, scanLookup = true, excludedIds }: ProductComboboxProps) {
  const { t, preload } = useLanguage();
  preload(['panel.barcode_not_found', 'panel.barcode_not_available']);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const scanSeq = useRef(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = value.trim().toLowerCase();
    const listed = excludedIds ? products.filter((p) => !excludedIds.has(p.id)) : products;
    const matches = q ? listed.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)) : listed;
    return [...matches].sort((a, b) => a.name.localeCompare(b.name)).slice(0, maxResults);
  }, [value, products, maxResults, excludedIds]);

  async function resolveCode(raw: string) {
    const code = raw.trim();
    if (!code) return;
    const seq = ++scanSeq.current;
    const lower = code.toLowerCase();
    const local = products.find((p) => p.sku.toLowerCase() === lower);
    if (local) return selectProduct(local);
    try {
      const found = await api.get<{ product: ProductOption }>(`/products/lookup?code=${encodeURIComponent(code)}`);
      if (seq !== scanSeq.current) return; // a newer scan or edit superseded this one
      const inList = products.find((p) => p.id === found.product.id);
      if (inList) selectProduct(inList);
      else setScanMessage(t('panel.barcode_not_available'));
    } catch (err) {
      if (seq !== scanSeq.current) return;
      setScanMessage(err instanceof ApiError && err.status !== 404 ? err.message : t('panel.barcode_not_found'));
    }
  }

  function selectProduct(p: ProductOption) {
    scanSeq.current++;
    setScanMessage(null);
    onSelect(p);
    onValueChange(clearOnSelect ? '' : p.name);
    setOpen(false);
  }

  return (
    <div className="combobox-wrap">
      <input
        ref={inputRef}
        className="combobox-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          scanSeq.current++;
          setScanMessage(null);
          onValueChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault(); // a scanner ends with Enter — never submit the surrounding form from the item field
          if (scanLookup && !e.nativeEvent.isComposing) void resolveCode(value);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      />
      <span
        className="combobox-chevron"
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
          inputRef.current?.focus();
        }}
      >
        ▾
      </span>
      {scanMessage && (
        <div className="combobox-scan-message" role="status">
          {scanMessage}
        </div>
      )}
      {open && (
        <div className="card combobox-panel">
          {results.length === 0 ? (
            <div className="combobox-empty">{t('panel.no_matching_products')}</div>
          ) : (
            results.map((p) => (
              <div key={p.id} className="combobox-option" onMouseDown={() => selectProduct(p)}>
                <span className="combobox-option-name">{p.name}</span>
                <span className="combobox-option-sku">{p.sku}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
