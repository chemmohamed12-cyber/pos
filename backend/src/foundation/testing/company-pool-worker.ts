/**
 * Test-only child process (spawned by company-database-pool.multi-process.real-pg.spec.ts): ONE independent Node process = one Passenger worker. It builds the real
 * CompanyRegistryController over the shared control-plane database and performs a single `create()`, printing the outcome as one JSON line. No in-process state is shared
 * with the sibling processes, so only the database can arbitrate between them.
 */
import { DataSource } from 'typeorm';
import { CompanyRegistryController } from '../company/company-registry.controller';
import { CompanyRegistryService } from '../company/company-registry.service';
import { CompanyService } from '../company/company.service';
import { Company } from '../company/company.entity';
import { Membership } from '../company/membership.entity';
import { MembershipService } from '../company/membership.service';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { DatabaseCredentialCipherService } from '../database-registry/database-credential-cipher.service';
import { DatabaseProvisioningService } from '../database-provisioning/database-provisioning.service';
import { UsersService } from '../identity/users.service';
import { User } from '../identity/user.entity';

async function main() {
  const e = process.env;
  const cp = new DataSource({
    type: 'postgres', host: e.DB_HOST, port: Number(e.DB_PORT), username: e.DB_USER, password: e.DB_PASSWORD, database: e.WORKER_CP_DB,
    entities: [Company, DatabaseRegistry, DatabaseCredential, Membership, User], synchronize: false,
  });
  await cp.initialize();
  try {
    const companyRegistry = new CompanyRegistryService(new CompanyService(cp.getRepository(Company)));
    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as never);
    const databaseRegistry = new DatabaseRegistryService(cp.getRepository(DatabaseRegistry), cp.getRepository(DatabaseCredential), cipher);
    const provisioning = new DatabaseProvisioningService(companyRegistry, databaseRegistry, new MembershipService(cp.getRepository(Membership)), new UsersService(cp.getRepository(User)));
    const config = {
      database: { host: e.DB_HOST, port: Number(e.DB_PORT), username: e.DB_USER, password: e.DB_PASSWORD, database: e.WORKER_CP_DB },
      companyDatabase: { mode: 'pool', maintenanceDatabase: 'postgres', adminUser: null, adminPassword: null, pool: JSON.parse(e.WORKER_POOL ?? '[]') },
      releaseExecution: { appRoot: process.cwd() },
    };
    const controller = new CompanyRegistryController(companyRegistry, {} as never, databaseRegistry, provisioning, config as never, { isInstallationInitialized: async () => true } as never);
    try {
      const res = await controller.create({ name: e.WORKER_NAME ?? 'W', initialAdminUserId: e.WORKER_ADMIN!, tags: ['core'], roleModuleCodes: ['sales'] } as never);
      console.log('RESULT ' + JSON.stringify({ ok: true, companyId: res.data.company.id }));
    } catch (err) {
      const body = (err as { getResponse?: () => { code?: string } }).getResponse?.();
      console.log('RESULT ' + JSON.stringify({ ok: false, code: body?.code ?? null, message: (err as Error).message }));
    }
  } finally {
    await cp.destroy();
  }
}
main().then(() => process.exit(0), (err) => { console.log('RESULT ' + JSON.stringify({ ok: false, code: 'WORKER_CRASH', message: String(err) })); process.exit(1); });
