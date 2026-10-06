/**
 * Supplementary, mocked unit coverage. `verifyManifest`'s own Ed25519
 * signature-verification logic is not re-tested here (it is reused
 * unmodified and has its own coverage elsewhere) — this proves THIS
 * function's own logic: dependency-closure rejection, the Company-scoped
 * DataSource write, and error propagation. Real-Postgres proof (does the
 * row actually land correctly in a genuine Company database) is bundled
 * with the same CREATEDB-blocked pending item as Area 4/16/6.
 */
const verifyManifestMock = jest.fn();
jest.mock('../entitlement/manifest-verify', () => ({ verifyManifest: (...args: unknown[]) => verifyManifestMock(...args) }));

jest.mock('../entitlement/installation-fingerprint', () => ({ computeInstallationFingerprint: () => 'fingerprint-abc' }));

const dependencyClosureOfMock = jest.fn((_code: unknown) => [] as string[]);
jest.mock('../module-registry/module-registry', () => ({
  MODULE_REGISTRY: { dependencyClosureOf: (code: unknown) => dependencyClosureOfMock(code) },
}));

const saveMock = jest.fn(async (row: unknown) => row);
const createMock = jest.fn((data: unknown) => data);
const dsInitializeMock = jest.fn(async () => undefined);
const dsDestroyMock = jest.fn(async () => undefined);
let dsIsInitialized = false;
jest.mock('typeorm', () => ({
  ...jest.requireActual('typeorm'),
  DataSource: jest.fn().mockImplementation(() => ({
    initialize: async () => {
      dsIsInitialized = true;
      await dsInitializeMock();
    },
    destroy: async () => {
      dsIsInitialized = false;
      await dsDestroyMock();
    },
    get isInitialized() {
      return dsIsInitialized;
    },
    getRepository: () => ({ save: saveMock, create: createMock }),
  })),
}));

import { applyEntitlementManifestToCompany, CompanyEntitlementRejectedError } from './company-entitlement-provisioning';
import { EntitlementManifest } from '../entitlement/manifest.type';

describe('applyEntitlementManifestToCompany — mocked (supplementary to the real-Postgres proof)', () => {
  const manifest = {
    installation_id: 'inst-1',
    customer_name: 'Acme',
    edition_code: 'DAII_STANDARD',
    edition_version: '1.0.0',
    module_codes: ['sales'],
    license_version: 1,
    issued_at: new Date().toISOString(),
    kid: 'kid-1',
  } as unknown as EntitlementManifest;

  const opts = { publicKeys: [], clockToleranceMinutes: 5 };
  const database = { host: 'h', port: 1, username: 'u', password: 'p', database: 'd' };

  beforeEach(() => {
    jest.clearAllMocks();
    dsIsInitialized = false;
    verifyManifestMock.mockReturnValue({ ok: true, manifest });
    dependencyClosureOfMock.mockReturnValue([]);
  });

  it('applies a verified manifest — writes the row and cleans up the connection', async () => {
    await applyEntitlementManifestToCompany(database, manifest, 'sig-b64', opts);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(dsDestroyMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a manifest that fails signature verification — never writes a row', async () => {
    verifyManifestMock.mockReturnValue({ ok: false, reason: 'bad_signature' });
    await expect(applyEntitlementManifestToCompany(database, manifest, 'sig-b64', opts)).rejects.toThrow(CompanyEntitlementRejectedError);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('rejects a manifest missing a hard module dependency, unless expandClosure is set', async () => {
    dependencyClosureOfMock.mockReturnValue(['sales', 'finance']);
    await expect(applyEntitlementManifestToCompany(database, manifest, 'sig-b64', opts)).rejects.toThrow(CompanyEntitlementRejectedError);
    expect(saveMock).not.toHaveBeenCalled();

    const applied = await applyEntitlementManifestToCompany(database, manifest, 'sig-b64', { ...opts, expandClosure: true });
    expect(applied).toBeUndefined();
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('reuses computeInstallationFingerprint as-is — passes it through to verifyManifest', async () => {
    await applyEntitlementManifestToCompany(database, manifest, 'sig-b64', opts);
    expect(verifyManifestMock).toHaveBeenCalledWith(expect.any(String), 'sig-b64', expect.objectContaining({ currentFingerprint: 'fingerprint-abc' }));
  });
});
