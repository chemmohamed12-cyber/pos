import { ReleaseManifest } from './release-manifest';
import { ReleasePackageType } from './release-status';
import { readAppVersion } from './app-version';
import { MODULE_REGISTRY } from '../module-registry/module-registry';
import { isVersionAtLeast } from './version-compare';

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

  // ERP Foundation P6 — Edition entitlement section (optional).
  if (manifest.entitlement) {
    const e = manifest.entitlement;
    if (!e.editionCode || e.editionCode.trim().length === 0) {
      errors.push('Manifest entitlement is missing "editionCode".');
    }
    if (!e.manifestPath || e.manifestPath.trim().length === 0) {
      errors.push('Manifest entitlement is missing "manifestPath" (the signed entitlement.manifest.json inside the package).');
    }
    if (!Array.isArray(e.moduleCodes) || e.moduleCodes.length === 0) {
      errors.push('Manifest entitlement "moduleCodes" must list at least one authored module_code.');
    } else {
      const authored = new Set<string>(MODULE_REGISTRY.authoredModuleCodes());
      for (const code of e.moduleCodes) {
        if (!authored.has(code)) {
          errors.push(`Manifest entitlement references unknown module_code "${code}" (authored: ${[...authored].join(', ')}).`);
        }
      }
    }
    // the manifestPath / signaturePath files themselves are checked to exist in
    // the staged package by PackageValidatorService (real ZIP path); this
    // shared validator only checks the manifest's own shape.
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

  // Metadata Contract — `minimumCompatibleVersion` is a FLOOR checked for BOTH package types
  // (unlike `baseVersion`, which is delta-only and exact-match). Absent = no known floor.
  if (manifest.minimumCompatibleVersion) {
    const installedVersion = readAppVersion();
    if (!isVersionAtLeast(installedVersion, manifest.minimumCompatibleVersion)) {
      errors.push(
        `Minimum compatible version not met: this release requires at least "${manifest.minimumCompatibleVersion}", but the installed version is "${installedVersion}". Reject update.`,
      );
    }
  }

  // Metadata Contract — the manifest's own declared migration count/requirement must agree with
  // its own `migrations` list (an internally-inconsistent manifest is rejected here, before it ever
  // reaches the Migration Preflight's independent, deploy-time cross-check against the real DB/disk).
  if (manifest.database) {
    const declaredCount = Array.isArray(manifest.migrations) ? manifest.migrations.length : 0;
    if (manifest.database.migrationCount !== declaredCount) {
      errors.push(
        `Manifest "database.migrationCount" (${manifest.database.migrationCount}) does not match "migrations".length (${declaredCount}) — internally inconsistent manifest.`,
      );
    }
    if (manifest.database.migrationRequired !== declaredCount > 0) {
      errors.push(`Manifest "database.migrationRequired" (${manifest.database.migrationRequired}) does not match whether "migrations" is non-empty (${declaredCount > 0}).`);
    }
  }

  return errors;
}
