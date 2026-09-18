/**
 * Metadata Contract (CTO Directive, phase 2 of the Migration Preflight →
 * Metadata Contract → Upgrade Resolver → Release Center UI → Full
 * Regression sequence). This project's versions are plain dotted numerics
 * (`X.Y.Z`, e.g. "1.0.9") — not a full semver implementation (no
 * pre-release/build-metadata segments), deliberately: matches every
 * version string this codebase actually produces (`package.json`,
 * `readAppVersion()`, `ReleaseManifest.version`/`baseVersion`).
 */

/** -1 if `a` < `b`, 0 if equal, 1 if `a` > `b`. Missing/non-numeric segments compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function isVersionAtLeast(actual: string, minimum: string): boolean {
  return compareVersions(actual, minimum) >= 0;
}
