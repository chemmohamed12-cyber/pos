import { DataSource } from 'typeorm';
import { DatabaseConfig } from '../configuration/app-config.service';
import { COMPANY_ENTITY_REGISTRY } from './company-entity-registry';

/**
 * Multi-Company Phase 3 V7, Area 9 (Background Jobs — Gap Fix). A fresh,
 * unpooled-by-itself `DataSource` for ONE Company's own database. Extracted
 * into its own module — rather than inlined in `CompanyConnectionManagerService`
 * — purely so tests can substitute a fake DataSource-like object via
 * `jest.mock('./company-datasource-factory', ...)`, the same pattern already
 * used by `createMigrationDataSource` (`foundation/release/migration-datasource.ts`)
 * and by `DatabaseProvisioningService`'s own ephemeral health-check DataSource.
 * `synchronize: false` — this never mutates schema, only runtime queries.
 *
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). `entities:
 * COMPANY_ENTITY_REGISTRY` — real-Postgres evidence (ADR-074 §1/§6) proved
 * this `DataSource`, with no entities registered, could never resolve
 * `.getRepository()`/`manager.getRepository()` for ANY entity, breaking
 * Authorization/Permission, Closing Snapshot recovery, and Track A's
 * membership grant path. One shared registry, assembled from each domain's
 * own manifest (`*-company-entities.ts`) — NOT a hand-typed list here, and
 * NOT a separate `DataSource`/cache per domain: still exactly one cached
 * `DataSource` per Company, unchanged from
 * `CompanyConnectionManagerService`'s existing contract.
 */
export function createCompanyDataSource(database: DatabaseConfig): DataSource {
  return new DataSource({
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    synchronize: false,
    logging: false,
    entities: COMPANY_ENTITY_REGISTRY,
  });
}
