import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';
import { loadingLabel } from '../../lib/displayNames';

interface Product {
  sku: string;
  name: string;
  unitPrice: string;
  status: string;
}

interface ProductListData {
  products: Product[];
}

/** The Product/Price-List report (CTO directive §5) — every active product, not a single-record document. */
export function ProductListPrint() {
  const { preload } = useLanguage();
  const [data, setData] = useState<ProductListData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload(['document.product_catalog_title']);

  useEffect(() => {
    (async () => {
      try {
        const products = await api.get<Product[]>('/products');
        setData({ products });
      } catch (err) {
        // Foundation fix: mount-time load had no error handling — the
        // page was stuck on "Loading…" forever on failure.
        setLoadError(err);
      }
    })();
  }, []);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">{loadingLabel()}</div>;
  const { products } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.product_catalog_title',
    documentNumber: new Date().toISOString().slice(0, 10),
    issuedAt: new Date().toISOString(),
    fields: [],
    lines: products.map((p) => ({ label: `${p.sku} — ${p.name}`, unitPrice: p.unitPrice })),
  };

  return <PrintDocument doc={doc} />;
}
