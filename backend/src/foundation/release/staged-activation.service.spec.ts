import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StagedActivationService } from './staged-activation.service';
import { ReleaseManifest } from './release-manifest';
import { AppConfigService } from '../configuration/app-config.service';

/**
 * Regression test for the 2026-09-21 incident: `v1.1.0`/`v1.1.1` both
 * failed real Hosting candidate verification with the SAME
 * `dependencies_resolve` error — the probe array never reflected either
 * uploaded package's own corrected `package.json`. Root cause, found by
 * reading `buildCandidate()` directly: `generate_manifest()`
 * (`build-release.sh`) only ever scans `src/ dist/ public/` for
 * `manifest.files[]` — the package-root `package.json`/`package-lock.json`
 * are NEVER listed as delta files, for a `full` package or a `delta` one.
 * `buildCandidate()`'s own delta-overlay loop therefore never touched
 * them, so the CANDIDATE silently kept whatever `package.json` ACTIVE
 * happened to have (`stampVersion` only ever patched the `version`
 * string, never `dependencies`/`devDependencies`) — no dependency-
 * classification fix could ever reach a real candidate through this
 * path, no matter how many patch versions were issued.
 */
describe('StagedActivationService.buildCandidate — package.json/package-lock.json (2026-09-21 incident)', () => {
  let deployRoot: string;
  let stagingDir: string;
  let service: StagedActivationService;

  const ACTIVE_PKG = {
    name: 'daii-backend',
    version: '1.0.10',
    dependencies: { '@types/yauzl': '^3.4.0', bcrypt: '^5.1.1', yauzl: '^3.4.0' }, // the stale, pre-fix shape
  };
  const CANDIDATE_PKG = {
    name: 'daii-backend',
    version: '1.1.1',
    dependencies: { bcrypt: '^5.1.1', 'decimal.js': '10.6.0', yauzl: '^3.4.0' }, // the corrected shape
    devDependencies: { '@types/yauzl': '^3.4.0' },
  };

  beforeEach(() => {
    deployRoot = mkdtempSync(join(tmpdir(), 'staged-activation-test-'));
    const activeDir = join(deployRoot, 'active');
    mkdirSync(join(activeDir, 'dist'), { recursive: true });
    writeFileSync(join(activeDir, 'dist', 'main.js'), 'console.log(1);');
    writeFileSync(join(activeDir, 'package.json'), JSON.stringify(ACTIVE_PKG, null, 2) + '\n');
    writeFileSync(join(activeDir, 'package-lock.json'), JSON.stringify({ name: 'daii-backend', version: ACTIVE_PKG.version }));

    stagingDir = mkdtempSync(join(tmpdir(), 'staged-activation-staging-'));
    mkdirSync(join(stagingDir, 'dist'), { recursive: true });
    writeFileSync(join(stagingDir, 'dist', 'main.js'), 'console.log(2);');
    writeFileSync(join(stagingDir, 'package.json'), JSON.stringify(CANDIDATE_PKG, null, 2) + '\n');
    writeFileSync(join(stagingDir, 'package-lock.json'), JSON.stringify({ name: 'daii-backend', version: CANDIDATE_PKG.version }));

    const configStub = { releaseDeploy: { deployRoot, activeDirname: 'active' } } as AppConfigService;
    service = new StagedActivationService(configStub);
  });

  afterEach(() => {
    rmSync(deployRoot, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  });

  it('copies the CANDIDATE\'s own package.json/package-lock.json from stagingDir — never leaves ACTIVE\'s stale dependencies behind, even when manifest.files[] does not list them (the real generate_manifest() shape)', async () => {
    // Mirrors the real Metadata Contract exactly: dist/main.js is the only delta file listed;
    // package.json/package-lock.json are never in manifest.files[], by construction of the real
    // build-release.sh generate_manifest() (it only scans src/dist/public).
    const manifest: ReleaseManifest = {
      version: CANDIDATE_PKG.version,
      packageType: 'full',
      files: [{ path: 'dist/main.js', action: 'modify', checksum: 'x' }],
      migrations: [],
    };

    const candidatePath = await service.buildCandidate('rel-1', manifest, stagingDir);

    const candidatePkg = JSON.parse(readFileSync(join(candidatePath, 'package.json'), 'utf8'));
    expect(candidatePkg.dependencies).toEqual(CANDIDATE_PKG.dependencies); // the CANDIDATE's own, not ACTIVE's
    expect(candidatePkg.dependencies['@types/yauzl']).toBeUndefined(); // the exact regression this incident found
    expect(candidatePkg.devDependencies).toEqual(CANDIDATE_PKG.devDependencies);
    expect(candidatePkg.version).toBe(CANDIDATE_PKG.version);

    const candidateLock = JSON.parse(readFileSync(join(candidatePath, 'package-lock.json'), 'utf8'));
    expect(candidateLock.version).toBe(CANDIDATE_PKG.version);
  });

  it('still stamps the version onto ACTIVE-inherited package.json as a defensive fallback if stagingDir genuinely has none (a malformed/hand-built package)', async () => {
    rmSync(join(stagingDir, 'package.json'));
    rmSync(join(stagingDir, 'package-lock.json'));
    const manifest: ReleaseManifest = {
      version: '1.1.2',
      packageType: 'full',
      files: [{ path: 'dist/main.js', action: 'modify', checksum: 'x' }],
      migrations: [],
    };

    const candidatePath = await service.buildCandidate('rel-2', manifest, stagingDir);

    const candidatePkg = JSON.parse(readFileSync(join(candidatePath, 'package.json'), 'utf8'));
    expect(candidatePkg.version).toBe('1.1.2'); // stampVersion's own fallback still fires
    expect(candidatePkg.dependencies).toEqual(ACTIVE_PKG.dependencies); // no better source existed — inherited, not invented
  });
});
