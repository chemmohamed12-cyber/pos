import { useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface OpenInvoice {
  id: string;
  invoiceNumber: string;
  supplierId: string;
  state: string;
  remaining: string;
}

/**
 * Phase B - ONE payment settling several open invoices of the same supplier. The user ticks the invoices and edits each amount (never above that invoice's balance); the server records one
 * treasury cash-out, one payment and one ledger debit per invoice, atomically. The single-invoice form stays as it was.
 */
export function MultiInvoicePayment({
  supplierId,
  invoices,
  treasuryAccounts,
  method,
  treasuryAccountId,
  onDone,
  onError,
}: {
  supplierId: string;
  invoices: OpenInvoice[];
  treasuryAccounts: Array<{ id: string; code: string; name: string }>;
  method: string;
  treasuryAccountId: string;
  onDone: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { lang } = useLanguage();
  const L = (a: string, e: string) => (lang === 'ar' ? a : e);
  const open = useMemo(() => invoices.filter((i) => i.supplierId === supplierId && (i.state === 'posted' || i.state === 'partially_paid') && Number(i.remaining) > 0), [invoices, supplierId]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [accountId, setAccountId] = useState(treasuryAccountId);
  const [busy, setBusy] = useState(false);

  if (open.length < 2) return null;
  const chosen = open.filter((i) => amounts[i.id] !== undefined && Number(amounts[i.id]) > 0);
  const total = chosen.reduce((s, i) => s + Math.round(Number(amounts[i.id]) * 100), 0) / 100;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (chosen.length === 0 || !(accountId || treasuryAccountId)) return;
    setBusy(true);
    onError(null);
    try {
      await api.post('/procurement/supplier-payments/allocated', {
        supplierId,
        allocations: chosen.map((i) => ({ invoiceId: i.id, amount: Number(amounts[i.id]).toFixed(2) })),
        method,
        treasuryAccountId: accountId || treasuryAccountId,
      });
      setAmounts({});
      await onDone();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Failed to record payment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16, borderTop: '1px solid var(--border, #ddd)', paddingTop: 12 }}>
      <h4 style={{ margin: 0 }}>{L('دفعة واحدة لعدة فواتير لنفس المورد', 'One payment for several invoices of this supplier')}</h4>
      <table className="data-table">
        <thead>
          <tr>
            <th />
            <th>{L('الفاتورة', 'Invoice')}</th>
            <th>{L('المتبقي', 'Remaining')}</th>
            <th>{L('المبلغ المدفوع', 'Amount to pay')}</th>
          </tr>
        </thead>
        <tbody>
          {open.map((i) => (
            <tr key={i.id}>
              <td>
                <input
                  type="checkbox"
                  checked={amounts[i.id] !== undefined}
                  onChange={(e) =>
                    setAmounts((a) => {
                      const next = { ...a };
                      if (e.target.checked) next[i.id] = i.remaining;
                      else delete next[i.id];
                      return next;
                    })
                  }
                />
              </td>
              <td>{i.invoiceNumber}</td>
              <td>{i.remaining}</td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={Number(i.remaining)}
                  step="0.01"
                  disabled={amounts[i.id] === undefined}
                  value={amounts[i.id] ?? ''}
                  onChange={(e) => setAmounts((a) => ({ ...a, [i.id]: e.target.value }))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-field" style={{ marginBottom: 0 }}>
        <label>{L('حساب الخزينة', 'Treasury account')}</label>
        <select value={accountId || treasuryAccountId} onChange={(e) => setAccountId(e.target.value)} required>
          {treasuryAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} — {a.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        {L('إجمالي الدفعة', 'Payment total')}: <strong>{total.toFixed(2)}</strong>
      </div>
      <button className="btn btn-primary" type="submit" disabled={busy || chosen.length === 0}>
        {L('تسجيل الدفعة على الفواتير المحددة', 'Record payment on the selected invoices')}
      </button>
    </form>
  );
}
