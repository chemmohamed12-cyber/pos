/**
 * Release Center — Phase C. The machine-readable manifest shape the CTO
 * directive requires ("§9 Delta Manifest" / "§7 Delta Deployment"):
 * version, base version, file list with checksums split by action,
 * migrations, dependency changes, and rollback information. Stored as a
 * single JSONB column on `Release` (not a normalized per-file table) —
 * deliberate Phase C scope cut: this manifest is validated and recorded,
 * but nothing in this phase actually reads a file list to APPLY it (that
 * belongs to the deployment-execution increment, not this one) — a
 * normalized table would be premature structure for data nothing
 * consumes yet.
 */
import { ReleasePackageType } from './release-status';

export interface ReleaseManifestFileEntry {
  path: string;
  action: 'add' | 'modify' | 'delete';
  /** SHA-256, required for 'add'/'modify' (there is nothing to checksum for a 'delete'). */
  checksum?: string;
}

/**
 * ERP Foundation P6 (ADR-023 / ADR-025). A release can carry an Edition
 * entitlement: the deploy applies the signed manifest to the `installation`
 * row and (for an in-place upgrade) runs the "enable Module M" step for each
 * newly-entitled module — all under the EXISTING backup / health / smoke /
 * expand-contract gates. Absent on every release cut before P6, and on any
 * release that only ships code — those deploy exactly as before.
 */
export interface ReleaseManifestEntitlement {
  /** e.g. 'DAII_STANDARD', 'DAII_SALES'. Informational — the signed manifest file is authoritative. */
  editionCode: string;
  editionVersion: string;
  /** authored module_codes the Edition turns ON (before depends_on closure). Cross-checked against the signed manifest. */
  moduleCodes: string[];
  /** path WITHIN the package to the signed `entitlement.manifest.json` (canonical JSON). */
  manifestPath: string;
  /** path WITHIN the package to the detached Ed25519 signature (base64). If omitted, the signature is read from the manifest file's own top-level `signature` field. */
  signaturePath?: string;
}

export interface ReleaseManifest {
  version: string;
  /**
   * Self-description of the package kind. Written by `build-release.sh`
   * (`generate_manifest`) and documented in `RELEASE_MANIFEST_SPEC.md`.
   * Informational on the manifest itself — `validateManifest()` /
   * `PackageValidatorService` are still driven by the `packageType` form
   * field passed at upload time, not by this. Optional so older manifests
   * (and the JSON-only registration path) stay valid. (CF-5, P2 Merge Gate.)
   */
  packageType?: ReleasePackageType;
  /** ISO-8601 UTC build timestamp emitted by `build-release.sh` (reproducible via `SOURCE_DATE_EPOCH`). Informational / provenance only. (CF-5, P2 Merge Gate.) */
  generatedAt?: string;
  /** The `DLT-*` delta id this release came from, when it was cut by the Delta Discovery Engine. Recorded on the LKG entry. Optional. */
  deltaId?: string;
  /** Required and checked against the currently installed version when `packageType === 'delta'` — CTO directive §9: "If the installed version does not match the required base version: REJECT UPDATE." Ignored for `'full'` packages. */
  baseVersion?: string;
  files: ReleaseManifestFileEntry[];
  /** Migration file names this release expects to run, in order — recorded for traceability; this phase does not execute them. */
  migrations: string[];
  dependencyChanges?: Record<string, string>;
  rollbackInstructions?: string;
  /** ERP Foundation P6 — Edition entitlement carried by this release (optional; see `ReleaseManifestEntitlement`). */
  entitlement?: ReleaseManifestEntitlement;
}
