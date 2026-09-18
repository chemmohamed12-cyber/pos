import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LimitProfile } from './limit-profile.entity';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { AuditService } from '../audit/audit.service';

/**
 * Limit Engine — ERP Foundation P5. Seeds `limit_profiles` from every
 * authored module's manifest `limit_keys[]` (`LIMIT_INTEGRATION_CONTRACT.md`
 * §2: "Seeded from the enabled Edition's defaults at module-enable
 * time... never authored by hand per installation unless explicitly
 * overridden").
 *
 * Deliberately NOT `ConfigRegistrySeeder`'s full-resync-every-boot
 * pattern: `limit_profiles` combines registry metadata AND the live
 * setting in one row (unlike Config's clean key/value split), so
 * re-running this on every boot must never clobber an admin's manual
 * override of `maxValue`. This seeder only ever INSERTS a row that does
 * not yet exist — for a key whose manifest `default` is non-null, and
 * only once. It never updates or deletes an existing row, and it never
 * creates a row for a `default: null` key (that IS the fail-open
 * unlimited state — nothing to seed). A key's REAL per-Edition default
 * (as opposed to today's single flat manifest default) is P6's job, at
 * "enable Module" time, per `ERP_FOUNDATION_PHASE_PLAN.md`'s P6 section
 * — this seeder is the P5-scoped subset of that: boot-time, from the
 * manifest, idempotent, additive-only.
 */
@Injectable()
export class LimitRegistrySeeder {
  private readonly logger = new Logger(LimitRegistrySeeder.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async sync(): Promise<{ added: string[] }> {
    const repo = this.dataSource.getRepository(LimitProfile);
    const existing = await repo.find();
    const existingKeys = new Set(existing.map((p) => p.limitKey));
    const added: string[] = [];

    for (const code of MODULE_REGISTRY.authoredModuleCodes()) {
      const manifest = MODULE_REGISTRY.manifest(code);
      if (!manifest) continue;
      for (const lk of manifest.limit_keys) {
        if (lk.default === null) continue; // fail-open by absence — nothing to seed
        if (existingKeys.has(lk.key)) continue; // never clobber an existing (possibly admin-adjusted) row

        await repo.save(repo.create({ limitKey: lk.key, moduleCode: code, unit: lk.unit, maxValue: lk.default }));
        added.push(lk.key);
      }
    }

    if (added.length > 0) {
      await this.audit.record({
        actorUserId: null,
        organizationId: null,
        action: 'limit.registry.seeded',
        resource: 'limit_profiles',
        resourceId: null,
        result: 'success',
        correlationId: null,
        after: { added },
      });
      this.logger.log(`limit_profiles seeded: +${added.length} (${added.join(', ')})`);
    }
    return { added };
  }
}
