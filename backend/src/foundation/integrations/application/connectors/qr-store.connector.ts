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
 * Security Assurance Gate — Track S3/S19 finding, AUDIT-SEC-17 (2026-09-08),
 * closed here after the explicit investigation the directive required
 * BEFORE any fix: `config.apiUrl` is fully operator-supplied, admin-only
 * (`IntegrationsController`'s class-level `@RequireRole('admin')`),
 * immutable after connector creation (no update route exists — only
 * `createConnector` ever sets it), validated only as `@IsObject()` with
 * no shape/host constraint at the DTO layer. A blanket private-IP/
 * loopback block was explicitly rejected: ADR-019 supports genuine
 * on-premise/LAN deployments where a partner system's `apiUrl` pointing
 * at an RFC1918 address is the NORMAL case, not an attack — blocking
 * that would break real customers, not just attackers.
 *
 * What IS blocked: the cloud instance-metadata address(es)
 * (`169.254.169.254` — AWS/GCP/Azure's IMDS endpoint, and the wider
 * IPv6 link-local range `fe80::/10` it's drawn from) — there is no
 * legitimate integration target on a metadata service; its only
 * reachable content is the HOST'S OWN cloud credentials/instance
 * identity, the single highest-value SSRF escalation this surface could
 * reach. This is a narrow, specific denylist, not a general network
 * policy — it protects the one thing with zero legitimate use case
 * while leaving every genuine on-prem/LAN deployment shape untouched.
 */
const BLOCKED_HOSTS = new Set(['169.254.169.254', '[fd00:ec2::254]']); // fd00:ec2::254 — AWS's IPv6 IMDS address

function assertNotMetadataAddress(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return; // an unparseable URL fails at fetch() anyway — not this check's job to validate general shape
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.startsWith('fe80:') || host === '[fe80::a9fe:a9fe]') {
    throw new Error(`Refusing to contact "${host}" — cloud instance-metadata addresses can never be a legitimate connector target.`);
  }
}

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
    const fullUrl = `${apiUrl.replace(/\/$/, '')}${path}`;
    assertNotMetadataAddress(fullUrl); // AUDIT-SEC-17 — see the function's own doc comment for scope/rationale
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(fullUrl, {
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
