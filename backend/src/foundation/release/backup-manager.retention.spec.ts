import { mkdtemp, mkdir, writeFile, access, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BackupManagerService } from './backup-manager.service';
import { BackupRun } from './backup-run.entity';
import { BackupArtifact } from './backup-artifact.entity';

/**
 * Production (release 1.1.5): the retention sweep deleted a backup's FILES first and its database rows second; the row was referenced by `releases.backupRunId`, the
 * delete failed on `releases_backupRunId_fkey`, and the backup was left with no files. Retention now (1) never touches a run a release points at, (2) removes database
 * records before files, (3) isolates a failure to that one run.
 */
describe('BackupManagerService.applyRetentionPolicy — referenced backups and ordering', () => {
  let storage: string;
  const exists = (p: string) => access(p).then(() => true, () => false);
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);

  async function seedFiles(runId: string) {
    await mkdir(join(storage, 'manifests'), { recursive: true });
    await writeFile(join(storage, `${runId}.dump`), 'x');
    await writeFile(join(storage, 'manifests', `${runId}.json`), '{}');
  }

  function build(runs: Array<{ id: string; startedAt: Date }>, referencedIds: string[], opts: { failRunRemoval?: boolean } = {}) {
    const removedRuns: string[] = [];
    const runRepo = {
      find: jest.fn(async () => runs),
      remove: jest.fn(async (r: { id: string }) => { if (opts.failRunRemoval) throw new Error('violates foreign key constraint "releases_backupRunId_fkey"'); removedRuns.push(r.id); }),
    };
    const artifactRepo = {
      find: jest.fn(async ({ where }: { where: { backupRunId: string } }) => [{ id: `a-${where.backupRunId}`, backupRunId: where.backupRunId, filePath: `${where.backupRunId}.dump` }]),
      remove: jest.fn(async () => undefined),
    };
    const dataSource = {
      getRepository: (e: unknown) => (e === BackupRun ? runRepo : e === BackupArtifact ? artifactRepo : { findOne: async () => null }),
      query: jest.fn(async () => referencedIds.map((backupRunId) => ({ backupRunId }))),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const config = { releaseBackup: { storagePath: storage, retentionDays: 30 } };
    const service = new BackupManagerService(dataSource as never, config as never, {} as never, audit as never, {} as never, {} as never, {} as never);
    return { service, removedRuns, runRepo, audit };
  }

  beforeEach(async () => { storage = await mkdtemp(join(tmpdir(), 'retention-')); });
  afterEach(async () => { await rm(storage, { recursive: true, force: true }); });

  // MIN_KEEP_RUNS newest runs are always kept; pad with recent runs so the old ones are real candidates
  const padding = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `new-${i}`, startedAt: new Date(Date.now() - i * 1000) }));

  it('a run referenced by a release is KEPT: files, manifest and records untouched, and nothing is deleted from the database', async () => {
    await seedFiles('ref-run');
    const { service, removedRuns, audit } = build([...padding(10), { id: 'ref-run', startedAt: old }], ['ref-run']);
    const r = await service.applyRetentionPolicy();
    expect(r.deletedRuns).toBe(0);
    expect(removedRuns).toEqual([]);
    expect(await exists(join(storage, 'ref-run.dump'))).toBe(true);
    expect(await exists(join(storage, 'manifests', 'ref-run.json'))).toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('an unreferenced old run is deleted (records, then files) and audited', async () => {
    await seedFiles('old-run');
    const { service, removedRuns, audit } = build([...padding(10), { id: 'old-run', startedAt: old }], []);
    const r = await service.applyRetentionPolicy();
    expect(r.deletedRuns).toBe(1);
    expect(removedRuns).toEqual(['old-run']);
    expect(await exists(join(storage, 'old-run.dump'))).toBe(false);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('if the database refuses the removal (FK), the backup FILES survive and the sweep does not throw', async () => {
    await seedFiles('fk-run');
    const { service } = build([...padding(10), { id: 'fk-run', startedAt: old }], [], { failRunRemoval: true });
    const r = await service.applyRetentionPolicy();
    expect(r.deletedRuns).toBe(0);
    expect(await exists(join(storage, 'fk-run.dump'))).toBe(true);
    expect(await exists(join(storage, 'manifests', 'fk-run.json'))).toBe(true);
  });

  it('records removed but a file cannot be deleted => the run is still counted and audited, the stray file is only logged (no restore point is lost: the records are gone first)', async () => {
    await mkdir(join(storage, 'manifests'), { recursive: true });
    await mkdir(join(storage, 'stuck-run.dump'), { recursive: true }); // a non-empty directory where a file is expected: rm() without recursive throws
    await writeFile(join(storage, 'stuck-run.dump', 'inner'), 'x');
    const { service, removedRuns, audit } = build([...padding(10), { id: 'stuck-run', startedAt: old }], []);
    const r = await service.applyRetentionPolicy();
    expect(r.deletedRuns).toBe(1);
    expect(removedRuns).toEqual(['stuck-run']);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(await exists(join(storage, 'stuck-run.dump', 'inner'))).toBe(true);
  });

  it('one failing run does not stop the sweep: the next old run is still removed', async () => {
    await seedFiles('ok-run');
    const { service, removedRuns } = build([...padding(10), { id: 'ref-run', startedAt: old }, { id: 'ok-run', startedAt: old }], ['ref-run']);
    const r = await service.applyRetentionPolicy();
    expect(r.deletedRuns).toBe(1);
    expect(removedRuns).toEqual(['ok-run']);
  });
});
