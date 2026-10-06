/**
 * Supplementary, mocked unit coverage — proves the control-flow logic of
 * `runMigrationsForDatabase` (success/failure branches, cleanup always
 * runs) without a live Postgres connection. This does NOT substitute for
 * `company-migration-runner.spec.ts`'s real-disposable-database proof
 * (V7 Area 16's literal Verification requirement) — that file is
 * currently skipped pending a CREATEDB-capable Postgres environment; see
 * its own header comment.
 */
const dsState = { isInitialized: false };
const initializeMock = jest.fn(async () => {
  dsState.isInitialized = true;
});
const destroyMock = jest.fn(async () => {
  dsState.isInitialized = false;
});
const runMigrationsMock = jest.fn(async () => undefined);
let getPendingMigrationsMock = jest.fn(async () => [{ name: 'SomeMigration123' }]);

jest.mock('./../release/migration-datasource', () => ({
  createMigrationDataSource: jest.fn(() => ({
    initialize: initializeMock,
    destroy: destroyMock,
    runMigrations: runMigrationsMock,
    get isInitialized() {
      return dsState.isInitialized;
    },
  })),
}));

jest.mock('typeorm', () => ({
  MigrationExecutor: jest.fn().mockImplementation(() => ({
    getPendingMigrations: getPendingMigrationsMock,
  })),
}));

import { runMigrationsForDatabase } from './company-migration-runner';

describe('runMigrationsForDatabase — mocked control-flow (supplementary to the real-Postgres test)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dsState.isInitialized = false;
    getPendingMigrationsMock = jest.fn(async () => [{ name: 'SomeMigration123' }]);
  });

  it('reports success and the migrations that ran', async () => {
    const result = await runMigrationsForDatabase('/fake/app-root', { host: 'h', port: 1, username: 'u', password: 'p', database: 'd' });
    expect(result).toEqual({ success: true, ranMigrationNames: ['SomeMigration123'], error: null });
    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(runMigrationsMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('reports failure (not a thrown exception) when runMigrations() throws, and still calls destroy()', async () => {
    runMigrationsMock.mockRejectedValueOnce(new Error('connection refused'));
    const result = await runMigrationsForDatabase('/fake/app-root', { host: 'h', port: 1, username: 'u', password: 'p', database: 'd' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('connection refused');
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('reports failure when initialize() itself throws (unreachable database) — and does NOT call destroy() on a connection that never initialized', async () => {
    initializeMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const result = await runMigrationsForDatabase('/fake/app-root', { host: 'h', port: 1, username: 'u', password: 'p', database: 'd' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('ENOTFOUND');
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('reports zero ran migrations when nothing is pending (idempotent re-run)', async () => {
    getPendingMigrationsMock = jest.fn(async () => []);
    const result = await runMigrationsForDatabase('/fake/app-root', { host: 'h', port: 1, username: 'u', password: 'p', database: 'd' });
    expect(result).toEqual({ success: true, ranMigrationNames: [], error: null });
  });
});
