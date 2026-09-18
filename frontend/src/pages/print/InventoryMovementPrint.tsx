import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';

interface Movement {
  id: string;
  warehouseId: string;
  productId: string;
  quantity: number;
  movementType: string;
  createdAt: string;
}

interface InventoryMovementData {
  movement: Movement;
  warehouse: { id: string; code: string; name: string } | undefined;
  product: { id: string; name: string; sku: string } | undefined;
}

export function InventoryMovementPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<InventoryMovementData | null>(null);

  preload(['document.movement_title', 'field.warehouse', 'field.product']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const movement = await api.get<Movement>(`/inventory/movements/${id}`);
      const [warehouses, products] = await Promise.all([
        api.get<Array<{ id: string; code: string; name: string }>>('/inventory/warehouses'),
        api.get<Array<{ id: string; name: string; sku: string }>>('/products/all'),
      ]);
      const warehouse = warehouses.find((w) => w.id === movement.warehouseId);
      const product = products.find((p) => p.id === movement.productId);

      setData({ movement, warehouse, product });
    })();
  }, [id]);

  if (!data) return <div className="empty-state">Loading…</div>;
  const { movement, warehouse, product } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.movement_title',
    documentNumber: movement.id.slice(0, 8).toUpperCase(),
    issuedAt: movement.createdAt,
    statusLabel: t(`movement_type.${movement.movementType}`),
    fields: [
      { label: t('field.warehouse'), value: warehouse ? `${warehouse.code} — ${warehouse.name}` : movement.warehouseId },
      { label: t('field.product'), value: product ? `${product.sku} — ${product.name}` : movement.productId },
    ],
    lines: [{ label: t(`movement_type.${movement.movementType}`), quantity: movement.quantity }],
  };

  return <PrintDocument doc={doc} />;
}
