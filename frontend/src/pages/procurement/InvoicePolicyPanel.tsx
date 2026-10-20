import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';

export interface InvoicePolicy {
  approvalRequired: boolean;
  priceTolerancePct: number;
  priceToleranceAmount: number | null;
  toleranceDirection: 'both' | 'over_only';
}

/**
 * Phase C-1 - the Company's supplier-invoice policy: approval workflow switch and price-tolerance limits (percentage and/or amount; when both are set both must pass). Shown only to users who may
 * manage it (`procurement.invoice_policy.manage`); everyone else just sees the effect on the invoice. Defaults are zero tolerance.
 */
export function InvoicePolicyPanel({ policy, onSaved }: { policy: InvoicePolicy; onSaved: (p: InvoicePolicy) => void }) {
  const { can } = useAuth();
  const { lang } = useLanguage();
  const L = (a: string, e: string) => (lang === 'ar' ? a : e);
  const [open, setOpen] = useState(false);
  const [approvalRequired, setApprovalRequired] = useState(policy.approvalRequired);
  const [pct, setPct] = useState(String(policy.priceTolerancePct));
  const [amount, setAmount] = useState(policy.priceToleranceAmount == null ? '' : String(policy.priceToleranceAmount));
  const [direction, setDirection] = useState(policy.toleranceDirection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setApprovalRequired(policy.approvalRequired);
    setPct(String(policy.priceTolerancePct));
    setAmount(policy.priceToleranceAmount == null ? '' : String(policy.priceToleranceAmount));
    setDirection(policy.toleranceDirection);
  }, [policy]);

  if (!can('procurement.invoice_policy.manage', 'editable')) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api.post<InvoicePolicy>('/procurement/supplier-invoices/policy', {
        approvalRequired,
        priceTolerancePct: Number(pct) || 0,
        priceToleranceAmount: amount.trim() === '' ? null : Number(amount),
        toleranceDirection: direction,
      });
      onSaved(saved);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the policy.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{L('سياسة اعتماد ومطابقة فواتير الموردين', 'Supplier invoice approval and matching policy')}</strong>
        <button className="btn btn-secondary" type="button" onClick={() => setOpen((v) => !v)}>
          {open ? L('إغلاق', 'Close') : L('تعديل', 'Edit')}
        </button>
      </div>
      <div style={{ fontSize: 13, opacity: 0.8, marginTop: 6 }}>
        {policy.approvalRequired ? L('الاعتماد مطلوب قبل الترحيل', 'Approval required before posting') : L('الترحيل المباشر (بدون اعتماد)', 'Direct posting (no approval)')} — {L('تفاوت السعر', 'price tolerance')}: {policy.priceTolerancePct}%
        {policy.priceToleranceAmount != null ? ` / ${policy.priceToleranceAmount.toFixed(2)}` : ''}
      </div>
      {open && (
        <form onSubmit={save} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={approvalRequired} onChange={(e) => setApprovalRequired(e.target.checked)} />
            {L('اشتراط الاعتماد قبل الترحيل', 'Require approval before posting')}
          </label>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{L('نسبة تفاوت السعر %', 'Price tolerance %')}</label>
            <input type="number" min={0} max={100} step="0.01" value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 110 }} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{L('أقصى قيمة تفاوت (اختياري)', 'Max difference amount (optional)')}</label>
            <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 140 }} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{L('اتجاه التفاوت', 'Direction')}</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as 'both' | 'over_only')}>
              <option value="both">{L('الزيادة والنقص', 'Higher and lower')}</option>
              <option value="over_only">{L('الزيادة فقط', 'Higher only')}</option>
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {L('حفظ', 'Save')}
          </button>
          {error && <div className="error-text">{error}</div>}
        </form>
      )}
    </div>
  );
}
