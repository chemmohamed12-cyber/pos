/**
 * Vehicle Driver Workspace, Stage C / C2 - the PURE derivation of per-line delivery progress. "Partially delivered" is never stored and is not a shipment state (D-1): it is
 * derived here from the shipment's frozen lines and the append-only per-line events, so every screen and every guard reads the same answer.
 */
export interface ProgressLine {
  id: string;
  productId: string;
  quantity: number;
}
export interface ProgressEvent {
  shipmentLineId: string;
  kind: 'delivered' | 'returned';
  quantity: number;
}

export interface LineProgress {
  shipmentLineId: string;
  productId: string;
  shipped: number;
  delivered: number;
  returned: number;
  outstanding: number;
}

/**
 * none       - no event recorded (the legacy "whole shipment" flow applies);
 * in_progress- events exist and something is still outstanding;
 * complete   - every line fully delivered;
 * partial    - every line is accounted for (delivered + returned == shipped) but some units came back.
 */
export type DeliveryProgressStatus = 'none' | 'in_progress' | 'complete' | 'partial';

export interface ShipmentDeliveryProgress {
  status: DeliveryProgressStatus;
  lines: LineProgress[];
}

export function computeDeliveryProgress(lines: readonly ProgressLine[], events: readonly ProgressEvent[]): ShipmentDeliveryProgress {
  const rows: LineProgress[] = lines.map((l) => {
    const delivered = events.filter((e) => e.shipmentLineId === l.id && e.kind === 'delivered').reduce((t, e) => t + e.quantity, 0);
    const returned = events.filter((e) => e.shipmentLineId === l.id && e.kind === 'returned').reduce((t, e) => t + e.quantity, 0);
    return { shipmentLineId: l.id, productId: l.productId, shipped: l.quantity, delivered, returned, outstanding: l.quantity - delivered - returned };
  });
  if (events.length === 0) return { status: 'none', lines: rows };
  if (rows.some((r) => r.outstanding > 0)) return { status: 'in_progress', lines: rows };
  return { status: rows.some((r) => r.returned > 0) ? 'partial' : 'complete', lines: rows };
}
