import { CustomerFacingOrderStatus } from '../domain/order-status-contract';

export interface StoreIdentity {
  externalStoreId: string;
  storeName: string;
}

export interface ConnectorTestResult {
  ok: boolean;
  identity?: StoreIdentity;
  error?: string;
}

export interface PublishProductPayload {
  daiiProductId: string;
  externalProductId: string | null; // null on first publish — the adapter returns the id the external system assigns
  sku: string;
  name: string;
  status: 'draft' | 'active' | 'discontinued';
  price: string;
}

export interface PublishAvailabilityPayload {
  externalProductId: string;
  sku: string;
  available: number;
}

export interface PublishOrderStatusPayload {
  externalOrderId: string;
  status: CustomerFacingOrderStatus;
}

/**
 * External Integrations — CTO directive §9/§20: the one interface every
 * connector type implements, so `IntegrationsService` never branches on
 * "if QR then... else if shippingProvider then...". Config/credential
 * are passed in per-call (never cached in the adapter instance) since a
 * single adapter instance is shared across every connector of that type.
 */
export interface StoreConnectorAdapter {
  testConnection(config: Record<string, unknown>, credential: string): Promise<ConnectorTestResult>;
  publishProduct(config: Record<string, unknown>, credential: string, payload: PublishProductPayload): Promise<{ externalProductId: string }>;
  publishAvailability(config: Record<string, unknown>, credential: string, payload: PublishAvailabilityPayload): Promise<void>;
  publishOrderStatus(config: Record<string, unknown>, credential: string, payload: PublishOrderStatusPayload): Promise<void>;
}
