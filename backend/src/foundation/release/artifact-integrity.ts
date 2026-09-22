import { join } from 'path';
import { readFile } from 'fs/promises';
import { computeFileChecksum, computeStringChecksum } from './checksum';
import { Release } from './release.entity';
import { ReleaseManifest } from './release-manifest';

/**
 * Production Incident 2026-09-22 — a corrected v1.1.2 re-upload registered
 * correctly (the `releases` row's own `manifestChecksum` provably matched
 * the corrected package), yet the candidate built for that exact release id
 * still ran the OLD `CreateTargetsCore` (`EXECUTE FUNCTION`, PG11+-only
 * syntax) against production's PG10.23. Every stage traced from source
 * (upload -> registerRelease -> stage -> buildCandidate) correctly wipes
 * and rebuilds keyed by release id — no code-level staleness was found —
 * but nothing in the pipeline ever PROVED that what `buildCandidate()`
 * actually assembled on disk matches what the manifest (and therefore the
 * operator's own upload) declares. Trusting "the build steps look
 * correct" is not the same as verifying the actual bytes; this module
 * closes that gap as an explicit, mandatory pre-swap gate, not a retrofit
 * that makes the symptom go away — a mismatch here must be loud and
 * specific (which file, what was expected, what's actually on disk),
 * never a downstream, unrelated-looking error (like a Postgres syntax
 * error for a migration file that silently isn't the one that was
 * uploaded).
 */
export interface ArtifactIntegrityViolation {
  kind: 'manifest_identity_mismatch' | 'file_checksum_mismatch' | 'file_unreadable';
  /** Relative path within the candidate, for a per-file violation. Absent for a manifest-identity violation. */
  path?: string;
  expected: string;
  actual: string;
}

export interface ArtifactIntegrityReport {
  releaseId: string;
  ok: boolean;
  violations: ArtifactIntegrityViolation[];
}

/** `"<n> violation(s) for release <releaseId>: <path-or-'manifest identity'>: expected <e>, actual <a> | ..."` — one line, safe to put straight into a thrown error/audit record. */
export function formatArtifactIntegrityViolations(releaseId: string, violations: ArtifactIntegrityViolation[]): string {
  const detail = violations
    .map((v) => `${v.path ?? 'manifest identity'}: expected ${v.expected}, actual ${v.actual}`)
    .join(' | ');
  return `Artifact integrity check failed for release ${releaseId}: ${violations.length} violation(s): ${detail}`;
}

/**
 * Verifies the CANDIDATE tree at `candidatePath` actually contains what
 * `release.manifest` declares, in two parts:
 *
 * 1. Candidate identity — the `MANIFEST.json` physically staged in the
 *    candidate must checksum (by content, the same `computeStringChecksum`
 *    `registerRelease()` used) to the exact same value as `release.
 *    manifestChecksum` already recorded on the `releases` row. This is
 *    the "did the DB's idea of this release and the disk's idea of this
 *    release ever diverge" check.
 * 2. Per-file integrity — every `add`/`modify` entry in `release.manifest.
 *    files` must have its actual on-disk SHA-256 (candidatePath + path)
 *    equal to its own declared `checksum`. This is the "is every
 *    individual file actually the bytes the manifest says it is" check —
 *    the one that would have caught an old `CreateTargetsCore.js`
 *    surviving under a corrected manifest.
 *
 * Read-only — never modifies the candidate, ACTIVE, or any DB row itself;
 * the caller decides what to do with a non-ok report (abort pre-swap).
 */
export async function verifyArtifactIntegrity(release: Release, candidatePath: string): Promise<ArtifactIntegrityReport> {
  const violations: ArtifactIntegrityViolation[] = [];

  let candidateManifest: ReleaseManifest | null = null;
  try {
    const raw = await readFile(join(candidatePath, 'MANIFEST.json'), 'utf8');
    candidateManifest = JSON.parse(raw) as ReleaseManifest;
    const candidateManifestChecksum = computeStringChecksum(JSON.stringify(candidateManifest));
    if (candidateManifestChecksum !== release.manifestChecksum) {
      violations.push({ kind: 'manifest_identity_mismatch', expected: release.manifestChecksum, actual: candidateManifestChecksum });
    }
  } catch (err) {
    violations.push({
      kind: 'manifest_identity_mismatch',
      expected: release.manifestChecksum,
      actual: `MANIFEST.json unreadable/invalid in candidate: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  for (const f of release.manifest.files) {
    if (f.action === 'delete') continue;
    if (!f.checksum) continue; // manifest shape allows an absent checksum only for 'delete'; nothing to compare otherwise
    const filePath = join(candidatePath, f.path);
    try {
      const actual = await computeFileChecksum(filePath);
      if (actual !== f.checksum) {
        violations.push({ kind: 'file_checksum_mismatch', path: f.path, expected: f.checksum, actual });
      }
    } catch (err) {
      violations.push({
        kind: 'file_unreadable',
        path: f.path,
        expected: f.checksum,
        actual: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { releaseId: release.id, ok: violations.length === 0, violations };
}
