import { validateManifest } from './manifest-validation';
import { ReleaseManifest } from './release-manifest';
import { readAppVersion } from './app-version';
import { MODULE_REGISTRY } from '../module-registry/module-registry';

jest.mock('./app-version', () => ({ readAppVersion: jest.fn() }));
const readAppVersionMock = readAppVersion as jest.Mock;

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    version: '1.0.10',
    files: [{ path: 'src/main.ts', action: 'modify', checksum: 'a'.repeat(64) }],
    migrations: [],
    ...overrides,
  };
}

describe('validateManifest — basic shape', () => {
  beforeEach(() => {
    readAppVersionMock.mockReturnValue('1.0.10');
  });

  it('accepts a minimal well-formed full-package manifest', () => {
    expect(validateManifest(manifest(), 'full')).toEqual([]);
  });

  it('rejects a manifest missing "version"', () => {
    expect(validateManifest(manifest({ version: '' }), 'full')).toEqual(expect.arrayContaining([expect.stringMatching(/missing "version"/)]));
  });

  it('rejects a manifest with no files', () => {
    expect(validateManifest(manifest({ files: [] }), 'full')).toEqual(expect.arrayContaining([expect.stringMatching(/no files listed/)]));
  });

  it('rejects an add/modify file missing a checksum', () => {
    const errors = validateManifest(manifest({ files: [{ path: 'src/x.ts', action: 'add' }] }), 'full');
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/missing a checksum/)]));
  });

  it('does not require a checksum for a delete entry', () => {
    expect(validateManifest(manifest({ files: [{ path: 'src/old.ts', action: 'delete' }] }), 'full')).toEqual([]);
  });

  it('rejects a manifest missing "migrations" entirely (undefined, not just empty)', () => {
    const bad = manifest();
    // @ts-expect-error deliberately malformed for the test
    delete bad.migrations;
    expect(validateManifest(bad, 'full')).toEqual(expect.arrayContaining([expect.stringMatching(/missing "migrations"/)]));
  });
});

describe('validateManifest — delta baseVersion (exact match, "REJECT UPDATE")', () => {
  beforeEach(() => {
    readAppVersionMock.mockReturnValue('1.0.10');
  });

  it('accepts a delta whose baseVersion exactly matches the installed version', () => {
    expect(validateManifest(manifest({ baseVersion: '1.0.10' }), 'delta')).toEqual([]);
  });

  it('rejects a delta missing baseVersion', () => {
    expect(validateManifest(manifest(), 'delta')).toEqual(expect.arrayContaining([expect.stringMatching(/missing "baseVersion"/)]));
  });

  it('rejects a delta whose baseVersion does not exactly match — "Reject update"', () => {
    const errors = validateManifest(manifest({ baseVersion: '1.0.9' }), 'delta');
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/Base version mismatch.*Reject update/i)]));
  });

  it('full packages never check baseVersion, even when it would mismatch', () => {
    expect(validateManifest(manifest({ baseVersion: '0.0.1' }), 'full')).toEqual([]);
  });
});

describe('validateManifest — Metadata Contract: minimumCompatibleVersion (floor, both package types)', () => {
  it('accepts when the installed version meets the floor', () => {
    readAppVersionMock.mockReturnValue('1.0.10');
    expect(validateManifest(manifest({ minimumCompatibleVersion: '1.0.5' }), 'full')).toEqual([]);
  });

  it('rejects when the installed version is below the floor — checked for a FULL package too', () => {
    readAppVersionMock.mockReturnValue('1.0.4');
    const errors = validateManifest(manifest({ minimumCompatibleVersion: '1.0.5' }), 'full');
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/Minimum compatible version not met.*Reject update/i)]));
  });

  it('rejects when the installed version is below the floor for a DELTA package too, independent of baseVersion', () => {
    readAppVersionMock.mockReturnValue('1.0.4');
    const errors = validateManifest(manifest({ baseVersion: '1.0.4', minimumCompatibleVersion: '1.0.5' }), 'delta');
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/Minimum compatible version not met/)]));
  });

  it('is absent = no floor enforced', () => {
    readAppVersionMock.mockReturnValue('0.0.1');
    expect(validateManifest(manifest(), 'full')).toEqual([]);
  });
});

describe('validateManifest — Metadata Contract: database.{migrationCount,migrationRequired} internal consistency', () => {
  beforeEach(() => {
    readAppVersionMock.mockReturnValue('1.0.10');
  });

  it('accepts when database.migrationCount matches migrations.length exactly', () => {
    const errors = validateManifest(manifest({ migrations: ['A', 'B'], database: { migrationRequired: true, migrationCount: 2 } }), 'full');
    expect(errors).toEqual([]);
  });

  it('rejects when database.migrationCount disagrees with migrations.length — an internally-inconsistent (corrupted/hand-edited) manifest', () => {
    const errors = validateManifest(manifest({ migrations: ['A'], database: { migrationRequired: true, migrationCount: 5 } }), 'full');
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/migrationCount.*\(5\).*migrations.*\.length.*\(1\)/)]));
  });

  it('rejects when database.migrationRequired disagrees with whether migrations is non-empty', () => {
    const errors = validateManifest(manifest({ migrations: [], database: { migrationRequired: true, migrationCount: 0 } }), 'full');
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/migrationRequired/)]));
  });

  it('is skipped entirely when database is absent — backward compatible with pre-Metadata-Contract manifests', () => {
    const errors = validateManifest(manifest({ migrations: ['A', 'B', 'C'] }), 'full');
    expect(errors).toEqual([]);
  });
});

describe('validateManifest — ERP Foundation P6 entitlement (optional section)', () => {
  beforeEach(() => {
    readAppVersionMock.mockReturnValue('1.0.10');
  });

  it('accepts a manifest with no entitlement at all — every release before P6', () => {
    expect(validateManifest(manifest(), 'full')).toEqual([]);
  });

  it('accepts a well-formed entitlement referencing real authored module codes', () => {
    const [anyRealCode] = MODULE_REGISTRY.authoredModuleCodes();
    const errors = validateManifest(
      manifest({ entitlement: { editionCode: 'DAII_STANDARD', editionVersion: '1.0', moduleCodes: [anyRealCode], manifestPath: 'entitlement.manifest.json' } }),
      'full',
    );
    expect(errors).toEqual([]);
  });

  it('rejects an entitlement referencing an unknown module_code', () => {
    const errors = validateManifest(
      manifest({ entitlement: { editionCode: 'DAII_STANDARD', editionVersion: '1.0', moduleCodes: ['NOT_A_REAL_MODULE'], manifestPath: 'entitlement.manifest.json' } }),
      'full',
    );
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/unknown module_code "NOT_A_REAL_MODULE"/)]));
  });

  it('rejects an entitlement missing editionCode', () => {
    const errors = validateManifest(
      manifest({ entitlement: { editionCode: '', editionVersion: '1.0', moduleCodes: ['x'], manifestPath: 'entitlement.manifest.json' } }),
      'full',
    );
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/missing "editionCode"/)]));
  });

  it('rejects an entitlement with an empty moduleCodes list', () => {
    const errors = validateManifest(
      manifest({ entitlement: { editionCode: 'DAII_STANDARD', editionVersion: '1.0', moduleCodes: [], manifestPath: 'entitlement.manifest.json' } }),
      'full',
    );
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/at least one authored module_code/)]));
  });
});
