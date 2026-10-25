import { useState } from 'react';
import { useLanguage } from '../../../context/LanguageContext';
import { toBase } from '../units';

export interface ProductUnits {
  baseUnit: string;
  /** unit code -> base units per 1 of that unit */
  packs: Record<string, number>;
}

type FieldProps = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; 'aria-required'?: boolean };

/**
 * A quantity typed either in the product's base unit (a whole number) or as a decimal in one of its pack units (T-W-06). Only the exact whole base-unit count is ever stored: the definition
 * keeps whole base units, so a pack amount is converted here with the same exact arithmetic the server uses and anything that does not land on a whole count is explained with the two
 * nearest valid counts instead of being rounded. With no pack units defined the control is the plain whole-number input it always was.
 */
export function QuantityWithUnit({ field, valueBase, units, onChange }: { field: FieldProps; valueBase: number; units: ProductUnits | undefined; onChange: (base: number) => void }) {
  const { t } = useLanguage();
  const [unit, setUnit] = useState('');
  const [text, setText] = useState('');
  const packCodes = units ? Object.keys(units.packs) : [];
  const baseLabel = units?.baseUnit || t('mfg2.bom.base_unit');

  if (packCodes.length === 0) {
    return <input {...field} type="number" min={1} step={1} value={valueBase} onChange={(e) => onChange(Number(e.target.value) || 0)} />;
  }
  const factor = unit ? (units!.packs[unit] ?? 1) : 1;
  const r = unit && text.trim() !== '' ? toBase(text, factor) : null;

  return (
    <div className="mfg-qty">
      <div className="mfg-qty-row">
        {unit === '' ? (
          <input {...field} type="number" min={1} step={1} value={valueBase} onChange={(e) => onChange(Number(e.target.value) || 0)} />
        ) : (
          <input {...field} inputMode="decimal" value={text} onChange={(e) => {
            const v = e.target.value;
            setText(v);
            const res = toBase(v, factor);
            if (res.kind === 'whole') onChange(Number(res.base));
          }} />
        )}
        <select aria-label={t('mfg2.pe.qty.unit')} value={unit} onChange={(e) => { setUnit(e.target.value); setText(''); }}>
          <option value="">{baseLabel}</option>
          {packCodes.map((c) => (
            <option key={c} value={c}>
              {c} ({units!.packs[c]} {baseLabel})
            </option>
          ))}
        </select>
      </div>
      <div className="mfg-note" aria-live="polite" data-testid="qty-equivalent">
        {unit === '' ? (
          `${t('mfg2.bom.line.equiv')}: ${valueBase} ${baseLabel}`
        ) : r?.kind === 'whole' ? (
          <strong>{`${t('mfg2.bom.line.equiv')}: ${r.base} ${baseLabel}`}</strong>
        ) : r?.kind === 'fraction' ? (
          <span className="mfg-field-error">
            {t('mfg2.bom.err.fraction')} {t('mfg2.bom.suggest')} <strong>{r.below}</strong> / <strong>{r.above}</strong> {baseLabel}
            {' '}
            {t('mfg2.pe.qty.kept')} <strong>{valueBase}</strong> {baseLabel}
          </span>
        ) : r?.kind === 'invalid' || r?.kind === 'zero' ? (
          <span className="mfg-field-error">{t('mfg2.bom.err.qty_invalid')}</span>
        ) : (
          `${t('mfg2.bom.line.equiv')}: ${valueBase} ${baseLabel}`
        )}
      </div>
    </div>
  );
}
