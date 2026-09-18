import { SetMetadata } from '@nestjs/common';
import { PermissionAccess } from './role-permission.entity';

export const PERMISSION_METADATA_KEY = 'daii:required-permission';

export interface RequiredPermission {
  nodeKey: string;
  access: PermissionAccess;
}

/** Marks a route as requiring at least the given access level on the given permission node. */
export const RequirePermission = (nodeKey: string, access: PermissionAccess = 'read-only') =>
  SetMetadata(PERMISSION_METADATA_KEY, { nodeKey, access } as RequiredPermission);
