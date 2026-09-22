import { DataSource } from 'typeorm';
import AppDataSource from '../../database/data-source';
import { Release } from './release.entity';
import { ReleaseMigrationRun } from './release-migration-run.entity';

/**
 * Production Incident 2026-09-22 — `GET /releases/:id/migrations`
 * (release.controller.ts) used to return every `release_migration_runs`
 * row ever recorded for a release id, unfiltered. Because
 * `registerRelease()`'s REPLACEABLE re-upload policy deliberately reuses
 * the SAME release id across re-uploads of a version (and never deletes
 * prior run rows — audit trail), an operator re-uploading a corrected
 * v1.1.2 package saw the PRIOR, superseded attempt's failures displayed
 * as if they belonged to the new one. Real DB integration test (not
 * mocked query-builder chains) since this is fundamentally a SQL
 * MAX()-then-filter correctness question — the fix relies on every row
 * from one `runReleaseMigrations()` call sharing an identical `startedAt`,
 * which is exactly the kind of thing a mock would assert away rather than
 * prove.
 */
describe('GET /releases/:id/migrations — latest-attempt isolation', () => {
  let dataSource: DataSource;
  let releaseId: string;

  async function latestAttemptRows(id: string) {
    const repo = dataSource.getRepository(ReleaseMigrationRun);
    const latest = await repo.createQueryBuilder('r').where('r.releaseId = :id', { id }).select('MAX(r.startedAt)', 'max').getRawOne<{ max: Date | null }>();
    if (!latest?.max) return [];
    return repo.find({ where: { releaseId: id, startedAt: latest.max }, order: { migrationName: 'ASC' } });
  }

  beforeAll(async () => {
    dataSource = AppDataSource.isInitialized ? AppDataSource : await AppDataSource.initialize();

    const releaseRepo = dataSource.getRepository(Release);
    const release = await releaseRepo.save(
      releaseRepo.create({
        version: `9.9.9-t${Date.now() % 1000000}`,
        packageType: 'full',
        baseVersion: null,
        manifest: { version: '9.9.9', files: [], migrations: [] } as never,
        manifestChecksum: 'test-checksum',
        status: 'failed',
        uploadedByUserId: '00000000-0000-0000-0000-000000000000',
        backupRunId: null,
        completedAt: null,
        errorMessage: null,
      }),
    );
    releaseId = release.id;
  }, 30_000);

  afterAll(async () => {
    // Clean up ONLY this test's own rows — never touches any other release.
    await dataSource.getRepository(ReleaseMigrationRun).delete({ releaseId });
    await dataSource.getRepository(Release).delete({ id: releaseId });
  });

  it('an older, superseded attempt is isolated from a newer attempt, and nothing is deleted', async () => {
    const runRepo = dataSource.getRepository(ReleaseMigrationRun);

    // Attempt 1 (the old, pre-fix run): 2 migrations, both reported failed
    // with the batch-propagated "syntax error" — matching the real incident.
    const attempt1Started = new Date('2026-09-22T00:00:00.000Z');
    await runRepo.save([
      runRepo.create({
        releaseId,
        migrationName: 'CreateTargetsCore1789750000000',
        startedAt: attempt1Started,
        completedAt: attempt1Started,
        success: false,
        errorMessage: 'syntax error at or near "FUNCTION"',
      }),
      runRepo.create({
        releaseId,
        migrationName: 'SeedAdminPermissionsForCommission1789751100000',
        startedAt: attempt1Started,
        completedAt: attempt1Started,
        success: false,
        errorMessage: 'syntax error at or near "FUNCTION"',
      }),
    ]);

    // 1. Historical failed attempt rows remain stored, retrievable directly.
    const afterAttempt1 = await runRepo.find({ where: { releaseId } });
    expect(afterAttempt1).toHaveLength(2);
    expect(afterAttempt1.every((r) => r.success === false)).toBe(true);

    // The endpoint's own logic, called right after attempt 1, correctly
    // shows attempt 1 (it IS the latest at this point).
    const afterAttempt1Endpoint = await latestAttemptRows(releaseId);
    expect(afterAttempt1Endpoint.map((r) => r.migrationName).sort()).toEqual([
      'CreateTargetsCore1789750000000',
      'SeedAdminPermissionsForCommission1789751100000',
    ]);
    expect(afterAttempt1Endpoint.every((r) => r.success === false)).toBe(true);

    // Attempt 2 (the corrected re-upload's real attempt, strictly later):
    // same migration names, this time successful.
    const attempt2Started = new Date('2026-09-22T01:00:00.000Z');
    await runRepo.save([
      runRepo.create({
        releaseId,
        migrationName: 'CreateTargetsCore1789750000000',
        startedAt: attempt2Started,
        completedAt: attempt2Started,
        success: true,
        errorMessage: null,
      }),
      runRepo.create({
        releaseId,
        migrationName: 'SeedAdminPermissionsForCommission1789751100000',
        startedAt: attempt2Started,
        completedAt: attempt2Started,
        success: true,
        errorMessage: null,
      }),
    ]);

    // 2 & 4. Both attempts' rows still exist — nothing was deleted.
    const afterAttempt2All = await runRepo.find({ where: { releaseId } });
    expect(afterAttempt2All).toHaveLength(4);
    const stillHasOldFailure = afterAttempt2All.some((r) => r.startedAt.getTime() === attempt1Started.getTime() && r.success === false);
    expect(stillHasOldFailure).toBe(true);

    // 3. The endpoint now returns ONLY the latest attempt (2 rows, both
    // success) — the old failure is isolated out, not deleted, just not
    // returned as if it were current.
    const latest = await latestAttemptRows(releaseId);
    expect(latest).toHaveLength(2);
    expect(latest.every((r) => r.startedAt.getTime() === attempt2Started.getTime())).toBe(true);
    expect(latest.every((r) => r.success === true)).toBe(true);
    expect(latest.some((r) => r.errorMessage === 'syntax error at or near "FUNCTION"')).toBe(false);
  }, 30_000);

  it('a release with no migration runs at all returns an empty list, not an error', async () => {
    const runRepo = dataSource.getRepository(ReleaseMigrationRun);
    const releaseRepo = dataSource.getRepository(Release);
    const empty = await releaseRepo.save(
      releaseRepo.create({
        version: `9.9.8-t${Date.now() % 1000000}`,
        packageType: 'full',
        baseVersion: null,
        manifest: { version: '9.9.8', files: [], migrations: [] } as never,
        manifestChecksum: 'test-checksum-empty',
        status: 'validated',
        uploadedByUserId: '00000000-0000-0000-0000-000000000000',
        backupRunId: null,
        completedAt: null,
        errorMessage: null,
      }),
    );
    try {
      const result = await latestAttemptRows(empty.id);
      expect(result).toEqual([]);
    } finally {
      await runRepo.delete({ releaseId: empty.id });
      await releaseRepo.delete({ id: empty.id });
    }
  }, 30_000);
});
