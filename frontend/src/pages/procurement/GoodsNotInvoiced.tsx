import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { loadingLabel } from '../../lib/displayNames';

interface UninvoicedOrder {
  purchaseOrderId: string;
  poNumber: string;
  supplierId: string;
  supplierName: string | null;
  uninvoicedQuantity: string;
  uninvoicedValue: string;
  receipts: Array<{ id: string; grNumber: string; createdAt: string }>;
}
interface UninvoicedResult {
  totalReceipts: number;
  totalValue: string;
  orders: UninvoicedOrder[];
}

/**
 * Goods received but not yet invoiced: the work-list that sits between a goods receipt (Dr Inventory / Cr GRNI) and its supplier invoice. Every order opens its purchase order and goods
 * receipts, and a blue "Create invoice" button opens the supplier-invoice form with that order already chosen (the form then fills the received-and-uninvoiced quantities).
 * Read-only over the same received / invoiced quantities the GRNI ledger and the 3-way match use.
 */
export function GoodsNotInvoiced() {
  const { lang } = useLanguage();
  const { authz, can } = useAuth();
  const navigate = useNavigate();
  const ar = lang === 'ar';
  const L = (a: string, e: string) => (ar ? a : e);
  const canInvoice = authz ? can('procurement.supplier_invoice.create', 'editable') : false;
  const [data, setData] = useState<UninvoicedResult | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<UninvoicedResult>('/procurement/goods-receipts/uninvoiced')
      .then(setData)
      .catch((err) => {
        setData(null);
        setError(err instanceof ApiError ? err.message : 'Failed to load goods not yet invoiced.');
      });
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>{L('بضاعة مستلمة لم تُفوتر', 'Goods received, not invoiced')}</h1>
      </div>
      <p style={{ marginTop: 0, opacity: 0.8 }}>
        {L(
          'أوامر شراء استُلمت بضاعتها ولم تصل فاتورة المورد عنها بعد (أو وصلت لجزء منها). اضغط على الأمر لفتح تفاصيله وأذون الاستلام، أو اضغط «إنشاء فاتورة» لتحويله إلى فاتورة مورد.',
          'Purchase orders whose goods were received but whose supplier invoice has not arrived (or covers only part of them). Click an order to open its details and goods receipts, or press "Create invoice" to turn it into a supplier invoice.',
        )}
      </p>
      {error && <div className="error-text">{error}</div>}
      {data === undefined ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : data === null ? null : data.orders.length === 0 ? (
        <div className="empty-state">{L('لا توجد بضاعة مستلمة بانتظار الفاتورة.', 'No received goods are waiting for an invoice.')}</div>
      ) : (
        <>
          <div className="detail-grid" style={{ marginBottom: 16 }}>
            <div className="kpi-tile">
              <div className="label">{L('عدد أذون الاستلام', 'Goods receipts')}</div>
              <div className="value">{data.totalReceipts}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">{L('قيمة البضاعة بلا فاتورة', 'Value not invoiced')}</div>
              <div className="value">{data.totalValue}</div>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>{L('أمر الشراء', 'Purchase order')}</th>
                <th>{L('المورد', 'Supplier')}</th>
                <th>{L('أذون الاستلام', 'Goods receipts')}</th>
                <th>{L('الكمية بلا فاتورة', 'Quantity not invoiced')}</th>
                <th>{L('القيمة بلا فاتورة', 'Value not invoiced')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.purchaseOrderId} style={{ cursor: 'pointer' }} onClick={() => navigate(`/purchase-orders?id=${o.purchaseOrderId}`)}>
                  <td>
                    <Link to={`/purchase-orders?id=${o.purchaseOrderId}`} onClick={(e) => e.stopPropagation()}>
                      {o.poNumber}
                    </Link>
                  </td>
                  <td>{o.supplierName ?? '—'}</td>
                  <td>
                    {o.receipts.map((r) => (
                      <div key={r.id}>
                        <Link to={`/purchase-orders?id=${o.purchaseOrderId}`} onClick={(e) => e.stopPropagation()}>
                          {r.grNumber}
                        </Link>
                        <span style={{ opacity: 0.6, fontSize: '0.8rem' }}> — {new Date(r.createdAt).toLocaleDateString(ar ? 'ar-EG' : 'en-GB')}</span>
                      </div>
                    ))}
                  </td>
                  <td>{Number(o.uninvoicedQuantity)}</td>
                  <td>{o.uninvoicedValue}</td>
                  <td>
                    {canInvoice && (
                      <button
                        className="btn btn-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/supplier-invoices?purchaseOrderId=${o.purchaseOrderId}`);
                        }}
                      >
                        {L('إنشاء فاتورة', 'Create invoice')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
