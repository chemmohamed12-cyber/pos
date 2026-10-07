import { SetMetadata } from '@nestjs/common';

export const ROLES_METADATA_KEY = 'daii:required-roles';

/** Marks a route as requiring at least one of the given role keys. Enforced by RolesGuard. */
export const RequireRole = (...roleKeys: string[]) => SetMetadata(ROLES_METADATA_KEY, roleKeys);

export const WORKFLOW_RULE_METADATA_KEY = 'daii:required-workflow-rule';

/**
 * F5 — marks a route as requiring a WORKFLOW RULE (a capability, see `workflow-rules.ts`) instead of a hard-coded role list. Enforced by RolesGuard under the
 * active `AUTHZ_WORKFLOW_MODE` (legacy role list / dual / capability). It REPLACES `@RequireRole(...)` on the migrated route (a route carries one of the two).
 */
export const RequireWorkflow = (ruleKey: string) => SetMetadata(WORKFLOW_RULE_METADATA_KEY, ruleKey);
