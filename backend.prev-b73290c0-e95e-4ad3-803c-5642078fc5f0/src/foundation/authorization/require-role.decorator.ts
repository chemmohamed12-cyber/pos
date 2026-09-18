import { SetMetadata } from '@nestjs/common';

export const ROLES_METADATA_KEY = 'daii:required-roles';

/** Marks a route as requiring at least one of the given role keys. Enforced by RolesGuard. */
export const RequireRole = (...roleKeys: string[]) => SetMetadata(ROLES_METADATA_KEY, roleKeys);
