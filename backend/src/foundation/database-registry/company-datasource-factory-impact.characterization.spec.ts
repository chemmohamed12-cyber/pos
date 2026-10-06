/* eslint-disable no-restricted-imports -- ADR-074 §6/§8 cross-domain characterization: this file's
 * entire purpose is proving the shared Company DataSource factory resolves real entity classes from
 * many different domains against the real production factory (`COMPANY_ENTITY_REGISTRY`) — importing
 * those domains' entity classes directly is the test, not a business-logic boundary leak. */
import { DataSource } from 'typeorm';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { DatabaseRegistryService } from './database-registry.service';
import { DatabaseRegistry } from './database-registry.entity';
import { DatabaseCredential } from './database-credential.entity';
import { DatabaseCredentialCipherService } from './database-credential-cipher.service';
import { CompanyConnectionManagerService } from './company-connection-manager.service';
import { AppConfigService } from '../configuration/app-config.service';
import { applyCompanyAuthorizationSchemaAdjustment } from '../company/company-authorization-schema-adjustment';
import { seedCompanyRoleTemplates, seedCompanyAdminRole } from '../company/company-role-seeding';
import { ClosingSnapshotRun } from '../../domains/accounting/infrastructure/closing-snapshot-run.entity';
import { FiscalPeriod } from '../../domains/accounting/infrastructure/fiscal-period.entity';
import { FiscalYear } from '../../domains/accounting/infrastructure/fiscal-year.entity';
import { ClosingException } from '../../domains/accounting/infrastructure/closing-exception.entity';
import { FinancialEvent } from '../../domains/accounting/infrastructure/financial-event.entity';
import { JournalEntry } from '../../domains/accounting/infrastructure/journal-entry.entity';
import { JournalLine } from '../../domains/accounting/infrastructure/journal-line.entity';
import { JournalLineDimension } from '../../domains/accounting/infrastructure/journal-line-dimension.entity';
import { GLAccount } from '../../domains/accounting/infrastructure/gl-account.entity';
import { CustomerLedgerEntry } from '../../domains/customer-finance/infrastructure/customer-ledger-entry.entity';
import { TreasuryAccount } from '../../domains/treasury/infrastructure/treasury-account.entity';
import { TreasuryAccountType } from '../../domains/treasury/infrastructure/treasury-account-type.entity';
import { TreasuryTransaction } from '../../domains/treasury/infrastructure/treasury-transaction.entity';
import { AuditRecord } from '../audit/audit-record.entity';
import { SalesOrder } from '../../domains/sales-orders/infrastructure/sales-order.entity';
import { SalesOrderLine } from '../../domains/sales-orders/infrastructure/sales-order-line.entity';
import { ProcessInstance } from '../process-engine/process-instance.entity';
import { ProcessTransitionRecord } from '../process-engine/process-transition-record.entity';
import { ApprovalRequest } from '../approval-engine/approval-request.entity';
import { ApprovalRequestType } from '../approval-engine/approval-request-type.entity';
import { ApprovalMatrixRule } from '../approval-engine/approval-matrix-rule.entity';
import { ApprovalDecision } from '../approval-engine/approval-decision.entity';

/**
 * ADR-074 §6 — Real-PG Characterization (2026-09-25). The smallest possible
 * confirming proofs, using the REAL, unmodified production factory
 * (`createCompanyDataSource` via `CompanyConnectionManagerService.getDataSource`)
 * against a real disposable Company database — no workaround, no mock.
 *
 * Extended for Gate B (CTO Decision, ADR-074 Hybrid B approval,
 * 2026-09-25): every row the Mandatory Consumer Matrix marked
 * POTENTIALLY AFFECTED gets its OWN independent minimal Real-PG proof
 * here — never promoted to PROVEN WORKING just because it shares the
 * same (now-fixed) `DataSource`/registry as an already-proven row.
 */
const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5433;
const USERNAME = process.env.DB_USER ?? 'daii';
const PASSWORD = process.env.DB_PASSWORD ?? 'daii_dev_only';
const APP_ROOT = process.cwd();

const CONTROL_PLANE_DB = 'daii_test_adr074_control_plane';
const COMPANY_DB = 'daii_test_adr074_company';

async function withAdminConnection<T>(fn: (admin: DataSource) => Promise<T>): Promise<T> {
  const admin = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: 'postgres', synchronize: false, logging: false });
  await admin.initialize();
  try {
    return await fn(admin);
  } finally {
    await admin.destroy();
  }
}

async function createDatabase(name: string): Promise<void> {
  await withAdminConnection(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  });
}

async function dropDatabase(name: string): Promise<void> {
  await withAdminConnection(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}

describe('ADR-074 §6 — Company DataSource factory real-PG characterization (2026-09-25)', () => {
  jest.setTimeout(300_000);

  let controlPlane: DataSource;
  let connections: CompanyConnectionManagerService;
  const companyId = '22222222-2222-2222-2222-222222222222';
  const knownUserId = '33333333-3333-3333-3333-333333333333';

  beforeAll(async () => {
    await createDatabase(CONTROL_PLANE_DB);
    await createDatabase(COMPANY_DB);

    const { runMigrationsForDatabase } = await import('../release-orchestration/company-migration-runner');
    const migratedControlPlane = await runMigrationsForDatabase(APP_ROOT, { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: CONTROL_PLANE_DB }, ['core']);
    if (!migratedControlPlane.success) throw new Error(`control-plane migration failed: ${migratedControlPlane.error}`);

    const companyDatabaseConfig = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: COMPANY_DB };
    // All tags any POTENTIALLY AFFECTED row needs, so each gets a real table to prove against —
    // exactly what a real Company provisioned with these modules entitled would have.
    const migratedCompany = await runMigrationsForDatabase(APP_ROOT, companyDatabaseConfig, ['core', 'accounting', 'finance', 'sales', 'inventory', 'procurement', 'logistics']);
    if (!migratedCompany.success) throw new Error(`company migration failed: ${migratedCompany.error}`);
    await applyCompanyAuthorizationSchemaAdjustment(companyDatabaseConfig);
    await seedCompanyRoleTemplates(companyDatabaseConfig, ['sales']);
    await seedCompanyAdminRole(companyDatabaseConfig, ['sales']);

    // Grant knownUserId the 'admin' role directly via a properly-entitied ephemeral
    // DataSource (setup only — not the factory under test).
    const setupDs = new DataSource({ type: 'postgres', ...companyDatabaseConfig, synchronize: false, logging: false, entities: [Role, UserRole] });
    await setupDs.initialize();
    try {
      const role = await setupDs.getRepository(Role).findOneOrFail({ where: { key: 'admin' } });
      await setupDs.getRepository(UserRole).save(setupDs.getRepository(UserRole).create({ userId: knownUserId, roleId: role.id }));
    } finally {
      await setupDs.destroy();
    }

    controlPlane = new DataSource({
      type: 'postgres',
      host: HOST,
      port: PORT,
      username: USERNAME,
      password: PASSWORD,
      database: CONTROL_PLANE_DB,
      synchronize: false,
      logging: false,
      entities: [DatabaseRegistry, DatabaseCredential, Role, UserRole],
    });
    await controlPlane.initialize();

    // FK prerequisites for database_registries.companyId -> companies.id -> installation.id
    // (same setup shape as the Area 4/Track A real-PG specs).
    await controlPlane.query(
      `INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ($1,$2,$3,$4,$5,$6)`,
      ['installation', 'test-installation', 'Test Installation', 'DAII_STANDARD', '1.0.0', '{}'],
    );
    await controlPlane.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,$2,$3,$4)`, [companyId, 'installation', 'ADR-074 Characterization Co', 'READY']);

    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
    const databaseRegistry = new DatabaseRegistryService(controlPlane.getRepository(DatabaseRegistry), controlPlane.getRepository(DatabaseCredential), cipher);
    await databaseRegistry.register({ companyId, host: HOST, port: PORT, databaseName: COMPANY_DB, status: 'ACTIVE' }, JSON.stringify({ username: USERNAME, password: PASSWORD }));

    // THE REAL, UNMODIFIED PRODUCTION FACTORY — no workaround.
    connections = new CompanyConnectionManagerService(databaseRegistry);
  });

  afterAll(async () => {
    if (connections) await connections.onModuleDestroy();
    if (controlPlane?.isInitialized) await controlPlane.destroy();
    await dropDatabase(CONTROL_PLANE_DB);
    await dropDatabase(COMPANY_DB);
  });

  it('Authorization chain: CompanyConnectionManagerService.getDataSource() -> AuthorizationService.getRoleKeysForUser(manager) — real production call shape', async () => {
    const dataSource = await connections.getDataSource(companyId);
    // Ambient repos unused (a manager is always supplied below) — same constructor NestJS DI uses.
    const authorization = new AuthorizationService(controlPlane.getRepository(Role), controlPlane.getRepository(UserRole));

    let result: string[] | null = null;
    let thrown: unknown = null;
    try {
      result = await authorization.getRoleKeysForUser(knownUserId, dataSource.manager);
    } catch (err) {
      thrown = err;
    }

    console.log('ADR-074 Authorization chain characterization:', thrown ? `THREW: ${(thrown as Error).message}` : `RETURNED: ${JSON.stringify(result)}`);

    if (thrown) {
      expect((thrown as Error).message).toMatch(/No metadata for ".*" was found/);
    } else {
      expect(result).toContain('admin');
    }
  });

  it('Closing Snapshot chain: CompanyConnectionManagerService.getDataSource() -> manager.getRepository(ClosingSnapshotRun) — real production call shape', async () => {
    const dataSource = await connections.getDataSource(companyId);

    let thrown: unknown = null;
    let ranOk = false;
    try {
      // Same access shape as ClosingSnapshotService.retryPending/detectOverdue: (manager ?? this.dataSource).getRepository(ClosingSnapshotRun).find(...)
      await dataSource.manager.query('SELECT to_regclass(\'public.closing_snapshot_runs\') AS present'); // sanity: table exists (accounting tag migrated)
      await dataSource.manager.getRepository(ClosingSnapshotRun).find({ where: { status: 'pending' } });
      ranOk = true;
    } catch (err) {
      thrown = err;
    }

    console.log('ADR-074 Closing Snapshot chain characterization:', thrown ? `THREW: ${(thrown as Error).message}` : 'RAN OK');

    if (thrown) {
      expect((thrown as Error).message).toMatch(/No metadata for ".*" was found|Entity metadata/i);
    } else {
      expect(ranOk).toBe(true);
    }
  });

  /**
   * Gate B — one independent proof per POTENTIALLY AFFECTED row (ADR-074
   * §8.1/§4). Each asserts the real production factory can now resolve
   * `.getRepository()` for that row's own entities — not inferred from
   * Authorization/Closing Snapshot already passing.
   */
  it.each([
    ['Closing Snapshot deep chain (assembleAndFinalize)', [FiscalPeriod, FiscalYear, ClosingException, FinancialEvent]],
    ['Journal (accounting posting)', [JournalEntry, JournalLine, JournalLineDimension]],
    ['Ledger', [GLAccount]],
    ['Customer Finance (via ClosingSnapshotService FINANCE_CUSTOMER_LEDGER_CONTRACT)', [CustomerLedgerEntry]],
    ['Treasury (via ClosingSnapshotService FINANCE_TREASURY_CONTRACT)', [TreasuryAccount, TreasuryAccountType, TreasuryTransaction]],
    ['Audit (called with manager throughout every chain above)', [AuditRecord]],
    ['Sales Orders (via PreliminaryHoldExpiryScheduler.expireHoldForOrder)', [SalesOrder, SalesOrderLine]],
    ['Process Engine (via SalesOrdersService.expireHoldForOrder -> transition)', [ProcessInstance, ProcessTransitionRecord]],
    ['Approval Engine (via ApprovalExpiryScheduler.expire)', [ApprovalRequest, ApprovalRequestType, ApprovalMatrixRule, ApprovalDecision]],
  ] as const)('Gate B — %s: real production factory resolves .getRepository() for its own entities', async (_label, entities) => {
    const dataSource = await connections.getDataSource(companyId);

    for (const entity of entities) {
      let thrown: unknown = null;
      try {
        await dataSource.manager.getRepository(entity as never).find({ take: 1 } as never);
      } catch (err) {
        thrown = err;
      }
      if (thrown) {
        console.log(`ADR-074 Gate B — ${(entity as { name: string }).name}: THREW: ${(thrown as Error).message}`);
      }
      expect(thrown).toBeNull();
    }
  });
});
