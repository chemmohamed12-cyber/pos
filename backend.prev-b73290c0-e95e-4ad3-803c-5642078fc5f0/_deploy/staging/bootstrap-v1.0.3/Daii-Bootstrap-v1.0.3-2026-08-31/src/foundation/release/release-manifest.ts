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
export interface ReleaseManifestFileEntry {
  path: string;
  action: 'add' | 'modify' | 'delete';
  /** SHA-256, required for 'add'/'modify' (there is nothing to checksum for a 'delete'). */
  checksum?: string;
}

export interface ReleaseManifest {
  version: string;
  /** Required and checked against the currently installed version when `packageType === 'delta'` — CTO directive §9: "If the installed version does not match the required base version: REJECT UPDATE." Ignored for `'full'` packages. */
  baseVersion?: string;
  files: ReleaseManifestFileEntry[];
  /** Migration file names this release expects to run, in order — recorded for traceability; this phase does not execute them. */
  migrations: string[];
  dependencyChanges?: Record<string, string>;
  rollbackInstructions?: string;
}
