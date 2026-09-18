import { Injectable } from '@nestjs/common';
import * as yauzl from 'yauzl';
import { createWriteStream } from 'fs';
import { mkdir, readFile, rm, stat } from 'fs/promises';
import { dirname, join, normalize, resolve, sep } from 'path';
import { pipeline } from 'stream/promises';
import { ReleaseManifest } from './release-manifest';
import { ReleasePackageType } from './release-status';
import { validateManifest } from './manifest-validation';
import { computeFileChecksum } from './checksum';

export interface PackageValidationResult {
  ok: boolean;
  manifest: ReleaseManifest | null;
  errors: string[];
}

/**
 * Release Center — Execution Layer. The security-critical piece: streams
 * an uploaded ZIP via `yauzl` and validates EVERY entry before a single
 * byte is written outside the staging directory. Never executes anything
 * from the archive — this service only ever performs `fs` read/write
 * operations on paths it has independently proven safe; no `require`,
 * `eval`, or `child_process` call ever touches a zip-derived value.
 *
 * The manifest (`MANIFEST.json` at the zip root) is the single source of
 * truth for what the package is allowed to contain — after staging, the
 * staged file set is cross-checked against it in BOTH directions (every
 * manifest file present+checksummed; zero undeclared extra files), so a
 * hidden file smuggled into the zip can never survive validation even if
 * it individually passed every per-entry check.
 */
export const ALLOWED_PREFIXES = ['src/', 'dist/', 'public/'];
/** Root files a package may carry besides MANIFEST.json — needed so a delta that changes dependencies can ship the lockfile for `npm install` on the host (RELEASE_ARTIFACT_SPEC §5). */
export const ALLOWED_ROOT_FILES = ['MANIFEST.json', 'package.json', 'package-lock.json'];
const DENYLISTED_EXACT = ['.env'];
const DENYLISTED_PREFIXES = ['node_modules/'];
const DANGEROUS_EXTENSIONS = ['.sh', '.exe', '.bat', '.ps1', '.dll', '.so', '.cmd', '.msi'];
const S_IFLNK = 0o120000;
const S_IFMT = 0o170000;

@Injectable()
export class PackageValidatorService {
  async validateAndStage(zipFilePath: string, stagingDir: string, packageType: ReleasePackageType): Promise<PackageValidationResult> {
    const errors: string[] = [];
    await mkdir(stagingDir, { recursive: true });

    let zipFile: yauzl.ZipFile;
    try {
      zipFile = await yauzl.openPromise(zipFilePath, { lazyEntries: true, autoClose: true, strictFileNames: true });
    } catch (err) {
      return { ok: false, manifest: null, errors: [`Invalid or unreadable ZIP file: ${(err as Error).message}`] };
    }

    const stagedRelativePaths: string[] = [];

    try {
      for await (const entry of zipFile.eachEntry()) {
        const entryError = this.checkEntrySafety(entry.fileName, entry.externalFileAttributes);
        if (entryError) {
          errors.push(entryError);
          continue;
        }

        // Directory entries (trailing slash) never need extraction — only create the dir if referenced by a file.
        if (entry.fileName.endsWith('/')) {
          continue;
        }

        const destPath = join(stagingDir, entry.fileName);
        // Defense in depth beyond the string-based ".." check above — catches
        // encoding tricks the string check might miss (e.g. mixed separators).
        const resolvedDest = resolve(destPath);
        const resolvedStagingDir = resolve(stagingDir);
        if (resolvedDest !== resolvedStagingDir && !resolvedDest.startsWith(resolvedStagingDir + sep)) {
          errors.push(`Rejected entry that resolves outside the staging directory: "${entry.fileName}".`);
          continue;
        }
        await mkdir(dirname(destPath), { recursive: true });

        const readStream = await zipFile.openReadStreamPromise(entry);
        const writeStream = createWriteStream(destPath);
        await pipeline(readStream, writeStream);

        stagedRelativePaths.push(entry.fileName);
      }
    } catch (err) {
      errors.push(`Failed while reading ZIP contents: ${(err as Error).message}`);
    }

    if (errors.length > 0) {
      await rm(stagingDir, { recursive: true, force: true });
      return { ok: false, manifest: null, errors };
    }

    if (!stagedRelativePaths.includes('MANIFEST.json')) {
      await rm(stagingDir, { recursive: true, force: true });
      return { ok: false, manifest: null, errors: ['Package is missing MANIFEST.json at its root.'] };
    }

    let manifest: ReleaseManifest;
    try {
      const raw = await readFile(join(stagingDir, 'MANIFEST.json'), 'utf8');
      manifest = JSON.parse(raw) as ReleaseManifest;
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true });
      return { ok: false, manifest: null, errors: [`MANIFEST.json is not valid JSON: ${(err as Error).message}`] };
    }

    const manifestErrors = validateManifest(manifest, packageType);
    errors.push(...manifestErrors);

    const crossCheckErrors = await this.crossCheckManifestAgainstStaged(manifest, stagingDir, stagedRelativePaths);
    errors.push(...crossCheckErrors);

    const bundleErrors = await this.crossCheckFrontendBundle(manifest, stagingDir);
    errors.push(...bundleErrors);

    if (errors.length > 0) {
      await rm(stagingDir, { recursive: true, force: true });
      // The manifest itself DID parse — returned (not null) so the caller
      // can still record a Release row keyed by its version/packageType,
      // clearly marked failed, rather than losing all trace of the attempt.
      return { ok: false, manifest, errors };
    }

    return { ok: true, manifest, errors: [] };
  }

  /** Per-entry safety gate — runs BEFORE any bytes are written for that entry. */
  private checkEntrySafety(fileName: string, externalFileAttributes: number): string | null {
    if (fileName.startsWith('/') || fileName.startsWith('\\') || /^[a-zA-Z]:/.test(fileName)) {
      return `Rejected absolute path entry: "${fileName}".`;
    }
    // v1.0.3 report item 7: the manual delta zip was built on Windows and
    // used "\" as the path separator ("appears to use backslashes as path
    // separators"), which broke extraction. A conformant zip uses "/" only.
    if (fileName.includes('\\')) {
      return `Rejected entry with a backslash path separator (non-conformant zip — build the package with forward slashes only): "${fileName}".`;
    }
    const normalized = normalize(fileName);
    if (normalized.split(/[\\/]/).includes('..')) {
      return `Rejected path-traversal entry: "${fileName}".`;
    }

    const unixMode = (externalFileAttributes >>> 16) & S_IFMT;
    if (unixMode === S_IFLNK) {
      return `Rejected symlink entry: "${fileName}".`;
    }

    if (DENYLISTED_EXACT.includes(fileName)) {
      return `Rejected denylisted file: "${fileName}".`;
    }
    if (DENYLISTED_PREFIXES.some((prefix) => fileName.startsWith(prefix))) {
      return `Rejected denylisted path: "${fileName}".`;
    }

    const isAllowedRootFile = ALLOWED_ROOT_FILES.includes(fileName);
    const isAllowedPrefix = ALLOWED_PREFIXES.some((prefix) => fileName.startsWith(prefix));
    if (!isAllowedRootFile && !isAllowedPrefix) {
      return `Rejected entry outside allowed paths (${ALLOWED_ROOT_FILES.join(', ')}, src/, dist/, public/): "${fileName}".`;
    }

    const lower = fileName.toLowerCase();
    if (DANGEROUS_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      return `Rejected dangerous file extension: "${fileName}".`;
    }

    return null;
  }

  /**
   * Bidirectional cross-check: every manifest 'add'/'modify' file must be
   * physically staged with a matching checksum; every physically staged
   * file (besides MANIFEST.json itself) must be declared by the manifest
   * — closes the "hidden extra file smuggled into the zip" vector even
   * when that file individually passed every per-entry check above.
   */
  private async crossCheckManifestAgainstStaged(manifest: ReleaseManifest, stagingDir: string, stagedRelativePaths: string[]): Promise<string[]> {
    const errors: string[] = [];
    const declaredPaths = new Set(manifest.files?.map((f) => f.path) ?? []);

    for (const file of manifest.files ?? []) {
      if (file.action === 'delete') continue;
      const absolutePath = join(stagingDir, file.path);
      try {
        const info = await stat(absolutePath);
        if (!info.isFile()) {
          errors.push(`Manifest file "${file.path}" is not a regular file in the package.`);
          continue;
        }
      } catch {
        errors.push(`Manifest declares "${file.path}" (${file.action}) but it is not present in the package.`);
        continue;
      }
      const actualChecksum = await computeFileChecksum(absolutePath);
      if (file.checksum && actualChecksum !== file.checksum) {
        errors.push(`Checksum mismatch for "${file.path}": manifest declares "${file.checksum}", actual is "${actualChecksum}".`);
      }
    }

    for (const stagedPath of stagedRelativePaths) {
      if (ALLOWED_ROOT_FILES.includes(stagedPath)) continue;
      if (!declaredPaths.has(stagedPath)) {
        errors.push(`Package contains undeclared file not listed in MANIFEST.json: "${stagedPath}".`);
      }
    }

    return errors;
  }

  /**
   * Frontend-bundle drift guard (v1.0.3 report items 6/33/34). The actual
   * v1.0.3 site bug: `frontend/dist` was rebuilt but `backend/public` kept
   * serving the previous hashed bundle. If a package ships a new/modified
   * `public/index.html`, it MUST also carry every `assets/*.{js,css}` that
   * `index.html` references — otherwise deploying it leaves the served page
   * pointing at bundle files that aren't there.
   */
  private async crossCheckFrontendBundle(manifest: ReleaseManifest, stagingDir: string): Promise<string[]> {
    const errors: string[] = [];
    const files = manifest.files ?? [];
    const indexEntry = files.find((f) => f.path === 'public/index.html' && f.action !== 'delete');
    if (!indexEntry) return errors;

    let html: string;
    try {
      html = await readFile(join(stagingDir, 'public/index.html'), 'utf8');
    } catch {
      return errors; // the manifest cross-check above already reports a missing declared file
    }

    const declaredNonDelete = new Set(files.filter((f) => f.action !== 'delete').map((f) => f.path));
    const re = /(?:src|href)\s*=\s*["']([^"']*\/assets\/[^"']+\.(?:js|css)[^"']*)["']/gi;
    let m: RegExpExecArray | null;
    const referenced = new Set<string>();
    while ((m = re.exec(html)) !== null) {
      const rel = 'public/' + m[1].replace(/^\.?\//, '').replace(/^public\//, '').split('?')[0];
      referenced.add(rel);
    }

    for (const rel of referenced) {
      if (!declaredNonDelete.has(rel)) {
        errors.push(
          `Frontend bundle drift: public/index.html references "${rel}" but the package does not include it. ` +
            'A package that changes index.html must ship every asset bundle it points to (v1.0.3 site-bug guard).',
        );
        continue;
      }
      const staged = await stat(join(stagingDir, rel))
        .then((s) => s.isFile() && s.size > 0)
        .catch(() => false);
      if (!staged) {
        errors.push(`Frontend bundle drift: declared asset "${rel}" is missing or empty in the package.`);
      }
    }

    return errors;
  }
}
