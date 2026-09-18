import { useMemo, useRef, useState } from 'react';
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
}

/**
 * Product Search / Selection UI/UX Requirement (2026-09-17) — a proper
 * searchable dropdown/combobox keyed on product NAME, not code: click (or
 * focus) to browse every product, type to filter by name, select directly
 * from the list. The product's id/sku are still retained internally for
 * the caller (addLine / name-based filter) — never required as search
 * input. Shared by the Warehouse transaction line-item search and the
 * Inventory grid's product filter.
 */
export function ProductCombobox({ products, value, onValueChange, onSelect, placeholder, clearOnSelect, maxResults = 50 }: ProductComboboxProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = value.trim().toLowerCase();
    const matches = q ? products.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)) : products;
    return [...matches].sort((a, b) => a.name.localeCompare(b.name)).slice(0, maxResults);
  }, [value, products, maxResults]);

  function selectProduct(p: ProductOption) {
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
          onValueChange(e.target.value);
          setOpen(true);
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
