import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DatabaseRegistry } from './database-registry.entity';
import { DatabaseCredential } from './database-credential.entity';
import { DatabaseCredentialCipherService } from './database-credential-cipher.service';
import { DatabaseConfig } from '../configuration/app-config.service';

/**
 * Multi-Company Phase 3 V7, Area 3 (Database Registry). `companyId →
 * {host, port, database name, status}`, with credentials held in the
 * separate `DatabaseCredential` table. The normal read path
 * (`findByCompanyId`) returns only the `DatabaseRegistry` row — which has
 * no credential column at all, so there is nothing to leak by
 * construction. `getDecryptedCredential` is the one deliberate exception
 * path, named distinctly so it is never reached by accident; nothing in
 * this service calls it internally.
 */
@Injectable()
export class DatabaseRegistryService {
  constructor(
    @InjectRepository(DatabaseRegistry) private readonly registries: Repository<DatabaseRegistry>,
    @InjectRepository(DatabaseCredential) private readonly credentials: Repository<DatabaseCredential>,
    private readonly cipher: DatabaseCredentialCipherService,
  ) {}

  async register(
    data: Pick<DatabaseRegistry, 'companyId' | 'host' | 'port' | 'databaseName' | 'status'>,
    plaintextCredential: string,
  ): Promise<DatabaseRegistry> {
    const registry = await this.registries.save(this.registries.create(data));
    const encryptedValue = this.cipher.encrypt(plaintextCredential);
    await this.credentials.save(this.credentials.create({ databaseRegistryId: registry.id, encryptedValue }));
    return registry;
  }

  /** The normal registry read path. Returns no credential — `DatabaseRegistry` has no such column. */
  async findByCompanyId(companyId: string): Promise<DatabaseRegistry | null> {
    return this.registries.findOne({ where: { companyId } });
  }

  async findById(id: string): Promise<DatabaseRegistry | null> {
    return this.registries.findOne({ where: { id } });
  }

  /** Added for Area 9's Company Connection Manager — every Company whose database is provisioned and reachable, the sweep set for a company-scoped background job. */
  async findAllActive(): Promise<DatabaseRegistry[]> {
    return this.registries.find({ where: { status: 'ACTIVE' } });
  }

  /** Added for Area 4's use — plain status write, no semantics/validation of its own (status's allowed values are still not this Area's decision). */
  async markStatus(id: string, status: string): Promise<DatabaseRegistry> {
    await this.registries.update({ id }, { status });
    const updated = await this.findById(id);
    if (!updated) {
      throw new Error(`DatabaseRegistry not found after status update: ${id}`);
    }
    return updated;
  }

  /** Added for Area 4's retry path — a repeat `provision()` call updates the connection target to what THIS attempt specifies, rather than silently reusing a stale value from a prior failed attempt. */
  async updateConnection(id: string, data: Pick<DatabaseRegistry, 'host' | 'port' | 'databaseName'>): Promise<DatabaseRegistry> {
    await this.registries.update({ id }, data);
    const updated = await this.findById(id);
    if (!updated) {
      throw new Error(`DatabaseRegistry not found after connection update: ${id}`);
    }
    return updated;
  }

  /** Deliberate exception path — not called by anything else in this service. Only for a caller that must open a real connection. */
  async getDecryptedCredential(databaseRegistryId: string): Promise<string | null> {
    const row = await this.credentials.findOne({ where: { databaseRegistryId } });
    if (!row) return null;
    return this.cipher.decrypt(row.encryptedValue);
  }

  /**
   * Backup/DR Architecture V1 (2026-09-24, Track D §Step 5 — Option A,
   * decided). A SECOND deliberate exception path, narrow and single-
   * purpose: composes the exact `DatabaseConfig` shape `PgDumpRunnerService`
   * already accepts, for a caller (`CompanyBackupService`/
   * `CompanyRestoreService`) that needs to shell out `pg_dump`/`pg_restore`
   * against a Company's own database. Deliberately added HERE, not as a
   * new capability on `CompanyConnectionManagerService` — that service's
   * contract is "give me a live pooled connection," never raw secrets;
   * mixing the two would widen an already-correct, already-proven contract
   * for a use case (external-process credentials) it was never meant to
   * serve. The caller MUST NOT log, persist, or place the returned value
   * in any audit record — the only permitted destination is a `PGPASSWORD`
   * environment variable for a child process, exactly as
   * `PgDumpRunnerService` already does for the platform DB.
   */
  async getConnectionConfigForCompany(companyId: string): Promise<DatabaseConfig> {
    const registry = await this.findByCompanyId(companyId);
    if (!registry) {
      throw new NotFoundException(`Company ${companyId} has no DatabaseRegistry entry — never provisioned.`);
    }
    const plaintextCredential = await this.getDecryptedCredential(registry.id);
    if (!plaintextCredential) {
      throw new NotFoundException(`Company ${companyId}'s DatabaseRegistry has no stored credential.`);
    }
    const { username, password } = JSON.parse(plaintextCredential) as { username: string; password: string };
    return { host: registry.host, port: registry.port, username, password, database: registry.databaseName };
  }
}
