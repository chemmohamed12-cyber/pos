import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { SectionCover } from '../../components/SectionCover';
import { useLanguage } from '../../context/LanguageContext';

interface Supplier {
  id: string;
}
interface PurchaseOrderRow {
  id: string;
}
interface SupplierInvoiceRow {
  id: string;
}

/** Navigation Batch 2 (2026-09-26) added `nav_group.procurement` with `coverTo: '/procurement'`, but no route/page existed for it — confirmed via a live sidebar click silently bouncing to Dashboard through the catch-all route. Same shape as `CatalogCover`/`AttendanceCover`. */
export function ProcurementCover() {
  const { lang } = useLanguage();
  const [kpis, setKpis] = useState<{ suppliers: number; purchaseOrders: number; supplierInvoices: number } | null>(null);
  // goods receipts whose goods have not been invoiced yet (undefined when the caller may not see them)
  const [notInvoiced, setNotInvoiced] = useState<number | undefined>(undefined);

  useEffect(() => {
    (async () => {
      try {
        const [suppliers, purchaseOrders, supplierInvoices] = await Promise.all([
          api.get<Supplier[]>('/procurement/suppliers/all'),
          api.get<PurchaseOrderRow[]>('/procurement/purchase-orders'),
          api.get<SupplierInvoiceRow[]>('/procurement/supplier-invoices'),
        ]);
        setKpis({ suppliers: suppliers.length, purchaseOrders: purchaseOrders.length, supplierInvoices: supplierInvoices.length });
      } catch {
        // Foundation fix: degrade to no-KPIs rather than an unhandled rejection.
      }
      api
        .get<{ totalReceipts: number }>('/procurement/goods-receipts/uninvoiced')
        .then((r) => setNotInvoiced(r.totalReceipts))
        .catch(() => setNotInvoiced(undefined));
    })();
  }, []);

  return (
    <SectionCover
      titleCode="nav_group.procurement"
      shortcuts={[
        { to: '/suppliers', labelCode: 'nav.suppliers' },
        { to: '/purchase-orders', labelCode: 'nav.purchase_orders' },
        { to: '/purchase-requests', labelCode: 'nav.purchase_requests' },
        { to: '/rfqs', labelCode: 'nav.rfqs' },
        { to: '/supplier-invoices', labelCode: 'nav.supplier_invoices' },
        { to: '/supplier-statement', labelCode: 'nav.supplier_statement' },
        { to: '/ap-aging', labelCode: 'nav.ap_aging' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'nav.suppliers', value: kpis.suppliers, to: '/suppliers' },
              { labelCode: 'nav.purchase_orders', value: kpis.purchaseOrders, to: '/purchase-orders' },
              { labelCode: 'nav.supplier_invoices', value: kpis.supplierInvoices, to: '/supplier-invoices' },
              ...(notInvoiced === undefined
                ? []
                : [{ labelCode: 'nav.supplier_invoices', label: lang === 'ar' ? 'بضاعة مستلمة لم تُفوتر' : 'Goods received, not invoiced', value: notInvoiced, to: '/goods-not-invoiced', tone: notInvoiced > 0 ? ('warning' as const) : ('default' as const) }]),
            ]
          : undefined
      }
    />
  );
}
