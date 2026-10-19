import { createWriteStream, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as yazl from 'yazl';
import { PayloadTooLargeException } from '@nestjs/common';
import { PackageValidatorService } from './package-validator.service';
import { computeStringChecksum } from './checksum';
import { diagnoseBinary } from './binary-check';
import { DeployPreflightService } from './deploy-preflight.service';
import { ReleaseUploadInterceptor } from './release-upload.interceptor';
import { AppConfigService } from '../configuration/app-config.service';

/**
 * Release Center upload readiness (CTO 2026-10-19). Isolated: every file lives in a unique temp directory that is removed afterwards; nothing is published, deployed or executed, and no
 * database is touched. Duplicate-version behaviour and upgrade-path resolution have their own suites (release-manager.service.spec, upgrade-resolver.spec) and are re-run with this one.
 */
describe('Release Center upload readiness', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-upload-readiness-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const content = 'module.exports = 42;\n';
  async function makeZip(name: string, entries: Record<string, string>): Promise<string> {
    const zipPath = join(dir, name);
    const zip = new yazl.ZipFile();
    for (const [p, c] of Object.entries(entries)) zip.addBuffer(Buffer.from(c), p);
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(zipPath);
      out.on('close', () => resolve());
      out.on('error', reject);
      zip.outputStream.pipe(out);
    });
    return zipPath;
  }
  const manifestFor = (checksum: string, version = '9.9.9') =>
    JSON.stringify({ version, packageType: 'full', files: [{ path: 'dist/app.js', action: 'modify', checksum }], migrations: [] });
  const goodChecksum = () => computeStringChecksum(content);
  const validator = new PackageValidatorService();
  const stage = (zip: string) => validator.validateAndStage(zip, join(dir, 'staging'), 'full');

  describe('package integrity (the checks are NOT weakened)', () => {
    it('a valid package within the limit is validated and staged', async () => {
      const r = await stage(await makeZip('ok.zip', { 'MANIFEST.json': manifestFor(goodChecksum()), 'dist/app.js': content }));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.manifest?.version).toBe('9.9.9');
      expect(existsSync(join(dir, 'staging', 'dist', 'app.js'))).toBe(true);
    });

    it('a corrupted ZIP is rejected with a reason and stages nothing', async () => {
      const bad = join(dir, 'bad.zip');
      writeFileSync(bad, Buffer.from('PK\u0003\u0004 this is not a real archive'));
      const r = await stage(bad);
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/Invalid or unreadable ZIP/);
      expect(existsSync(join(dir, 'staging', 'dist'))).toBe(false);
    });

    it('a checksum mismatch is rejected and the staging directory is removed', async () => {
      const r = await stage(await makeZip('sum.zip', { 'MANIFEST.json': manifestFor('0'.repeat(64)), 'dist/app.js': content }));
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/checksum/i);
      expect(existsSync(join(dir, 'staging'))).toBe(false);
    });

    it('a file that is not declared in the manifest, and a missing MANIFEST.json, are rejected', async () => {
      const undeclared = await stage(await makeZip('extra.zip', { 'MANIFEST.json': manifestFor(goodChecksum()), 'dist/app.js': content, 'dist/extra.js': 'x' }));
      expect(undeclared.ok).toBe(false);
      const noManifest = await validator.validateAndStage(await makeZip('nomf.zip', { 'dist/app.js': content }), join(dir, 'staging2'), 'full');
      expect(noManifest.ok).toBe(false);
      expect(noManifest.errors.join(' ')).toMatch(/MANIFEST\.json/);
    });

    it('a malformed manifest (no version) and a wrong package type are rejected', async () => {
      const noVersion = await stage(await makeZip('nov.zip', { 'MANIFEST.json': JSON.stringify({ packageType: 'full', files: [], migrations: [] }), 'dist/app.js': content }));
      expect(noVersion.ok).toBe(false);
      const wrongType = await validator.validateAndStage(await makeZip('ty.zip', { 'MANIFEST.json': manifestFor(goodChecksum()), 'dist/app.js': content }), join(dir, 'staging3'), 'delta');
      expect(wrongType.ok).toBe(false);
    });

    it('path traversal, absolute paths, denied files and dangerous extensions are rejected', async () => {
      // yazl refuses to WRITE an unsafe entry name, so those two are built with a same-length safe name and patched in the archive bytes (name bytes are not covered by the CRC).
      const patched = async (safe: string, unsafe: string) => {
        const zipPath = await makeZip(`p-${safe.replace(/\W/g, '')}.zip`, { 'MANIFEST.json': manifestFor(goodChecksum()), [safe]: 'x' });
        const bytes = readFileSync(zipPath);
        let at = bytes.indexOf(safe);
        while (at !== -1) {
          bytes.write(unsafe, at, 'latin1');
          at = bytes.indexOf(safe, at + 1);
        }
        writeFileSync(zipPath, bytes);
        return zipPath;
      };
      const cases: string[] = [];
      cases.push(await patched('xx/evil.js', '../evil.js'), await patched('Xabs.js', '/abs.js'));
      for (const bad of ['.env', 'node_modules/x.js', 'dist/run.sh']) cases.push(await makeZip(`d-${bad.replace(/\W/g, '')}.zip`, { 'MANIFEST.json': manifestFor(goodChecksum()), [bad]: 'x' }));
      for (const [i, z] of cases.entries()) {
        const r = await validator.validateAndStage(z, join(dir, `st-${i}`), 'full');
        expect([i, r.ok]).toEqual([i, false]);
        expect(existsSync(join(dir, 'evil.js'))).toBe(false); // nothing escaped the staging directory
      }
    });
  });

  describe('pg_dump / pg_restore diagnostics (absolute-path rule kept; nothing executed)', () => {
    it('unset, bare command, missing file, directory are refused with the variable named', async () => {
      expect((await diagnoseBinary('PG_DUMP_BIN', undefined)).detail).toMatch(/PG_DUMP_BIN is not set/);
      const bare = await diagnoseBinary('PG_DUMP_BIN', 'pg_dump');
      expect(bare.ok).toBe(false);
      expect(bare.detail).toMatch(/not an absolute path/);
      expect(bare.detail).toMatch(/PG_DUMP_BIN/);
      const missing = await diagnoseBinary('PG_RESTORE_BIN', join(dir, 'no-such-pg_restore.exe'));
      expect(missing.ok).toBe(false);
      expect(missing.detail).toMatch(/does not exist/);
      const isDir = await diagnoseBinary('PG_RESTORE_BIN', dir);
      expect(isDir.ok).toBe(false);
      expect(isDir.detail).toMatch(/not a file/);
    });

    it('an existing absolute executable path passes (existence + kind + permission only)', async () => {
      const d = await diagnoseBinary('NODE_BIN', process.execPath);
      expect(d).toEqual({ ok: true, detail: process.execPath });
    });

    it('a file without the execute bit is refused on POSIX (the check is skipped on Windows, where X_OK equals existence)', async () => {
      if (process.platform === 'win32') return;
      const f = join(dir, 'tool');
      writeFileSync(f, '#!/bin/sh\n', { mode: 0o644 });
      const d = await diagnoseBinary('PG_DUMP_BIN', f);
      expect(d.ok).toBe(false);
      expect(d.detail).toMatch(/not executable/);
    });

    it('the deploy preflight reports the bare pg_dump as a failing critical check naming PG_DUMP_BIN, and passes with an absolute path', async () => {
      const mk = (pgDump: string, pgRestore: string) =>
        new DeployPreflightService({ query: async () => { throw new Error('no db in this test'); } } as never, {
          releaseBuild: { nodeBin: process.execPath, npmBin: 'npm' },
          releaseBackup: { pgDumpBin: pgDump, pgRestoreBin: pgRestore, storagePath: dir },
          releaseExecution: { appRoot: dir, frontendRuntimePath: dir, passengerRestartFile: join(dir, 'restart.txt'), stagingPath: dir },
          database: { host: 'h', database: 'd' },
        } as unknown as AppConfigService);
      const bad = await mk('pg_dump', 'pg_restore').runPreflight();
      const dump = bad.checks.find((c) => c.name === 'bin.pg_dump')!;
      expect([dump.status, dump.critical]).toEqual(['fail', true]);
      expect(dump.detail).toMatch(/PG_DUMP_BIN/);
      expect(bad.ok).toBe(false);
      const good = await mk(process.execPath, process.execPath).runPreflight();
      expect(good.checks.find((c) => c.name === 'bin.pg_dump')!.status).toBe('pass');
      expect(good.checks.find((c) => c.name === 'bin.pg_restore')!.status).toBe('pass');
    });
  });

  describe('upload size limit (RELEASE_UPLOAD_MAX_MB)', () => {
    const ctx = (len: number) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { 'content-length': String(len) } }) }) }) as never;
    const interceptor = (mb: number) => new ReleaseUploadInterceptor({ releaseUploadMaxBytes: mb * 1024 * 1024 } as unknown as AppConfigService);

    it('an upload above the configured cap is a 413 that names the cap and the setting, before any byte is stored', async () => {
      const before = (await import('fs')).readdirSync(tmpdir()).filter((f) => f.startsWith('release-upload-')).length;
      await expect(interceptor(200).intercept(ctx(201 * 1024 * 1024 + 5), { handle: () => { throw new Error('must not reach the handler'); } } as never)).rejects.toThrow(PayloadTooLargeException);
      await expect(interceptor(200).intercept(ctx(250 * 1024 * 1024), { handle: () => undefined } as never)).rejects.toThrow(/200 MB \(RELEASE_UPLOAD_MAX_MB\)/);
      await expect(interceptor(500).intercept(ctx(600 * 1024 * 1024), { handle: () => undefined } as never)).rejects.toThrow(/500 MB/);
      const after = (await import('fs')).readdirSync(tmpdir()).filter((f) => f.startsWith('release-upload-')).length;
      expect(after).toBe(before);
    });

    it('the default configuration value is 200 MB and the schema rejects a non-positive or absurd value', async () => {
      const { configurationValidationSchema } = await import('../configuration/configuration.schema');
      const key = configurationValidationSchema.extract('RELEASE_UPLOAD_MAX_MB');
      expect(key.validate(undefined).value).toBe(200);
      expect(key.validate(500).error).toBeUndefined();
      expect(key.validate(0).error).toBeDefined();
      expect(key.validate(99999).error).toBeDefined();
    });
  });
});
