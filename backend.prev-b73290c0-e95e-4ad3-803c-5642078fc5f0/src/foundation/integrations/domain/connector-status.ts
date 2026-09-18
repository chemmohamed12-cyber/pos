/**
 * External Integrations (Control Center) — CTO directive "Daii ↔ QR Store
 * Integration & Pairing Architecture" §9. Reusable across every future
 * connector type (QR Store first; shipping providers/payment gateways/
 * marketplaces/accounting systems later), never a QR-specific status set.
 */
export type ConnectorStatus = 'pending' | 'connected' | 'error' | 'disconnected';

const ALLOWED_TRANSITIONS: Record<ConnectorStatus, ConnectorStatus[]> = {
  pending: ['connected', 'error', 'disconnected'],
  connected: ['error', 'disconnected'],
  error: ['connected', 'disconnected'],
  disconnected: ['pending', 'connected'],
};

export function canTransitionConnectorStatus(from: ConnectorStatus, to: ConnectorStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
