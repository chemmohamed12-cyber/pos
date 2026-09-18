/**
 * Release Center — Phase C (Release tracking, foundation slice). Mirrors
 * the CTO directive's own deployment workflow diagram
 * (§11: Pre-flight -> Backup -> Verify -> Upload -> Validate -> Deploy ->
 * Migrate -> Health -> Success/Rollback), but THIS PHASE only reaches as
 * far as `'backup_verified'` — everything from `'deploying'` onward is
 * the next increment (see `ReleaseManagerService` doc comment for why
 * that boundary was drawn deliberately, not left half-built by accident).
 */
export type ReleaseStatus =
  | 'registered'
  | 'validation_failed'
  | 'validated'
  | 'backup_verified'
  | 'deploying'
  | 'migrating'
  | 'health_checking'
  | 'succeeded'
  | 'failed'
  | 'rolled_back';

export type ReleasePackageType = 'full' | 'delta';
