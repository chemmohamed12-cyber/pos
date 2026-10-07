import { Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';

export interface IntegrationProviderView {
  code: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  version: string;
  status: 'available' | 'disabled';
  requiresModule: string | null;
}

/** Providers the platform ships today (the connector types the code already implements). */
const SEED: Array<Omit<IntegrationProviderView, 'status'>> = [
  { code: 'qr_store', nameEn: 'QR Store', nameAr: 'متجر QR', descriptionEn: 'Order intake and product reconciliation with the QR store.', descriptionAr: 'استقبال الطلبات ومطابقة الأصناف مع متجر QR.', version: '1', requiresModule: 'sales' },
];

/**
 * Authorization Foundation F4 / AZ-13 — the platform-owned Integration Catalog (Hybrid ownership model, CTO 2026-10-07):
 *  - XNEXUSTECH / control plane owns: provider definitions, connector versions, global availability, package/module gating — this service;
 *  - the Company owns: connections, credential references, mappings, activation, webhooks, sync state, operational logs (never stored here, never platform-owned).
 * Opening or closing a provider's availability is a platform capability (`platform.integration.manage`) and is audited in the platform chain.
 */
@Injectable()
export class IntegrationCatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntegrationCatalogService.name);

  constructor(
    private readonly platform: DataSource,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.seed();
    } catch (err) {
      this.logger.warn(`integration catalog seed skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async seed(): Promise<number> {
    let added = 0;
    for (const p of SEED) {
      const res = await this.platform.query(
        `INSERT INTO "integration_providers" ("code","nameEn","nameAr","descriptionEn","descriptionAr","version","status","requiresModule") VALUES ($1,$2,$3,$4,$5,$6,'available',$7) ON CONFLICT ("code") DO NOTHING RETURNING "code"`,
        [p.code, p.nameEn, p.nameAr, p.descriptionEn, p.descriptionAr, p.version, p.requiresModule],
      );
      added += res.length;
    }
    return added;
  }

  async list(): Promise<IntegrationProviderView[]> {
    return this.platform.query(`SELECT "code","nameEn","nameAr","descriptionEn","descriptionAr","version","status","requiresModule" FROM "integration_providers" ORDER BY "code"`);
  }

  /** Is a provider offered at all? (A Company additionally needs the provider's module in its package; that join happens where the Company plane consumes the catalog.) */
  async isAvailable(code: string): Promise<boolean> {
    const rows = await this.platform.query(`SELECT 1 FROM "integration_providers" WHERE "code" = $1 AND "status" = 'available'`, [code]);
    return rows.length > 0;
  }

  async setStatus(actorUserId: string, code: string, status: unknown): Promise<IntegrationProviderView> {
    if (status !== 'available' && status !== 'disabled') throw new NotFoundException('status must be available or disabled.');
    const before = (await this.list()).find((p) => p.code === code);
    if (!before) throw new NotFoundException(`Unknown integration provider: ${code}`);
    await this.platform.query(`UPDATE "integration_providers" SET "status" = $2, "updatedAt" = now() WHERE "code" = $1`, [code, status]);
    await this.audit.record({ actorUserId, organizationId: null, action: 'platform.integration.availability_changed', resource: 'integration_provider', resourceId: code, result: 'success', correlationId: null, before: { status: before.status }, after: { status } });
    return (await this.list()).find((p) => p.code === code)!;
  }
}
