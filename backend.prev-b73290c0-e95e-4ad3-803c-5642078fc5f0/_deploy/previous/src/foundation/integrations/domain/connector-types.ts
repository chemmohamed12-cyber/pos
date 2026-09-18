/**
 * External Integrations (Control Center) — CTO directive §9: "Do NOT
 * create a QR-specific hardcoded configuration inside business modules...
 * the design must allow future connectors (shipping providers, payment
 * gateways, marketplaces, accounting systems) without redesigning the
 * Control Center." Adding a connector type is: (1) add its key here,
 * (2) implement `StoreConnectorAdapter`, (3) register it in
 * `IntegrationsService`'s adapter map — never a schema migration.
 */
export const CONNECTOR_TYPES = ['qr_store'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export function isValidConnectorType(value: string): value is ConnectorType {
  return (CONNECTOR_TYPES as readonly string[]).includes(value);
}
