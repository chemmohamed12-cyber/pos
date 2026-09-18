import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Exercises the REAL `tools/build/build-release.sh` `generate_manifest()`
 * step (`--manifest-only` mode) against a synthetic staged tree — not a
 * re-implementation of its logic in TypeScript. This is the same technique
 * used to verify the Metadata Contract fields during the 2026-09-15
 * overhaul (direct `--manifest-only` execution against a populated and an
 * all-empty synthetic tree) — the actual generated JSON is checked, never
 * only the TS interface shape.
 */
const SCRIPT = join(__dirname, '..', '..', '..', 'tools', 'build', 'build-release.sh');

function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'true']);
    return true;
  } catch {
    return false;
  }
}

const describeIfBash = bashAvailable() ? describe : describe.skip;

describeIfBash('build-release.sh generate_manifest (Metadata Contract)', () => {
  let stagedDir: string;

  afterEach(() => {
    if (stagedDir) rmSync(stagedDir, { recursive: true, force: true });
  });

  function runManifestOnly(extraArgs: string[] = []): Record<string, unknown> {
    execFileSync('bash', [SCRIPT, '--manifest-only', stagedDir, ...extraArgs], { stdio: 'pipe' });
    return JSON.parse(readFileSync(join(stagedDir, 'MANIFEST.json'), 'utf8'));
  }

  it('populates database.{migrationRequired,migrationCount} from a PER-TAG migration scan, mirroring discoverMigrationTags()', () => {
    stagedDir = mkdtempSync(join(tmpdir(), 'release-manifest-test-'));
    mkdirSync(join(stagedDir, 'dist', 'database', 'migrations', 'core'), { recursive: true });
    mkdirSync(join(stagedDir, 'dist', 'database', 'migrations', 'accounting'), { recursive: true });
    mkdirSync(join(stagedDir, 'src'), { recursive: true });
    mkdirSync(join(stagedDir, 'public'), { recursive: true });
    writeFileSync(join(stagedDir, 'package.json'), JSON.stringify({ name: 'daii-backend', version: '1.0.10', dependencies: { 'decimal.js': '10.6.0', pg: '^8.13.1' } }));
    writeFileSync(join(stagedDir, 'dist', 'database', 'migrations', 'core', '1755840000000-BootstrapCheck.js'), `class BootstrapCheck1755840000000 {}\nBootstrapCheck1755840000000.prototype.name = undefined;\nexports.BootstrapCheck1755840000000 = BootstrapCheck1755840000000;\nexports.BootstrapCheck1755840000000.prototype.name = 'BootstrapCheck1755840000000';\n  name = 'BootstrapCheck1755840000000';\n`);
    writeFileSync(join(stagedDir, 'dist', 'database', 'migrations', 'accounting', '1755841000000-CreateGlAccounts.js'), `class CreateGlAccounts1755841000000 {\n  name = 'CreateGlAccounts1755841000000';\n}\n`);
    writeFileSync(join(stagedDir, 'dist', 'main.js'), 'console.log(1);');

    const manifest = runManifestOnly(['--package-type', 'full']);

    expect(manifest.version).toBe('1.0.10');
    expect(manifest.migrations).toEqual(['BootstrapCheck1755840000000', 'CreateGlAccounts1755841000000']);
    expect(manifest.database).toEqual({ migrationRequired: true, migrationCount: 2 });
  });

  it('populates runtimeDependencies verbatim from the staged package.json — the fix for the "declared in the type but never populated" gap (Production Incident 2026-09-15)', () => {
    stagedDir = mkdtempSync(join(tmpdir(), 'release-manifest-test-'));
    mkdirSync(join(stagedDir, 'dist'), { recursive: true });
    writeFileSync(join(stagedDir, 'package.json'), JSON.stringify({ name: 'daii-backend', version: '1.0.10', dependencies: { 'decimal.js': '10.6.0', pg: '^8.13.1', typeorm: '^0.3.20' } }));
    writeFileSync(join(stagedDir, 'dist', 'main.js'), 'x');

    const manifest = runManifestOnly(['--package-type', 'full']);

    expect(manifest.runtimeDependencies).toEqual({ 'decimal.js': '10.6.0', pg: '^8.13.1', typeorm: '^0.3.20' });
  });

  it('emits database.migrationRequired=false and migrationCount=0 for a package with no migrations at all — never invented as true', () => {
    stagedDir = mkdtempSync(join(tmpdir(), 'release-manifest-test-'));
    mkdirSync(join(stagedDir, 'dist'), { recursive: true });
    writeFileSync(join(stagedDir, 'package.json'), JSON.stringify({ name: 'daii-backend', version: '0.0.1', dependencies: {} }));
    writeFileSync(join(stagedDir, 'dist', 'main.js'), 'x');

    const manifest = runManifestOnly(['--package-type', 'full']);

    expect(manifest.database).toEqual({ migrationRequired: false, migrationCount: 0 });
    expect(manifest.migrations).toEqual([]);
    expect(manifest.runtimeDependencies).toEqual({});
  });

  it('omits minimumCompatibleVersion entirely when not passed — never invented/guessed by the script', () => {
    stagedDir = mkdtempSync(join(tmpdir(), 'release-manifest-test-'));
    mkdirSync(join(stagedDir, 'dist'), { recursive: true });
    writeFileSync(join(stagedDir, 'package.json'), JSON.stringify({ name: 'daii-backend', version: '1.0.10', dependencies: {} }));
    writeFileSync(join(stagedDir, 'dist', 'main.js'), 'x');

    const manifest = runManifestOnly(['--package-type', 'full']);

    expect(manifest.minimumCompatibleVersion).toBeUndefined();
  });

  it('sets minimumCompatibleVersion when explicitly passed via --min-compatible-version', () => {
    stagedDir = mkdtempSync(join(tmpdir(), 'release-manifest-test-'));
    mkdirSync(join(stagedDir, 'dist'), { recursive: true });
    writeFileSync(join(stagedDir, 'package.json'), JSON.stringify({ name: 'daii-backend', version: '1.0.10', dependencies: {} }));
    writeFileSync(join(stagedDir, 'dist', 'main.js'), 'x');

    const manifest = runManifestOnly(['--package-type', 'full', '--min-compatible-version', '1.0.5']);

    expect(manifest.minimumCompatibleVersion).toBe('1.0.5');
  });

  it('produces a manifest whose database.migrationCount always matches migrations.length by construction (same scan)', () => {
    stagedDir = mkdtempSync(join(tmpdir(), 'release-manifest-test-'));
    mkdirSync(join(stagedDir, 'dist', 'database', 'migrations', 'sales'), { recursive: true });
    mkdirSync(join(stagedDir, 'dist', 'database', 'migrations', 'logistics'), { recursive: true });
    writeFileSync(join(stagedDir, 'package.json'), JSON.stringify({ name: 'daii-backend', version: '1.0.10', dependencies: {} }));
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(stagedDir, 'dist', 'database', 'migrations', 'sales', `175584${i}000000-Mig${i}.js`), `class Mig${i} {\n  name = 'Mig${i}175584${i}000000';\n}\n`);
    }
    writeFileSync(join(stagedDir, 'dist', 'database', 'migrations', 'logistics', '1755847000000-LogMig.js'), `class LogMig {\n  name = 'LogMig1755847000000';\n}\n`);
    writeFileSync(join(stagedDir, 'dist', 'main.js'), 'x');

    const manifest = runManifestOnly(['--package-type', 'full']);

    const migrations = manifest.migrations as string[];
    const database = manifest.database as { migrationCount: number };
    expect(database.migrationCount).toBe(migrations.length);
    expect(migrations.length).toBe(4);
  });
});
