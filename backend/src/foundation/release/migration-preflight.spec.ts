import { buildMigrationPreflight, formatMigrationPreflight, MigrationPreflightInput } from './migration-preflight';
import { ReleaseManifestFileEntry } from './release-manifest';

// `buildMigrationPreflight` is deliberately a pure(-ish) function over its
// explicit inputs (see its own doc comment) — directly unit-testable by
// substituting the same seams its own module comments describe: a fake
// `createMigrationDataSource` result, and a fake `MigrationExecutor` (the
// real TypeORM class needs a live driver, so it is mocked here the same way
// `migration-datasource.ts` is — never a hand-rolled parallel diff of what
// migrations exist, just a controllable stand-in for the real loader).

let mockAllMigrations: Array<{ name: string }> = [];
let mockPendingMigrations: Array<{ name: string }> = [];

jest.mock('typeorm', () => {
  const actual = jest.requireActual('typeorm');
  return {
    ...actual,
    MigrationExecutor: jest.fn().mockImplementation(() => ({
      getAllMigrations: jest.fn(async () => mockAllMigrations),
      getPendingMigrations: jest.fn(async () => mockPendingMigrations),
    })),
  };
});

const migrationDataSourceMock = { initialize: jest.fn(async () => undefined), isInitialized: true, destroy: jest.fn(async () => undefined) };
jest.mock('./migration-datasource', () => ({
  createMigrationDataSource: jest.fn(() => migrationDataSourceMock),
  discoverMigrationTags: jest.fn(() => ['core']),
}));

let dependencyCheckResult: { ok: boolean; missing: string[]; detail: string } = { ok: true, missing: [], detail: 'all resolve' };
jest.mock('./dependency-check', () => ({
  checkDependenciesResolve: jest.fn(async () => dependencyCheckResult),
}));

function migrationFile(tag: string, name: string): ReleaseManifestFileEntry {
  return { path: `dist/database/migrations/${tag}/1755840000000-${name}.js`, action: 'modify', checksum: 'x'.repeat(64) };
}

function baseInput(overrides: Partial<MigrationPreflightInput> = {}): MigrationPreflightInput {
  return {
    candidatePath: '/candidate',
    database: { host: 'localhost', port: 5433, username: 'daii', password: 'x', database: 'daii_dev' } as MigrationPreflightInput['database'],
    nodeBin: '/usr/bin/node',
    liveDataSource: { query: jest.fn(async () => [{ name: 'PreviousMigration1755000000000' }]) } as unknown as MigrationPreflightInput['liveDataSource'],
    manifestFiles: [],
    currentInstalledVersion: '1.0.10',
    ...overrides,
  };
}

describe('buildMigrationPreflight', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAllMigrations = [{ name: 'PreviousMigration1755000000000' }, { name: 'NewFeature1755840000000' }];
    mockPendingMigrations = [{ name: 'NewFeature1755840000000' }];
    dependencyCheckResult = { ok: true, missing: [], detail: 'all resolve' };
  });

  it('ignores compiler sidecars (.d.ts, .js.map) shipped alongside a real migration — never mis-derives a drift name from them', async () => {
    const report = await buildMigrationPreflight(
      baseInput({
        manifestFiles: [
          migrationFile('core', 'NewFeature'),
          { path: 'dist/database/migrations/core/1755840000000-NewFeature.d.ts', action: 'modify', checksum: 'x'.repeat(64) },
          { path: 'dist/database/migrations/core/1755840000000-NewFeature.js.map', action: 'modify', checksum: 'x'.repeat(64) },
          { path: 'src/database/migrations/core/1755840000000-NewFeature.ts', action: 'modify', checksum: 'x'.repeat(64) },
        ],
      }),
    );
    expect(report.tagDriftIssues).toEqual([]);
    expect(report.decision).toBe('READY_TO_ACTIVATE');
  });

  it('READY_TO_ACTIVATE when pending migrations, dependencies, and compatibility are all clean', async () => {
    const report = await buildMigrationPreflight(baseInput({ manifestFiles: [migrationFile('core', 'NewFeature')] }));
    expect(report.decision).toBe('READY_TO_ACTIVATE');
    expect(report.blockedReasons).toEqual([]);
    expect(report.current).toBe('PreviousMigration1755000000000');
    expect(report.target).toBe('NewFeature1755840000000');
    expect(report.pending).toEqual(['NewFeature1755840000000']);
    expect(report.order).toEqual(report.pending);
  });

  it('BLOCKED with tagDriftIssues when a manifest-shipped migration is not found by the real loader (the accounting-omission incident, generalized)', async () => {
    // Manifest declares a migration under a tag the loader never discovered as required.
    const report = await buildMigrationPreflight(baseInput({ manifestFiles: [migrationFile('accounting', 'OrphanedMigration')] }));
    expect(report.decision).toBe('BLOCKED');
    expect(report.tagDriftIssues.length).toBe(1);
    expect(report.tagDriftIssues[0]).toMatch(/OrphanedMigration1755840000000/);
    expect(report.blockedReasons.some((r) => r.startsWith('Tag/migration drift:'))).toBe(true);
  });

  it('BLOCKED with manifestDriftIssues when manifest.database.migrationCount disagrees with the independently-computed count', async () => {
    const report = await buildMigrationPreflight(
      baseInput({ manifestDatabase: { migrationRequired: true, migrationCount: 99 } }),
    );
    expect(report.decision).toBe('BLOCKED');
    expect(report.manifestDriftIssues.length).toBeGreaterThan(0);
    expect(report.manifestDriftIssues[0]).toMatch(/migrationCount=99/);
  });

  it('BLOCKED with manifestDriftIssues when manifest.database.migrationRequired disagrees with whether any migrations were found', async () => {
    const report = await buildMigrationPreflight(
      baseInput({ manifestDatabase: { migrationRequired: false, migrationCount: 2 } }),
    );
    expect(report.decision).toBe('BLOCKED');
    expect(report.manifestDriftIssues.some((i) => i.includes('migrationRequired'))).toBe(true);
  });

  it('skips the manifest drift check entirely when manifestDatabase is absent — backward compatible, never invents an expectation', async () => {
    const report = await buildMigrationPreflight(baseInput({ manifestDatabase: undefined }));
    expect(report.manifestDriftIssues).toEqual([]);
    expect(report.decision).toBe('READY_TO_ACTIVATE');
  });

  it('agrees when manifest.database matches the independently-computed count exactly', async () => {
    const report = await buildMigrationPreflight(baseInput({ manifestDatabase: { migrationRequired: true, migrationCount: 2 } }));
    expect(report.manifestDriftIssues).toEqual([]);
    expect(report.decision).toBe('READY_TO_ACTIVATE');
  });

  it('BLOCKED with dependencyIssues when the candidate node_modules is missing a declared runtime dependency (Production Incident 2026-09-15 / decimal.js)', async () => {
    dependencyCheckResult = { ok: false, missing: ['decimal.js'], detail: 'missing from node_modules: decimal.js' };
    const report = await buildMigrationPreflight(baseInput());
    expect(report.decision).toBe('BLOCKED');
    expect(report.dependencyIssues).toEqual(['decimal.js']);
    expect(report.blockedReasons.some((r) => r.includes('Missing runtime dependencies'))).toBe(true);
  });

  it('BLOCKED when a delta package baseVersion does not match the currently installed version — "REJECT UPDATE"', async () => {
    const report = await buildMigrationPreflight(baseInput({ packageType: 'delta', baseVersion: '1.0.9', currentInstalledVersion: '1.0.10' }));
    expect(report.decision).toBe('BLOCKED');
    expect(report.compatibility.ok).toBe(false);
    expect(report.compatibility.reason).toMatch(/does not match/);
  });

  it('READY when a delta package baseVersion matches the currently installed version', async () => {
    const report = await buildMigrationPreflight(baseInput({ packageType: 'delta', baseVersion: '1.0.10', currentInstalledVersion: '1.0.10' }));
    expect(report.compatibility.ok).toBe(true);
    expect(report.decision).toBe('READY_TO_ACTIVATE');
  });

  it('BLOCKED when the installed version is below minimumCompatibleVersion, regardless of packageType', async () => {
    const report = await buildMigrationPreflight(baseInput({ minimumCompatibleVersion: '2.0.0', currentInstalledVersion: '1.0.10' }));
    expect(report.decision).toBe('BLOCKED');
    expect(report.compatibility.reason).toMatch(/below the required minimum "2\.0\.0"/);
  });

  it('is not gated by compatibility at all for a full package with no minimumCompatibleVersion declared', async () => {
    const report = await buildMigrationPreflight(baseInput());
    expect(report.compatibility).toEqual({ ok: true, reason: 'not a delta package, and no minimum compatible version required' });
  });

  it('combines multiple simultaneous failures into one BLOCKED decision with every reason listed', async () => {
    dependencyCheckResult = { ok: false, missing: ['pg'], detail: 'missing' };
    const report = await buildMigrationPreflight(
      baseInput({
        manifestFiles: [migrationFile('logistics', 'GhostMigration')],
        manifestDatabase: { migrationRequired: true, migrationCount: 999 },
        minimumCompatibleVersion: '9.9.9',
      }),
    );
    expect(report.decision).toBe('BLOCKED');
    expect(report.tagDriftIssues.length).toBeGreaterThan(0);
    expect(report.manifestDriftIssues.length).toBeGreaterThan(0);
    expect(report.dependencyIssues.length).toBeGreaterThan(0);
    expect(report.compatibility.ok).toBe(false);
    expect(report.blockedReasons.length).toBe(4);
  });

  it('reads "current" from the live database, never assumed from the manifest', async () => {
    const liveDataSource = { query: jest.fn(async () => [{ name: 'RealLiveHead1234567890' }]) };
    const report = await buildMigrationPreflight(baseInput({ liveDataSource: liveDataSource as unknown as MigrationPreflightInput['liveDataSource'] }));
    expect(report.current).toBe('RealLiveHead1234567890');
    expect(liveDataSource.query).toHaveBeenCalledWith(expect.stringContaining('SELECT name FROM migrations'));
  });

  it('"current" is null (never throws) when the live migrations table has no rows', async () => {
    const liveDataSource = { query: jest.fn(async () => []) };
    const report = await buildMigrationPreflight(baseInput({ liveDataSource: liveDataSource as unknown as MigrationPreflightInput['liveDataSource'] }));
    expect(report.current).toBeNull();
  });

  it('"current" is null (never throws) when the live query itself fails', async () => {
    const liveDataSource = { query: jest.fn(async () => { throw new Error('connection refused'); }) };
    const report = await buildMigrationPreflight(baseInput({ liveDataSource: liveDataSource as unknown as MigrationPreflightInput['liveDataSource'] }));
    expect(report.current).toBeNull();
  });
});

describe('formatMigrationPreflight', () => {
  it('emits the exact CTO-mandated field order, and no REASONS line when nothing is blocked', async () => {
    const report = await buildMigrationPreflight(baseInput());
    const text = formatMigrationPreflight(report);
    const fieldOrder = ['MIGRATION PREFLIGHT:', 'CURRENT:', 'TARGET:', 'REQUIRED:', 'PENDING:', 'ORDER:', 'MANIFEST DRIFT:', 'DEPENDENCY ISSUES:', 'COMPATIBILITY:', 'DECISION:'];
    let lastIndex = -1;
    for (const field of fieldOrder) {
      const idx = text.indexOf(field);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
    expect(text).not.toMatch(/REASONS:/);
  });

  it('appends a REASONS line, joined, when the decision is BLOCKED', async () => {
    dependencyCheckResult = { ok: false, missing: ['pg'], detail: 'missing' };
    const report = await buildMigrationPreflight(baseInput());
    const text = formatMigrationPreflight(report);
    expect(text).toMatch(/REASONS: Missing runtime dependencies: pg/);
  });
});
