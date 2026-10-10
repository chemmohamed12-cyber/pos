/**
 * Browser-verification environment bootstrap (2026-10-06, CTO: Browser Verification #1).
 *
 * Builds an ISOLATED, disposable copy of the platform on a throw-away PostgreSQL instance — NEVER the shared `daii_dev`:
 *   control-plane DB  `bv_cp`   (core migrations, installation row, one Company, a registered Company database, an admin user + password)
 *   Company DB        `bv_co`   (every module's migrations, role templates, the admin role, seeded master data)
 * so the REAL backend (dist/main.js) and the REAL frontend can be exercised in a browser against the current tree.
 *
 * Usage (from backend/):  DB_HOST=127.0.0.1 DB_PORT=5656 DB_USER=d3verify DB_PASSWORD=x \
 *   DATABASE_CREDENTIAL_ENCRYPTION_KEY=<same as the backend's> npx ts-node --transpile-only tools/testing/bv-bootstrap.ts
 */
require('./db-guard-register'); // DB guard (M-R2 §11): default deny, all layers — must run before any database import
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { Membership } from '../../src/foundation/company/membership.entity';
import { MembershipService } from '../../src/foundation/company/membership.service';
import { Company } from '../../src/foundation/company/company.entity';
import { User } from '../../src/foundation/identity/user.entity';
import { UsersService } from '../../src/foundation/identity/users.service';
import { DatabaseRegistry } from '../../src/foundation/database-registry/database-registry.entity';
import { DatabaseCredential } from '../../src/foundation/database-registry/database-credential.entity';
import { DatabaseRegistryService } from '../../src/foundation/database-registry/database-registry.service';
import { DatabaseCredentialCipherService } from '../../src/foundation/database-registry/database-credential-cipher.service';
import { AppConfigService } from '../../src/foundation/configuration/app-config.service';
import { applyCompanyAuthorizationSchemaAdjustment } from '../../src/foundation/company/company-authorization-schema-adjustment';
import { seedCompanyRoleTemplates, seedCompanyAdminRole } from '../../src/foundation/company/company-role-seeding';
import { runMigrationsForDatabase } from '../../src/foundation/release-orchestration/company-migration-runner';

const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = Number(process.env.DB_PORT ?? 5656);
const USERNAME = process.env.DB_USER ?? 'd3verify';
const PASSWORD = process.env.DB_PASSWORD ?? 'x';
const CP = process.env.BV_CP_DB ?? 'bv_cp';
const CO = process.env.BV_CO_DB ?? 'bv_co';
const KEY = process.env.DATABASE_CREDENTIAL_ENCRYPTION_KEY ?? 'daii_dev_database_credential_encryption_key_do_not_use_in_prod';
const ADMIN_EMAIL = 'bv.admin@example.test';
const ADMIN_PASSWORD = 'BvAdmin#2026';
const MODULES = ['accounting', 'attendance', 'commission', 'finance', 'hr', 'inventory', 'logistics', 'manufacturing', 'payroll', 'procurement', 'reporting', 'sales', 'targets'];
const TAGS = ['core', 'sales', 'inventory', 'logistics', 'finance', 'hr', 'procurement', 'accounting', 'manufacturing', 'attendance', 'commission', 'payroll', 'targets'];

async function admin<T>(fn: (d: DataSource) => Promise<T>): Promise<T> {
  const d = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: 'postgres' });
  await d.initialize();
  try {
    return await fn(d);
  } finally {
    await d.destroy();
  }
}

async function main() {
  await admin(async (d) => {
    for (const n of [CP, CO]) {
      await d.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
      await d.query(`CREATE DATABASE "${n}"`);
    }
  });
  const cpCfg = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: CP };
  const coCfg = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: CO };
  const r1 = await runMigrationsForDatabase(process.cwd(), cpCfg, ['core']);
  if (!r1.success) throw new Error('control-plane migration failed: ' + r1.error);
  const r2 = await runMigrationsForDatabase(process.cwd(), coCfg, TAGS);
  if (!r2.success) throw new Error('company migration failed: ' + r2.error);
  await applyCompanyAuthorizationSchemaAdjustment(coCfg);
  await seedCompanyRoleTemplates(coCfg, MODULES);
  await seedCompanyAdminRole(coCfg, MODULES);

  const cp = new DataSource({ type: 'postgres', ...cpCfg, entities: [Membership, Company, User, DatabaseRegistry, DatabaseCredential] });
  await cp.initialize();
  const companyId = randomUUID();
  await cp.query(`INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ('installation','bv-installation','Browser Verification','DAII_STANDARD','1.0.0','{}')`);
  await cp.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,'installation','Verify Co','READY')`, [companyId]);
  const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: KEY } as unknown as AppConfigService);
  const registry = new DatabaseRegistryService(cp.getRepository(DatabaseRegistry), cp.getRepository(DatabaseCredential), cipher);
  await registry.register({ companyId, host: HOST, port: PORT, databaseName: CO, status: 'ACTIVE' }, JSON.stringify({ username: USERNAME, password: PASSWORD }));

  const users = new UsersService(cp.getRepository(User));
  const memberships = new MembershipService(cp.getRepository(Membership));
  const user = await users.create({ fullName: 'BV Admin', email: ADMIN_EMAIL });
  await cp.query(`UPDATE "users" SET "status" = 'active' WHERE id = $1`, [user.id]);
  await cp.query(`INSERT INTO "credentials" ("userId","passwordHash","passwordChangedAt") VALUES ($1,$2,now())`, [user.id, await bcrypt.hash(ADMIN_PASSWORD, 10)]);
  await memberships.create({ userId: user.id, companyId, roleKey: 'admin' });

  const co = new DataSource({ type: 'postgres', ...coCfg });
  await co.initialize();
  const role = (await co.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
  // the Company DB mirrors the user row (FK target of user_roles / maker columns)
  await co.query(`INSERT INTO "users" ("id","fullName","email","status") VALUES ($1,'BV Admin',$2,'active') ON CONFLICT DO NOTHING`, [user.id, ADMIN_EMAIL]);
  await co.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), user.id, role.id]);
  console.log(JSON.stringify({ companyId, userId: user.id, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, cp: CP, co: CO }));
  await co.destroy();
  await cp.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
