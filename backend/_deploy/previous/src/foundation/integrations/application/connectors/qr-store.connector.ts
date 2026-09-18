import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectorTestResult,
  PublishAvailabilityPayload,
  PublishOrderStatusPayload,
  PublishProductPayload,
  StoreConnectorAdapter,
} from '../store-connector-adapter';

const REQUEST_TIMEOUT_MS = 8000;

/**
 * QR Store connector — CTO directive "Daii <-> QR Store Integration &
 * Pairing Architecture". `_source-audits/xnexus-website`'s own capability
 * audit (§2, `integration-gateway-engine.js`, classified C) already
 * establishes the right shape for this kind of link: inbound
 * shared-secret-verified calls plus outbound READ-THROUGH calls that
 * never cache/duplicate the other platform's state (that audit's own
 * ADR-039 lesson, learned from an earlier over-engineered webhook+cache
 * design in that codebase — directly avoided here by keeping Daii the
 * one source of truth that PUSHES, never a cache of QR's state).
 *
 * QR's own `apiUrl` + pairing token are per-connector config (never
 * hardcoded — CTO directive §18: "Production URLs must NEVER be
 * hardcoded"). QR is not required to be running for Daii's own code to
 * be correct: a network failure here is caught by the caller
 * (`IntegrationsService`) and logged to `IntegrationSyncLog` as
 * `failed`, never thrown out to crash an unrelated request (directive
 * §18: "the connector architecture and contracts can still be
 * implemented and tested without blocking the rest of Daii").
 *
 * The explicit contract QR's own integration endpoint must implement
 * (directive §13: "Build the QR Connector around explicit contracts",
 * not a generic sync engine):
 *   GET  {apiUrl}/api/integrations/daii/ping                       -> { storeId, storeName }
 *   POST {apiUrl}/api/integrations/daii/products                   -> { externalProductId }
 *   POST {apiUrl}/api/integrations/daii/availability                -> 204
 *   POST {apiUrl}/api/integrations/daii/orders/:externalOrderId/status -> 204
 * Every call carries `Authorization: Bearer <pairing token>`.
 */
@Injectable()
export class QrStoreConnector implements StoreConnectorAdapter {
  private readonly logger = new Logger(QrStoreConnector.name);

  private async call(apiUrl: string, path: string, credential: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}`, ...(init?.headers ?? {}) },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async testConnection(config: Record<string, unknown>, credential: string): Promise<ConnectorTestResult> {
    const apiUrl = String(config.apiUrl ?? '');
    if (!apiUrl) return { ok: false, error: 'apiUrl is not configured for this connector.' };
    try {
      const res = await this.call(apiUrl, '/api/integrations/daii/ping', credential);
      if (!res.ok) return { ok: false, error: `QR Store responded with HTTP ${res.status}.` };
      const body = (await res.json()) as { storeId?: string; storeName?: string };
      if (!body.storeId) return { ok: false, error: 'QR Store ping response did not include a storeId.' };
      return { ok: true, identity: { externalStoreId: body.storeId, storeName: body.storeName ?? body.storeId } };
    } catch (err) {
      this.logger.warn(`QR Store connection test failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }

  async publishProduct(
    config: Record<string, unknown>,
    credential: string,
    payload: PublishProductPayload,
  ): Promise<{ externalProductId: string }> {
    const apiUrl = String(config.apiUrl ?? '');
    const res = await this.call(apiUrl, '/api/integrations/daii/products', credential, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`QR Store rejected product publish (HTTP ${res.status}).`);
    const body = (await res.json()) as { externalProductId: string };
    return { externalProductId: body.externalProductId };
  }

  async publishAvailability(config: Record<string, unknown>, credential: string, payload: PublishAvailabilityPayload): Promise<void> {
    const apiUrl = String(config.apiUrl ?? '');
    const res = await this.call(apiUrl, '/api/integrations/daii/availability', credential, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`QR Store rejected availability publish (HTTP ${res.status}).`);
  }

  async publishOrderStatus(config: Record<string, unknown>, credential: string, payload: PublishOrderStatusPayload): Promise<void> {
    const apiUrl = String(config.apiUrl ?? '');
    const res = await this.call(apiUrl, `/api/integrations/daii/orders/${encodeURIComponent(payload.externalOrderId)}/status`, credential, {
      method: 'POST',
      body: JSON.stringify({ status: payload.status }),
    });
    if (!res.ok) throw new Error(`QR Store rejected order status publish (HTTP ${res.status}).`);
  }
}
