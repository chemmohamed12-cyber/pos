import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Membership } from '../company/membership.entity';
import { MembershipService } from '../company/membership.service';
import { Company } from '../company/company.entity';
import { CompanyService } from '../company/company.service';
import { User } from '../identity/user.entity';
import { UsersService } from '../identity/users.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseCredentialCipherService } from '../database-registry/database-credential-cipher.service';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { AppConfigService } from '../configuration/app-config.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { applyCompanyAuthorizationSchemaAdjustment } from '../company/company-authorization-schema-adjustment';
import { seedCompanyRoleTemplates, seedCompanyAdminRole } from '../company/company-role-seeding';

/**
 * Area 21 Retrofit Preparation (2026-09-25, CTO-authorized — Test Harness
 * Preparation, safe-to-build-now item). Extracts the two-real-Company
 * setup pattern this program has hand-written independently at least six
 * times already this session (ADR-074 Gate D, Area 14 §8 items 1-4,
 * `memberships-mine.real-pg.spec.ts`, etc.) into one reusable module, so
 * Area 21's own Retrofit real-PG proofs — once Retrofit is authorized —
 * start from `Implement → Run prebuilt proof`, not
 * `Implement → figure out what to test`.
 *
 * Deliberately does NOT touch, mock, or bypass any production code path —
 * it is the exact same setup sequence (migrate 'core' [+ extra tags] →
 * `applyCompanyAuthorizationSchemaAdjustment` → seed role templates + the
 * admin role → register via the real `DatabaseRegistryService` → real
 * `CompanyConnectionManagerService`) every other real-Postgres spec this
 * program already uses, factored out, not reinvented.
 */
const HOST = process.env.DB_HOST ?? 'localhost';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5433;
const USERNAME = process.env.DB_USER ?? 'daii';
const PASSWORD = process.env.DB_PASSWORD ?? 'daii_dev_only';
const APP_ROOT = process.cwd();

export interface TwoCompanyHarnessConfig {
  /** A short, test-file-unique tag used to build disposable database names — avoids collisions across parallel jest workers running different harness instances. */
  namePrefix: string;
  /** Migration tags beyond 'core' each Company database needs (e.g. ['sales'] for a controller under test that needs `products`/`sales_orders` tables). 'core' is always included. */
  extraCompanyTags?: readonly string[];
  /** Module codes to seed into each Company's role catalog (passed to `seedCompanyRoleTemplates`/`seedCompanyAdminRole`). Defaults to ['sales']. */
  roleModuleCodes?: readonly string[];
}

export interface TwoCompanyHarness {
  controlPlane: DataSource;
  connections: CompanyConnectionManagerService;
  users: UsersService;
  memberships: MembershipService;
  companies: CompanyService;
  companyAId: string;
  companyBId: string;
  companyADbName: string;
  companyBDbName: string;
  /** Creates a real Platform User and grants them 'admin' in the given Company (via a real Company-DB UserRole write, not a shortcut). Returns the created User. */
  createUserWithAdminRoleIn(fullName: string, companyId: string): Promise<User>;
  teardown(): Promise<void>;
}

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

export async function setUpTwoCompanyHarness(config: TwoCompanyHarnessConfig): Promise<TwoCompanyHarness> {
  // Optional, fail-closed database-name namespace (Workstream C, 2026-10-10): the regression runner (tools/testing/biz-run.js --regression) sets DAII_TEST_DB_NS to
  // exactly `biz_tNN_` so these historical specs create `daii_test_biz_tNN_<prefix>_*` — a name the existing guard entry already approves. Any other value is refused here.
  // Unset => names unchanged (and the guard will simply refuse them on the dedicated cluster, as before).
  const ns = process.env.DAII_TEST_DB_NS ?? '';
  if (ns && !/^biz_t[0-9]{2}_$/.test(ns)) throw new Error(`DAII_TEST_DB_NS must look like biz_tNN_ (got an invalid value)`);
  const controlPlaneDb = `daii_test_${ns}${config.namePrefix}_control_plane`;
  const companyADbName = `daii_test_${ns}${config.namePrefix}_company_a`;
  const companyBDbName = `daii_test_${ns}${config.namePrefix}_company_b`;
  for (const n of [controlPlaneDb, companyADbName, companyBDbName]) if (n.length > 63) throw new Error(`disposable database name exceeds the PostgreSQL 63-character limit: ${n}`);
  const companyTags = ['core', ...(config.extraCompanyTags ?? [])];
  const roleModuleCodes = config.roleModuleCodes ?? ['sales'];

  await createDatabase(controlPlaneDb);
  await createDatabase(companyADbName);
  await createDatabase(companyBDbName);

  const { runMigrationsForDatabase } = await import('../release-orchestration/company-migration-runner');
  const migratedControlPlane = await runMigrationsForDatabase(APP_ROOT, { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: controlPlaneDb }, ['core']);
  if (!migratedControlPlane.success) throw new Error(`control-plane migration failed: ${migratedControlPlane.error}`);

  const companyAId = randomUUID();
  const companyBId = randomUUID();

  for (const [dbName, label] of [
    [companyADbName, 'A'],
    [companyBDbName, 'B'],
  ] as const) {
    const config_: { host: string; port: number; username: string; password: string; database: string } = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: dbName };
    const migrated = await runMigrationsForDatabase(APP_ROOT, config_, companyTags);
    if (!migrated.success) throw new Error(`Company ${label} migration failed: ${migrated.error}`);
    await applyCompanyAuthorizationSchemaAdjustment(config_);
    await seedCompanyRoleTemplates(config_, roleModuleCodes);
    await seedCompanyAdminRole(config_, roleModuleCodes);
  }

  const controlPlane = new DataSource({
    type: 'postgres',
    host: HOST,
    port: PORT,
    username: USERNAME,
    password: PASSWORD,
    database: controlPlaneDb,
    synchronize: false,
    logging: false,
    entities: [Membership, Company, User, DatabaseRegistry, DatabaseCredential],
  });
  await controlPlane.initialize();
  await controlPlane.query(
    `INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ($1,$2,$3,$4,$5,$6)`,
    ['installation', 'test-installation', 'Test Installation', 'DAII_STANDARD', '1.0.0', '{}'],
  );
  await controlPlane.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,$2,$3,$4)`, [companyAId, 'installation', 'Company A', 'READY']);
  await controlPlane.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,$2,$3,$4)`, [companyBId, 'installation', 'Company B', 'READY']);

  const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
  const databaseRegistry = new DatabaseRegistryService(controlPlane.getRepository(DatabaseRegistry), controlPlane.getRepository(DatabaseCredential), cipher);
  await databaseRegistry.register({ companyId: companyAId, host: HOST, port: PORT, databaseName: companyADbName, status: 'ACTIVE' }, JSON.stringify({ username: USERNAME, password: PASSWORD }));
  await databaseRegistry.register({ companyId: companyBId, host: HOST, port: PORT, databaseName: companyBDbName, status: 'ACTIVE' }, JSON.stringify({ username: USERNAME, password: PASSWORD }));

  const connections = new CompanyConnectionManagerService(databaseRegistry);
  const users = new UsersService(controlPlane.getRepository(User));
  const memberships = new MembershipService(controlPlane.getRepository(Membership));
  const companies = new CompanyService(controlPlane.getRepository(Company));

  async function createUserWithAdminRoleIn(fullName: string, companyId: string): Promise<User> {
    const email = `${fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@test.local`;
    const user = await users.create({ fullName, email });
    await memberships.create({ userId: user.id, companyId, roleKey: 'admin' });

    const dbName = companyId === companyAId ? companyADbName : companyBDbName;
    const setupDs = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: dbName, synchronize: false, logging: false, entities: [Role, UserRole] });
    await setupDs.initialize();
    try {
      const role = await setupDs.getRepository(Role).findOneOrFail({ where: { key: 'admin' } });
      await setupDs.getRepository(UserRole).save(setupDs.getRepository(UserRole).create({ userId: user.id, roleId: role.id }));
    } finally {
      await setupDs.destroy();
    }
    return user;
  }

  async function teardown(): Promise<void> {
    await connections.onModuleDestroy();
    if (controlPlane.isInitialized) await controlPlane.destroy();
    await dropDatabase(controlPlaneDb);
    await dropDatabase(companyADbName);
    await dropDatabase(companyBDbName);
  }

  return { controlPlane, connections, users, memberships, companies, companyAId, companyBId, companyADbName, companyBDbName, createUserWithAdminRoleIn, teardown };
}

/**
 * Area 21 Retrofit Preparation (2026-09-26, CTO-authorized — Real-PG
 * Verification Framework / isolation-assertion helper). Implements the
 * Matrix's Test B/E bar precisely: not "zero rows returned," but proof
 * that the OTHER Company's DataSource was never even requested. Wraps
 * the real `CompanyConnectionManagerService.getDataSource` with a spy for
 * the duration of `fn`, then asserts it was never called with
 * `forbiddenCompanyId`. Restores the original method afterward
 * regardless of whether `fn` throws, so a failing assertion inside `fn`
 * never leaves the harness's connection manager permanently wrapped.
 */
export async function assertDataSourceNeverRequestedFor(
  connections: CompanyConnectionManagerService,
  forbiddenCompanyId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const original = connections.getDataSource.bind(connections);
  const calls: string[] = [];
  connections.getDataSource = (async (companyId: string) => {
    calls.push(companyId);
    return original(companyId);
  }) as typeof connections.getDataSource;
  try {
    await fn();
  } finally {
    connections.getDataSource = original;
  }
  if (calls.includes(forbiddenCompanyId)) {
    throw new Error(`Expected CompanyConnectionManagerService.getDataSource to never be called with forbidden Company id "${forbiddenCompanyId}", but it was called with: ${calls.join(', ')}`);
  }
}

/**
 * Area 21 Retrofit Preparation (2026-09-26). Generalizes the isolation-
 * contract assertion already proven in this harness's own self-test
 * ("two distinct, separately-cached DataSources") into a reusable call
 * for any future per-controller spec, per `AREA21-CONTROLLER-TEST-SPECS.md`.
 */
export async function assertDistinctCachedDataSources(harness: TwoCompanyHarness): Promise<void> {
  const dsA = await harness.connections.getDataSource(harness.companyAId);
  const dsB = await harness.connections.getDataSource(harness.companyBId);
  if (dsA === dsB) {
    throw new Error('Expected Company A and Company B to resolve to distinct DataSource instances, but they were the same instance.');
  }
  if (dsA.options.database !== harness.companyADbName) {
    throw new Error(`Expected Company A's DataSource to target "${harness.companyADbName}", got "${String(dsA.options.database)}".`);
  }
  if (dsB.options.database !== harness.companyBDbName) {
    throw new Error(`Expected Company B's DataSource to target "${harness.companyBDbName}", got "${String(dsB.options.database)}".`);
  }
}
