import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface InvoicingRow {
  purchaseOrderLineId: string;
  productId: string;
  ordered: string;
  received: string;
  invoiced: string;
  remainingToReceive: string;
  remainingToInvoice: string;
  receipts: Array<{ goodsReceiptLineId: string; grNumber: string; received: string; invoiced: string; free: string }>;
}

/**
 * Phase A - per purchase-order line: ordered / received / invoiced / remaining, and for each goods receipt how much of it has been billed (read-only; same figures the 3-way match enforces).
 * Hidden when the user may not view supplier invoices or the order has nothing received yet.
 */
export function PoInvoicingTable({ purchaseOrderId, productName, refreshKey }: { purchaseOrderId: string; productName: (id: string) => string; refreshKey?: unknown }) {
  const { lang } = useLanguage();
  const L = (a: string, e: string) => (lang === 'ar' ? a : e);
  const [rows, setRows] = useState<InvoicingRow[] | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<InvoicingRow[]>(`/procurement/supplier-invoices/invoicing-by-purchase-order/${purchaseOrderId}`)
      .then((r) => live && setRows(Array.isArray(r) ? r : null))
      .catch(() => live && setRows(null));
    return () => {
      live = false;
    };
  }, [purchaseOrderId, refreshKey]);

  if (!rows || rows.every((r) => Number(r.received) === 0)) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <h4>{L('الكميات: المطلوب / المستلم / المفوتر / المتبقي', 'Quantities: ordered / received / invoiced / remaining')}</h4>
      <table className="data-table">
        <thead>
          <tr>
            <th>{L('الصنف', 'Item')}</th>
            <th>{L('المطلوب', 'Ordered')}</th>
            <th>{L('المستلم', 'Received')}</th>
            <th>{L('المفوتر', 'Invoiced')}</th>
            <th>{L('متبقي للاستلام', 'Left to receive')}</th>
            <th>{L('متبقي للفوترة', 'Left to invoice')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.purchaseOrderLineId}>
              <td>
                {productName(r.productId)}
                {r.receipts.length > 0 && (
                  <div style={{ fontSize: '0.8rem', opacity: 0.75 }}>
                    {r.receipts.map((g) => (
                      <div key={g.goodsReceiptLineId}>
                        {g.grNumber}: {L('استلام', 'received')} {Number(g.received)} — {L('مفوتر', 'invoiced')} {Number(g.invoiced)} — {L('متبقٍ', 'left')} {Number(g.free)}
                      </div>
                    ))}
                  </div>
                )}
              </td>
              <td>{Number(r.ordered)}</td>
              <td>{Number(r.received)}</td>
              <td>{Number(r.invoiced)}</td>
              <td>{Number(r.remainingToReceive)}</td>
              <td>{Number(r.remainingToInvoice)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
