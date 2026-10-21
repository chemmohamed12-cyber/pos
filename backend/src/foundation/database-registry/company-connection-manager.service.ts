import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DatabaseRegistry } from './database-registry.entity';
import { DatabaseRegistryService } from './database-registry.service';
import { createCompanyDataSource } from './company-datasource-factory';
import { CompanySchemaAdmission } from './company-schema-admission';

export class CompanyDatabaseNotProvisionedError extends Error {}
export class CompanyDatabaseNotActiveError extends Error {}

interface CachedConnection {
  dataSource: DataSource;
  fingerprint: string;
}

/**
 * Multi-Company Phase 3 V7, Area 9 (Background Jobs — Gap Fix,
 * 2026-09-22). The piece Area 9's own characterization found missing:
 * `DatabaseRegistryService` knows WHERE a Company's database is but never
 * opens a connection to it; `DatabaseProvisioningService` opens one, but
 * only ephemerally, for the lifetime of a single `provision()` call. This
 * is the reusable, pooled version a recurring background sweep needs —
 * "explicit companyId → validated Company → this Company's own
 * DataSource", never an ambient/default connection.
 *
 * One cached `DataSource` per Company, keyed by `companyId` and
 * invalidated if the registry's connection target changes underneath it
 * (`updateConnection`, Area 4's retry path). A Company whose database is
 * not `'ACTIVE'` is refused outright — there is no silent fallback to any
 * other connection, ambient or otherwise (Area 21's continuous isolation
 * gate: an operation not authorized for Company A must never even
 * consider Company B's — or the platform's own — database).
 */
@Injectable()
export class CompanyConnectionManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(CompanyConnectionManagerService.name);
  private readonly cache = new Map<string, CachedConnection>();

  constructor(
    private readonly databaseRegistry: DatabaseRegistryService,
    /** 1.1.12: refuses (503 COMPANY_SCHEMA_BEHIND) a Company whose schema is behind the running build, before any caller can query it. */
    @Optional() private readonly schemaAdmission?: CompanySchemaAdmission,
  ) {}

  /** Every Company whose database is provisioned and marked reachable — the sweep set for a company-scoped background job. */
  async listActiveCompanyIds(): Promise<string[]> {
    const active = await this.databaseRegistry.findAllActive();
    return active.map((r) => r.companyId);
  }

  /** The Company a pooled `DataSource` belongs to (identity lookup in this manager's own cache), or `null` for any other DataSource — including the ambient/platform one. */
  companyIdOf(dataSource: DataSource): string | null {
    for (const [companyId, cached] of this.cache) {
      if (cached.dataSource === dataSource) return companyId;
    }
    return null;
  }

  /**
   * The control-plane registry row only — no Company database is touched. Lets a caller read it concurrently with other control-plane checks and hand it back to
   * `getDataSource` (which still refuses anything but an ACTIVE registry and still opens the Company connection only when called).
   */
  readRegistry(companyId: string): Promise<DatabaseRegistry | null> {
    return this.databaseRegistry.findByCompanyId(companyId);
  }

  /** A live, pooled `DataSource` connected to ONE Company's own database. Never the ambient/platform connection. */
  async getDataSource(companyId: string, preloadedRegistry?: DatabaseRegistry | null): Promise<DataSource> {
    const registry = preloadedRegistry !== undefined ? preloadedRegistry : await this.databaseRegistry.findByCompanyId(companyId);
    if (!registry) {
      throw new CompanyDatabaseNotProvisionedError(`Company ${companyId} has no DatabaseRegistry entry — never provisioned.`);
    }
    if (registry.status !== 'ACTIVE') {
      throw new CompanyDatabaseNotActiveError(`Company ${companyId}'s database is '${registry.status}', not 'ACTIVE' — refusing to connect.`);
    }

    const fingerprint = `${registry.host}:${registry.port}:${registry.databaseName}`;
    const cached = this.cache.get(companyId);
    if (cached && cached.fingerprint === fingerprint && cached.dataSource.isInitialized) {
      if (this.schemaAdmission) await this.schemaAdmission.assertCurrent(companyId, cached.dataSource);
      return cached.dataSource;
    }
    if (cached) {
      await this.destroyQuietly(cached.dataSource);
      this.cache.delete(companyId);
    }

    const plaintextCredential = await this.databaseRegistry.getDecryptedCredential(registry.id);
    if (!plaintextCredential) {
      throw new CompanyDatabaseNotProvisionedError(`Company ${companyId}'s DatabaseRegistry has no stored credential.`);
    }
    const { username, password } = JSON.parse(plaintextCredential) as { username: string; password: string };

    const dataSource = createCompanyDataSource({ host: registry.host, port: registry.port, username, password, database: registry.databaseName });
    await dataSource.initialize();
    this.cache.set(companyId, { dataSource, fingerprint });
    if (this.schemaAdmission) await this.schemaAdmission.assertCurrent(companyId, dataSource);
    return dataSource;
  }

  async onModuleDestroy(): Promise<void> {
    for (const { dataSource } of this.cache.values()) {
      await this.destroyQuietly(dataSource);
    }
    this.cache.clear();
  }

  private async destroyQuietly(dataSource: DataSource): Promise<void> {
    if (!dataSource.isInitialized) return;
    try {
      await dataSource.destroy();
    } catch (err) {
      this.logger.warn(`Failed to cleanly close a Company DataSource: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
