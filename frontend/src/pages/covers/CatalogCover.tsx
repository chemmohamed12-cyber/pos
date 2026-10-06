import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { SectionCover } from '../../components/SectionCover';

interface Product {
  status: string;
}
interface PriceList {
  id: string;
}
interface BomRow {
  id: string;
}

/** CTO directive ("Section Cover / Main Dashboard System") — the Catalog section's own landing page: active products, price lists, and BOM counts, from the exact list endpoints `Products.tsx`/`PriceLists.tsx`/`Bom.tsx` already read. */
export function CatalogCover() {
  const [kpis, setKpis] = useState<{ activeProducts: number; priceLists: number; boms: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [products, priceLists, boms] = await Promise.all([
          api.get<Product[]>('/products/all'),
          api.get<PriceList[]>('/price-lists'),
          api.get<BomRow[]>('/bom'),
        ]);
        setKpis({
          activeProducts: products.filter((p) => p.status === 'active').length,
          priceLists: priceLists.length,
          boms: boms.length,
        });
      } catch {
        // Foundation fix: degrade to no-KPIs rather than an unhandled rejection.
      }
    })();
  }, []);

  return (
    <SectionCover
      titleCode="nav_group.catalog"
      shortcuts={[
        { to: '/products', labelCode: 'nav.products' },
        { to: '/price-lists', labelCode: 'nav.price_lists' },
        { to: '/bom', labelCode: 'nav.bom' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'field.active_products', value: kpis.activeProducts, to: '/products' },
              { labelCode: 'nav.price_lists', value: kpis.priceLists, to: '/price-lists' },
              { labelCode: 'nav.bom', value: kpis.boms, to: '/bom' },
            ]
          : undefined
      }
    />
  );
}
