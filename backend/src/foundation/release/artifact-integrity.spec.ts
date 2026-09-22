import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { verifyArtifactIntegrity, formatArtifactIntegrityViolations } from './artifact-integrity';
import { StagedActivationService } from './staged-activation.service';
import { computeFileChecksum, computeStringChecksum } from './checksum';
import { Release } from './release.entity';
import { ReleaseManifest } from './release-manifest';
import { AppConfigService } from '../configuration/app-config.service';

/**
 * Production Incident 2026-09-22 — a re-uploaded v1.1.2 registered with the
 * CORRECT manifestChecksum (proven against production's own `releases`
 * row), yet the candidate built for that exact release id still ran the
 * OLD `CreateTargetsCore` (`EXECUTE FUNCTION`, invalid on production's
 * PG10.23). Source tracing found every build step correctly re-derives
 * fresh content keyed by release id — no staleness bug located — but
 * nothing PROVED the assembled candidate's bytes actually matched the
 * manifest. This suite has two parts:
 *   A. Direct unit tests of `verifyArtifactIntegrity()` against
 *      hand-built fixtures.
 *   B. The CTO's own explicitly-required scenario: a real re-upload of
 *      the SAME version/release id, through the REAL (unmodified)
 *      `StagedActivationService.buildCandidate()`, proving the second
 *      candidate genuinely contains the new bytes and the gate correctly
 *      passes/fails against each.
 */
function makeRelease(overrides: Partial<Release> & { manifest: ReleaseManifest; manifestChecksum: string }): Release {
  return {
    id: 'release-under-test',
    version: '1.1.2',
    packageType: 'full',
    baseVersion: null,
    status: 'deploying',
    uploadedByUserId: 'admin-1',
    uploadedAt: new Date(),
    backupRunId: 'backup-1',
    completedAt: null,
    errorMessage: null,
    ...overrides,
  };
}

describe('verifyArtifactIntegrity — direct unit tests', () => {
  let candidatePath: string;

  beforeEach(() => {
    candidatePath = mkdtempSync(join(tmpdir(), 'artifact-integrity-test-'));
  });

  afterEach(() => {
    rmSync(candidatePath, { recursive: true, force: true });
  });

  it('1. a correct artifact — every declared file matches, manifest identity matches — passes with zero violations', async () => {
    mkdirSync(join(candidatePath, 'dist', 'database', 'migrations', 'targets'), { recursive: true });
    const content = 'EXECUTE PROCEDURE targets_check_non_overlap()';
    writeFileSync(join(candidatePath, 'dist', 'database', 'migrations', 'targets', 'CreateTargetsCore.js'), content);
    const checksum = await computeFileChecksum(join(candidatePath, 'dist', 'database', 'migrations', 'targets', 'CreateTargetsCore.js'));

    const manifest: ReleaseManifest = {
      version: '1.1.2',
      packageType: 'full',
      files: [{ path: 'dist/database/migrations/targets/CreateTargetsCore.js', action: 'modify', checksum }],
      migrations: [],
    };
    writeFileSync(join(candidatePath, 'MANIFEST.json'), JSON.stringify(manifest));
    const release = makeRelease({ manifest, manifestChecksum: computeStringChecksum(JSON.stringify(manifest)) });

    const report = await verifyArtifactIntegrity(release, candidatePath);

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('2. a modified migration file (candidate bytes drifted from the manifest) fails with the exact path/expected/actual', async () => {
    mkdirSync(join(candidatePath, 'dist', 'database', 'migrations', 'targets'), { recursive: true });
    const filePath = join(candidatePath, 'dist', 'database', 'migrations', 'targets', 'CreateTargetsCore.js');
    writeFileSync(filePath, 'EXECUTE PROCEDURE targets_check_non_overlap()');
    const declaredChecksum = await computeFileChecksum(filePath);

    const manifest: ReleaseManifest = {
      version: '1.1.2',
      packageType: 'full',
      files: [{ path: 'dist/database/migrations/targets/CreateTargetsCore.js', action: 'modify', checksum: declaredChecksum }],
      migrations: [],
    };
    writeFileSync(join(candidatePath, 'MANIFEST.json'), JSON.stringify(manifest));
    const release = makeRelease({ manifest, manifestChecksum: computeStringChecksum(JSON.stringify(manifest)) });

    // Candidate drifts AFTER the manifest was written — exactly what an
    // extraction/replacement bug would produce: manifest says one thing,
    // disk has another.
    writeFileSync(filePath, 'EXECUTE PROCEDURE targets_check_non_overlap() -- tampered');
    const actualChecksum = await computeFileChecksum(filePath);

    const report = await verifyArtifactIntegrity(release, candidatePath);

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      { kind: 'file_checksum_mismatch', path: 'dist/database/migrations/targets/CreateTargetsCore.js', expected: declaredChecksum, actual: actualChecksum },
    ]);
    const formatted = formatArtifactIntegrityViolations(release.id, report.violations);
    expect(formatted).toContain(release.id);
    expect(formatted).toContain(declaredChecksum);
    expect(formatted).toContain(actualChecksum);
    expect(formatted).toContain('dist/database/migrations/targets/CreateTargetsCore.js');
  });

  it('3. the OLD CreateTargetsCore (EXECUTE FUNCTION) fails integrity when checked against the CORRECTED manifest — the exact incident, reproduced directly', async () => {
    const OLD_CONTENT = `
      await queryRunner.query(\`
        CREATE TRIGGER "TRG_targets_check_non_overlap"
        BEFORE INSERT OR UPDATE ON "targets"
        FOR EACH ROW EXECUTE FUNCTION targets_check_non_overlap()
      \`);
    `;
    const NEW_CONTENT = `
      await queryRunner.query(\`
        CREATE TRIGGER "TRG_targets_check_non_overlap"
        BEFORE INSERT OR UPDATE ON "targets"
        FOR EACH ROW EXECUTE PROCEDURE targets_check_non_overlap()
      \`);
    `;

    mkdirSync(join(candidatePath, 'dist', 'database', 'migrations', 'targets'), { recursive: true });
    const filePath = join(candidatePath, 'dist', 'database', 'migrations', 'targets', '1789750000000-CreateTargetsCore.js');

    // The manifest (correctly) declares the checksum of the CORRECTED content...
    const tmpForChecksum = filePath + '.correct-reference';
    writeFileSync(tmpForChecksum, NEW_CONTENT);
    const correctedChecksum = await computeFileChecksum(tmpForChecksum);
    rmSync(tmpForChecksum);

    const manifest: ReleaseManifest = {
      version: '1.1.2',
      packageType: 'full',
      files: [{ path: 'dist/database/migrations/targets/1789750000000-CreateTargetsCore.js', action: 'modify', checksum: correctedChecksum }],
      migrations: [],
    };
    writeFileSync(join(candidatePath, 'MANIFEST.json'), JSON.stringify(manifest));
    const release = makeRelease({ manifest, manifestChecksum: computeStringChecksum(JSON.stringify(manifest)) });

    // ...but the candidate's own disk somehow still has the OLD content —
    // exactly the reported production symptom.
    writeFileSync(filePath, OLD_CONTENT);

    const report = await verifyArtifactIntegrity(release, candidatePath);

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].kind).toBe('file_checksum_mismatch');
    expect(report.violations[0].path).toBe('dist/database/migrations/targets/1789750000000-CreateTargetsCore.js');
    expect(report.violations[0].expected).toBe(correctedChecksum);
    // Never blames Postgres for this — the gate names the file and the
    // checksum mismatch directly, instead of the failure surfacing three
    // layers downstream as an opaque "syntax error at or near FUNCTION".
  });

  it('a manifest-identity mismatch (candidate MANIFEST.json disagrees with the release row) is reported even when every individual file checksum happens to match', async () => {
    const manifest: ReleaseManifest = { version: '1.1.2', packageType: 'full', files: [], migrations: [] };
    writeFileSync(join(candidatePath, 'MANIFEST.json'), JSON.stringify(manifest));
    // The release row's own recorded checksum does NOT match what's on disk.
    const release = makeRelease({ manifest, manifestChecksum: 'deliberately-wrong-checksum' });

    const report = await verifyArtifactIntegrity(release, candidatePath);

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      { kind: 'manifest_identity_mismatch', expected: 'deliberately-wrong-checksum', actual: computeStringChecksum(JSON.stringify(manifest)) },
    ]);
  });
});

describe('verifyArtifactIntegrity — re-upload simulation (CTO-required scenario: same version, same release id, real buildCandidate())', () => {
  let deployRoot: string;
  let stagingDir: string;
  let service: StagedActivationService;
  const RELEASE_ID = 'release-x'; // deliberately the SAME id across both "uploads" — registerRelease()'s own REPLACEABLE reuse policy

  const OLD_MIGRATION = `
export class CreateTargetsCore1789750000000 {
  async up(queryRunner) {
    await queryRunner.query(\`
      CREATE TRIGGER "TRG_targets_check_non_overlap"
      BEFORE INSERT OR UPDATE ON "targets"
      FOR EACH ROW EXECUTE FUNCTION targets_check_non_overlap()
    \`);
  }
}
`;
  const NEW_MIGRATION = `
export class CreateTargetsCore1789750000000 {
  async up(queryRunner) {
    await queryRunner.query(\`
      CREATE TRIGGER "TRG_targets_check_non_overlap"
      BEFORE INSERT OR UPDATE ON "targets"
      FOR EACH ROW EXECUTE PROCEDURE targets_check_non_overlap()
    \`);
  }
}
`;
  const MIGRATION_REL_PATH = 'dist/database/migrations/targets/1789750000000-CreateTargetsCore.js';

  beforeEach(() => {
    deployRoot = mkdtempSync(join(tmpdir(), 'reupload-test-'));
    const activeDir = join(deployRoot, 'active');
    mkdirSync(join(activeDir, 'dist'), { recursive: true });
    writeFileSync(join(activeDir, 'dist', 'main.js'), 'console.log(1);');
    writeFileSync(join(activeDir, 'package.json'), JSON.stringify({ name: 'daii-backend', version: '1.1.1' }));

    stagingDir = mkdtempSync(join(tmpdir(), 'reupload-staging-'));
    const configStub = { releaseDeploy: { deployRoot, activeDirname: 'active' } } as AppConfigService;
    service = new StagedActivationService(configStub);
  });

  afterEach(() => {
    rmSync(deployRoot, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  });

  /**
   * Simulates exactly what `uploadPackage()` does to `stagingDir` for a
   * given upload's content: wipe, write fresh — including `MANIFEST.json`
   * at the root, exactly as `PackageValidatorService.validateAndStage()`
   * always does for a real upload (it's the file that proves the ZIP is a
   * real release package at all). This is deliberately real staging
   * content, not a shortcut, so `buildCandidate()`'s own root-file copy
   * loop (package.json/package-lock.json/MANIFEST.json) is exercised for
   * real, not bypassed.
   */
  function stageContent(migrationContent: string): { manifest: ReleaseManifest; checksum: string } {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(join(stagingDir, 'dist', 'database', 'migrations', 'targets'), { recursive: true });
    writeFileSync(join(stagingDir, MIGRATION_REL_PATH), migrationContent);
    const checksum = createHash('sha256').update(migrationContent, 'utf8').digest('hex');
    const manifest: ReleaseManifest = {
      version: '1.1.2',
      packageType: 'full',
      files: [{ path: MIGRATION_REL_PATH, action: 'modify', checksum }],
      migrations: [],
    };
    writeFileSync(join(stagingDir, 'MANIFEST.json'), JSON.stringify(manifest));
    return { manifest, checksum };
  }

  it('4. upload OLD -> candidate 1 genuinely has the OLD bytes, and integrity correctly PASSES for the OLD manifest at that point', async () => {
    const { manifest } = stageContent(OLD_MIGRATION);
    const release = makeRelease({ id: RELEASE_ID, manifest, manifestChecksum: computeStringChecksum(JSON.stringify(manifest)) });

    const candidatePath = await service.buildCandidate(RELEASE_ID, manifest, stagingDir);
    const onDisk = readFileSync(join(candidatePath, MIGRATION_REL_PATH), 'utf8');
    expect(onDisk).toContain('EXECUTE FUNCTION');

    // The gate itself doesn't know old vs. new — it only knows "does the
    // candidate match ITS OWN manifest". At this point it correctly does,
    // for both parts: the per-file checksum AND candidate identity
    // (buildCandidate() now correctly overlays the staged MANIFEST.json —
    // Production Incident 2026-09-22, staged-activation.service.ts).
    const report = await verifyArtifactIntegrity(release, candidatePath);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('5. SAME release id re-uploaded with NEW content -> candidate 2 genuinely has the NEW bytes, no trace of the old FUNCTION content, and integrity passes for the NEW manifest', async () => {
    // Upload 1 (old, broken) — builds candidate 1 for release RELEASE_ID.
    const { manifest: oldManifest } = stageContent(OLD_MIGRATION);
    await service.buildCandidate(RELEASE_ID, oldManifest, stagingDir);

    // Upload 2 (corrected) — re-uploads the SAME version, which
    // registerRelease() resolves to the SAME release id; stagingDir gets
    // wiped and rewritten exactly as uploadPackage() does.
    const { manifest: newManifest } = stageContent(NEW_MIGRATION);
    const release = makeRelease({ id: RELEASE_ID, manifest: newManifest, manifestChecksum: computeStringChecksum(JSON.stringify(newManifest)) });

    const candidatePath = await service.buildCandidate(RELEASE_ID, newManifest, stagingDir);

    const onDisk = readFileSync(join(candidatePath, MIGRATION_REL_PATH), 'utf8');
    expect(onDisk).toContain('EXECUTE PROCEDURE');
    expect(onDisk).not.toContain('EXECUTE FUNCTION');

    // MANIFEST.json is now overlaid by buildCandidate() itself — no manual
    // write needed; this proves the real end-to-end pipeline, not a
    // workaround for the fixed bug.
    const candidateManifest = JSON.parse(readFileSync(join(candidatePath, 'MANIFEST.json'), 'utf8'));
    expect(candidateManifest.version).toBe(newManifest.version);
    const report = await verifyArtifactIntegrity(release, candidatePath);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('6. if the OLD bytes somehow DID survive under the NEW manifest (the exact incident), the gate catches it — never silently passes', async () => {
    stageContent(OLD_MIGRATION);
    const { manifest: newManifest } = stageContent(NEW_MIGRATION);
    // Simulate the reported incident directly: candidate built once for
    // OLD content...
    const candidatePath = await service.buildCandidate(RELEASE_ID, newManifest, stagingDir);
    // ...then, AFTER the candidate exists, something external reverts just
    // this one file back to the old content (standing in for whatever
    // mechanism would have caused the real incident, since none was found
    // in the traced build path itself — the point of this gate is to
    // catch the SYMPTOM regardless of cause).
    writeFileSync(join(candidatePath, MIGRATION_REL_PATH), OLD_MIGRATION);
    // MANIFEST.json itself is correctly overlaid by buildCandidate() —
    // this test only tampers with the migration file, matching "the
    // migration content specifically reverted" incident shape.

    const release = makeRelease({ id: RELEASE_ID, manifest: newManifest, manifestChecksum: computeStringChecksum(JSON.stringify(newManifest)) });
    const report = await verifyArtifactIntegrity(release, candidatePath);

    expect(report.ok).toBe(false);
    expect(report.violations[0].path).toBe(MIGRATION_REL_PATH);
    const formatted = formatArtifactIntegrityViolations(release.id, report.violations);
    expect(formatted).toContain(RELEASE_ID);
    expect(formatted).toContain(MIGRATION_REL_PATH);
  });
});
