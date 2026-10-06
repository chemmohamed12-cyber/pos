import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';

interface Transaction {
  transactionNumber: string;
  type: string;
  warehouseId: string;
  destinationWarehouseId: string | null;
  reference: string | null;
  reason: string | null;
  state: string;
  createdAt: string;
}
interface Line {
  productId: string;
  quantity: number;
}

interface WarehouseTransactionData {
  txn: Transaction;
  lines: Line[];
  warehouses: Array<{ id: string; code: string; name: string }>;
  products: Array<{ id: string; sku: string; name: string }>;
}

/** Directive §12/§13 — the same numbered document shown in the UI, printable/PDF, carrying the transaction number onto the paper trail. */
export function WarehouseTransactionPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<WarehouseTransactionData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload(['document.warehouse_transaction_title', 'field.warehouse', 'field.destination_warehouse', 'field.reason']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const [txn, lines, warehouses, products] = await Promise.all([
          api.get<Transaction>(`/warehouse-transactions/${id}`),
          api.get<Line[]>(`/warehouse-transactions/${id}/lines`),
          api.get<Array<{ id: string; code: string; name: string }>>('/inventory/warehouses'),
          api.get<Array<{ id: string; sku: string; name: string }>>('/products/all'),
        ]);

        setData({ txn, lines, warehouses, products });
      } catch (err) {
        // Foundation fix: mount-time load had no error handling.
        setLoadError(err);
      }
    })();
  }, [id]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { txn, lines, warehouses, products } = data;
  const warehouseLabel = (whId: string | null) => {
    if (!whId) return '—';
    const w = warehouses.find((x) => x.id === whId);
    return w ? `${w.code} — ${w.name}` : whId;
  };
  const productLabel = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    return p ? `${p.sku} — ${p.name}` : pid;
  };

  const doc: BusinessDocument = {
    documentTitleCode: 'document.warehouse_transaction_title',
    documentNumber: txn.transactionNumber,
    issuedAt: txn.createdAt,
    statusLabel: t(`warehouse_txn_state.${txn.state}`),
    fields: [
      { label: 'Type', value: t(`warehouse_txn_type.${txn.type}`) },
      { label: t('field.warehouse'), value: warehouseLabel(txn.warehouseId) },
      ...(txn.destinationWarehouseId ? [{ label: t('field.destination_warehouse'), value: warehouseLabel(txn.destinationWarehouseId) }] : []),
      ...(txn.reference ? [{ label: 'Reference', value: txn.reference }] : []),
      ...(txn.reason ? [{ label: t('field.reason'), value: txn.reason }] : []),
    ],
    lines: lines.map((l) => ({ label: productLabel(l.productId), quantity: l.quantity })),
  };

  return <PrintDocument doc={doc} />;
}
