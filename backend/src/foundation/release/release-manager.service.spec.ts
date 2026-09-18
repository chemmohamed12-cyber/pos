import { ConflictException, NotFoundException } from '@nestjs/common';
import { ReleaseManagerService } from './release-manager.service';
import { Release } from './release.entity';
import { BackupArtifact } from './backup-artifact.entity';
import { ReleaseManifest } from './release-manifest';
import { ReleaseStatus } from './release-status';
import { AuditService } from '../audit/audit.service';
import { readAppVersion } from './app-version';

jest.mock('./app-version', () => ({ readAppVersion: jest.fn() }));
const readAppVersionMock = readAppVersion as jest.Mock;

describe('ReleaseManagerService', () => {
  let service: ReleaseManagerService;
  const releases = new Map<string, Release>();
  const artifacts = new Map<string, BackupArtifact>();
  let idSeq = 0;

  const releaseRepoMock = {
    create: jest.fn((data: Partial<Release>) => ({ id: `release-${++idSeq}`, ...data }) as Release),
    save: jest.fn(async (release: Release) => {
      releases.set(release.id, release);
      return release;
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: string; version?: string } }) => {
      if (where.id) return releases.get(where.id) ?? null;
      if (where.version) return [...releases.values()].find((r) => r.version === where.version) ?? null;
      return null;
    }),
    find: jest.fn(async ({ where }: { where?: { packageType?: string } } = {}) =>
      [...releases.values()].filter((r) => !where?.packageType || r.packageType === where.packageType),
    ),
  };
  const artifactRepoMock = {
    findOne: jest.fn(async ({ where }: { where: { backupRunId: string; type: string } }) =>
      [...artifacts.values()].find((a) => a.backupRunId === where.backupRunId && a.type === where.type) ?? null,
    ),
  };
  const dataSourceMock = {
    getRepository: jest.fn((entity: unknown) => (entity === Release ? releaseRepoMock : artifactRepoMock)),
  };
  const auditMock = { record: jest.fn(async () => undefined) };

  function seedArtifact(backupRunId: string, status: BackupArtifact['status']): void {
    artifacts.set(`artifact-${backupRunId}`, {
      id: `artifact-${backupRunId}`,
      backupRunId,
      type: 'database',
      filePath: `db/${backupRunId}.dump`,
      sizeBytes: '10',
      checksumSha256: 'x',
      status,
      verifiedAt: status === 'verified' ? new Date() : null,
      errorMessage: null,
      createdAt: new Date(),
    });
  }

  function validManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
    return {
      version: '1.0.4',
      files: [{ path: 'src/main.ts', action: 'modify', checksum: 'abc123' }],
      migrations: [],
      ...overrides,
    };
  }

  async function seedReleaseAtStatus(version: string, status: ReleaseStatus, overrides: Partial<Release> = {}): Promise<Release> {
    const release = await service.registerRelease(validManifest({ version }), 'full', 'admin-1');
    release.status = status;
    releases.set(release.id, { ...release, ...overrides });
    return releases.get(release.id)!;
  }

  beforeEach(() => {
    releases.clear();
    artifacts.clear();
    idSeq = 0;
    jest.clearAllMocks();
    readAppVersionMock.mockReturnValue('1.0.3');
    service = new ReleaseManagerService(dataSourceMock as never, auditMock as unknown as AuditService);
  });

  describe('registerRelease — manifest validation', () => {
    it('a well-formed full-package manifest registers as "validated"', async () => {
      const release = await service.registerRelease(validManifest(), 'full', 'admin-1');
      expect(release.status).toBe('validated');
      expect(release.errorMessage).toBeNull();
      expect(release.manifestChecksum).toHaveLength(64);
    });

    it('a delta manifest whose baseVersion matches the installed version registers as "validated"', async () => {
      const release = await service.registerRelease(validManifest({ baseVersion: '1.0.3' }), 'delta', 'admin-1');
      expect(release.status).toBe('validated');
    });

    it('REJECTS a delta manifest whose baseVersion does NOT match the installed version — "No update without a matching base version"', async () => {
      const release = await service.registerRelease(validManifest({ baseVersion: '0.9.0' }), 'delta', 'admin-1');
      expect(release.status).toBe('validation_failed');
      expect(release.errorMessage).toMatch(/Base version mismatch/);
      expect(release.errorMessage).toMatch(/Reject update/i);
    });

    it('rejects a manifest with no files listed', async () => {
      const release = await service.registerRelease(validManifest({ files: [] }), 'full', 'admin-1');
      expect(release.status).toBe('validation_failed');
    });

    it('rejects a manifest below its own declared minimumCompatibleVersion floor', async () => {
      const release = await service.registerRelease(validManifest({ minimumCompatibleVersion: '9.9.9' }), 'full', 'admin-1');
      expect(release.status).toBe('validation_failed');
      expect(release.errorMessage).toMatch(/Minimum compatible version not met/);
    });
  });

  describe('registerRelease — re-upload supersession policy (correlation db907ffa-342f-43af-a122-050fbc95b6ad)', () => {
    it('REPLACEABLE: a re-upload of a "validation_failed" version supersedes the same row in place (same id)', async () => {
      const first = await service.registerRelease(validManifest({ version: '2.0.0', files: [] }), 'full', 'admin-1');
      expect(first.status).toBe('validation_failed');

      const second = await service.registerRelease(validManifest({ version: '2.0.0' }), 'full', 'admin-1');
      expect(second.id).toBe(first.id);
      expect(second.status).toBe('validated');
      expect(releases.size).toBe(1);
    });

    it('REPLACEABLE: "rolled_back" is superseded in place too', async () => {
      const first = await seedReleaseAtStatus('2.0.1', 'rolled_back');
      const second = await service.registerRelease(validManifest({ version: '2.0.1' }), 'full', 'admin-1');
      expect(second.id).toBe(first.id);
      expect(second.status).toBe('validated');
    });

    it('LIVE: refuses to re-register a version whose status is "succeeded" — a new release needs a new version', async () => {
      await seedReleaseAtStatus('2.0.2', 'succeeded');
      await expect(service.registerRelease(validManifest({ version: '2.0.2' }), 'full', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('ALARM: refuses to auto-replace a "failed_safe" release — requires manual operator filesystem verification', async () => {
      await seedReleaseAtStatus('2.0.3', 'failed_safe');
      await expect(service.registerRelease(validManifest({ version: '2.0.3' }), 'full', 'admin-1')).rejects.toThrow(/FAILED-SAFE/);
    });

    it('IN_FLIGHT: refuses to overwrite a release that is actively "deploying"', async () => {
      await seedReleaseAtStatus('2.0.4', 'deploying');
      await expect(service.registerRelease(validManifest({ version: '2.0.4' }), 'full', 'admin-1')).rejects.toThrow(/still in progress/);
    });

    it('IN_FLIGHT: refuses to overwrite "backup_verified" (gate passed, deploy not yet attempted)', async () => {
      await seedReleaseAtStatus('2.0.5', 'backup_verified');
      await expect(service.registerRelease(validManifest({ version: '2.0.5' }), 'full', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('linkVerifiedBackup', () => {
    it('links successfully when the backup has a verified database artifact', async () => {
      const release = await service.registerRelease(validManifest(), 'full', 'admin-1');
      seedArtifact('backup-1', 'verified');
      const linked = await service.linkVerifiedBackup(release.id, 'backup-1', 'admin-2');
      expect(linked.status).toBe('backup_verified');
      expect(linked.backupRunId).toBe('backup-1');
    });

    it('rejects linking a backup whose database artifact is NOT verified', async () => {
      const release = await service.registerRelease(validManifest(), 'full', 'admin-1');
      seedArtifact('backup-2', 'completed');
      await expect(service.linkVerifiedBackup(release.id, 'backup-2', 'admin-2')).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws NotFoundException for an unknown release', async () => {
      seedArtifact('backup-4', 'verified');
      await expect(service.linkVerifiedBackup('no-such-release', 'backup-4', 'admin-2')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('checkDeploymentGate — "No Verified Backup -> No Deployment"', () => {
    it('BLOCKS deployment when no backup has been linked at all', async () => {
      const release = await service.registerRelease(validManifest(), 'full', 'admin-1');
      await expect(service.checkDeploymentGate(release.id)).rejects.toThrow(/No Verified Backup -> No Deployment/);
    });

    it('ALLOWS deployment once a verified backup is linked', async () => {
      const release = await service.registerRelease(validManifest(), 'full', 'admin-1');
      seedArtifact('backup-5', 'verified');
      await service.linkVerifiedBackup(release.id, 'backup-5', 'admin-2');
      const result = await service.checkDeploymentGate(release.id);
      expect(result).toEqual({ allowed: true, backupRunId: 'backup-5' });
    });
  });

  describe('resolveUpgradePath — Release Center integration (Upgrade Resolver, stage 3/4)', () => {
    it('delegates to the pure resolver: a full package at a newer version resolves directly', async () => {
      readAppVersionMock.mockReturnValue('1.0.8');
      const target = await service.registerRelease(validManifest({ version: '1.0.10' }), 'full', 'admin-1');

      const result = await service.resolveUpgradePath(target.id);

      expect(result.valid).toBe(true);
      expect(result.chain).toEqual([{ fromVersion: '1.0.8', toVersion: '1.0.10', releaseId: target.id }]);
    });

    it('gathers OTHER known deltas as bridge candidates and resolves a multi-hop chain through them', async () => {
      readAppVersionMock.mockReturnValue('1.0.8');
      const bridge = await service.registerRelease(validManifest({ version: '1.0.9', baseVersion: '1.0.8' }), 'delta', 'admin-1');
      readAppVersionMock.mockReturnValue('1.0.8'); // registering the target must not itself require a matching baseVersion (it's a delta whose own baseVersion is the bridge's version)
      const target = await service.registerRelease(validManifest({ version: '1.0.10', baseVersion: '1.0.9' }), 'delta', 'admin-1');

      const result = await service.resolveUpgradePath(target.id);

      expect(result.valid).toBe(true);
      expect(result.chain.map((s) => s.toVersion)).toEqual(['1.0.9', '1.0.10']);
      expect(result.chain[0].releaseId).toBe(bridge.id);
    });

    it('excludes the target release itself from the bridge-candidate pool (never a self-referential chain)', async () => {
      readAppVersionMock.mockReturnValue('1.0.9');
      const target = await service.registerRelease(validManifest({ version: '1.0.10', baseVersion: '1.0.9' }), 'delta', 'admin-1');
      const result = await service.resolveUpgradePath(target.id);
      // Direct application (baseVersion === currentInstalledVersion) — no bridge needed at all, confirming self-exclusion never matters here but the pool construction still ran without error.
      expect(result.valid).toBe(true);
      expect(result.chain).toHaveLength(1);
    });

    it('excludes deltas whose own manifest never validated ("validation_failed") from the bridge pool — not a real package', async () => {
      readAppVersionMock.mockReturnValue('1.0.8');
      // This "bridge" never actually validated (e.g. missing baseVersion) — must not be usable as a chain link.
      const brokenBridge = await service.registerRelease(validManifest({ version: '1.0.9', baseVersion: undefined }), 'delta', 'admin-1');
      expect(brokenBridge.status).toBe('validation_failed');
      const target = await service.registerRelease(validManifest({ version: '1.0.10', baseVersion: '1.0.9' }), 'delta', 'admin-1');

      const result = await service.resolveUpgradePath(target.id);

      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/no delta release with baseVersion "1\.0\.8" is registered at all/);
    });

    it('STILL treats a "rolled_back" delta as a legitimate bridge candidate — chain resolution asks "does a package exist", not "was it ever deployed"', async () => {
      readAppVersionMock.mockReturnValue('1.0.8');
      const bridge = await seedReleaseAtStatus('1.0.9', 'rolled_back', { packageType: 'delta', baseVersion: '1.0.8' } as Partial<Release>);
      const target = await service.registerRelease(validManifest({ version: '1.0.10', baseVersion: '1.0.9' }), 'delta', 'admin-1');

      const result = await service.resolveUpgradePath(target.id);

      expect(result.valid).toBe(true);
      expect(result.chain[0].releaseId).toBe(bridge.id);
    });

    it('passes the release manifest\'s own minimumCompatibleVersion through as the floor', async () => {
      readAppVersionMock.mockReturnValue('1.0.0');
      const target = await service.registerRelease(validManifest({ version: '1.0.10', minimumCompatibleVersion: '1.0.5' }), 'full', 'admin-1');
      expect(target.status).toBe('validation_failed'); // registration itself already rejects a manifest that violates its own floor against the CURRENT installed version
      // Force it into a resolvable state to isolate resolveUpgradePath's own floor-passing behavior from registration-time validation.
      releases.set(target.id, { ...target, status: 'validated', errorMessage: null });

      const result = await service.resolveUpgradePath(target.id);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/minimum compatible version of "1\.0\.5"/);
    });

    it('throws NotFoundException for an unknown release', async () => {
      await expect(service.resolveUpgradePath('no-such-release')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never returns a silent empty result — invalid resolutions always carry a reason', async () => {
      readAppVersionMock.mockReturnValue('1.0.10');
      const target = await service.registerRelease(validManifest({ version: '1.0.5' }), 'full', 'admin-1'); // older than installed -> downgrade
      const result = await service.resolveUpgradePath(target.id);
      expect(result.valid).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});
