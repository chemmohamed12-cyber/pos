import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseCredentialCipherService } from '../database-registry/database-credential-cipher.service';
import { CompanyRegistryService } from '../company/company-registry.service';
import { CompanyActivationService } from '../company/company-activation.service';
import { DatabaseProvisioningService } from '../database-provisioning/database-provisioning.service';
import { AppConfigService } from '../configuration/app-config.service';
import { TwoCompanyHarness } from './two-company-real-pg-harness';
import { APP_ROOT, DB_HOST, DB_PASSWORD, DB_PORT, DB_USER, createDisposableDatabase } from './saas-characterization.helpers';

/**
 * TEST-ONLY. Builds the REAL provisioning services (the same ones `POST /installation/companies`
 * uses) on top of a two-company harness's control-plane database, so the control-plane
 * lifecycle can be characterized without touching production code.
 */
export function buildProvisioningKit(h: TwoCompanyHarness) {
  const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
  const databaseRegistry = new DatabaseRegistryService(h.controlPlane.getRepository(DatabaseRegistry), h.controlPlane.getRepository(DatabaseCredential), cipher);
  const companyRegistry = new CompanyRegistryService(h.companies);
  const activation = new CompanyActivationService(companyRegistry);
  const provisioning = new DatabaseProvisioningService(companyRegistry, databaseRegistry, h.memberships, h.users);

  /** What `POST /installation/companies` does first: a Company row in `PROVISIONING`. */
  const createCompanyRow = (name: string) => companyRegistry.provision('installation', name);

  /** The same call the controller makes after creating the physical database (which the caller does via `createDisposableDatabase`). */
  async function provisionInto(params: { companyId: string; databaseName: string; initialAdminUserId: string; tags?: readonly string[]; roleModuleCodes?: readonly string[]; reuseDatabase?: boolean }) {
    if (!params.reuseDatabase) await createDisposableDatabase(params.databaseName);
    return provisioning.provision({
      companyId: params.companyId,
      host: DB_HOST,
      port: DB_PORT,
      databaseName: params.databaseName,
      username: DB_USER,
      password: DB_PASSWORD,
      appRoot: APP_ROOT,
      tags: params.tags,
      roleModuleCodes: params.roleModuleCodes ?? [],
      initialAdminUserId: params.initialAdminUserId,
    });
  }

  return { databaseRegistry, companyRegistry, activation, provisioning, createCompanyRow, provisionInto };
}
