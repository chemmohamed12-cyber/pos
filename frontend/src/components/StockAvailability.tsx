import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * PRC-01 (2026-10-05) — stock visibility for procurement screens. Read-only: it shows what the OFFICIAL stock endpoint already
 * reports for a (warehouse, product) pair — `GET /inventory/stock` → `{ onHand, reserved, available }` derived from the stock
 * movements / reservations — and never computes or stores anything itself. It is information for the buyer, not a gate.
 * "On Order" (open PO quantity) has no model today and is deliberately NOT shown here.
 */
export interface StockFigures {
  onHand: number;
  reserved: number;
  available: number;
}
export type StockState = StockFigures | 'unavailable' | undefined;

/** Fetches the official figures for each distinct product in one warehouse. A failed lookup (e.g. no inventory entitlement) is `'unavailable'`, never an error banner. */
export function useStockAvailability(warehouseId: string | null | undefined, productIds: string[]): Record<string, StockState> {
  const [state, setState] = useState<Record<string, StockState>>({});
  const ids = [...new Set(productIds)].sort();
  const key = `${warehouseId ?? ''}|${ids.join(',')}`;

  useEffect(() => {
    let cancelled = false;
    if (!warehouseId || ids.length === 0) {
      setState({});
      return;
    }
    Promise.allSettled(ids.map((id) => api.get<StockFigures>(`/inventory/stock?warehouseId=${warehouseId}&productId=${id}`))).then((results) => {
      if (cancelled) return;
      const next: Record<string, StockState> = {};
      ids.forEach((id, i) => {
        const r = results[i];
        next[id] = r.status === 'fulfilled' ? r.value : 'unavailable';
      });
      setState(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

/** One table cell: on-hand / reserved / available (available turns red when negative). */
export function StockCell({ stock }: { stock: StockState }) {
  if (stock === undefined) return <td style={{ opacity: 0.5 }}>…</td>;
  if (stock === 'unavailable') return <td style={{ opacity: 0.5 }}>—</td>;
  return (
    <td style={{ whiteSpace: 'nowrap' }}>
      {stock.onHand} / {stock.reserved} /{' '}
      <strong style={{ color: stock.available < 0 ? '#a3262d' : undefined }}>{stock.available}</strong>
    </td>
  );
}
