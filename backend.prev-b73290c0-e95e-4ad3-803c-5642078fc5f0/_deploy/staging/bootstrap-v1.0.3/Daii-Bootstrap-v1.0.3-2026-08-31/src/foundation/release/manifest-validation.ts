import { ReleaseManifest } from './release-manifest';
import { ReleasePackageType } from './release-status';
import { readAppVersion } from './app-version';

/**
 * Shared manifest-validation logic — used by both `ReleaseManagerService`
 * (JSON-only registration path) and `PackageValidatorService` (real ZIP
 * upload path) so the two never drift apart. A `'delta'` package's
 * `baseVersion` is checked against the currently installed version
 * (`readAppVersion()`) — a mismatch is a validation error, never silently
 * accepted, per the CTO directive's explicit "REJECT UPDATE" rule.
 */
export function validateManifest(manifest: ReleaseManifest, packageType: ReleasePackageType): string[] {
  const errors: string[] = [];
  if (!manifest.version || manifest.version.trim().length === 0) {
    errors.push('Manifest is missing "version".');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push('Manifest has no files listed.');
  } else {
    for (const file of manifest.files) {
      if ((file.action === 'add' || file.action === 'modify') && !file.checksum) {
        errors.push(`File "${file.path}" (${file.action}) is missing a checksum.`);
      }
    }
  }
  if (!Array.isArray(manifest.migrations)) {
    errors.push('Manifest is missing "migrations" (use an empty array if none).');
  }

  if (packageType === 'delta') {
    if (!manifest.baseVersion) {
      errors.push('Delta package manifest is missing "baseVersion".');
    } else {
      const installedVersion = readAppVersion();
      if (manifest.baseVersion !== installedVersion) {
        errors.push(
          `Base version mismatch: this delta requires "${manifest.baseVersion}", but the installed version is "${installedVersion}". Reject update.`,
        );
      }
    }
  }

  return errors;
}
