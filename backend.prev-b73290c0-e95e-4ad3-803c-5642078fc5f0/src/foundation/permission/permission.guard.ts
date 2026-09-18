import { CanActivate, ExecutionContext, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionService } from './permission.service';
import { PERMISSION_METADATA_KEY, RequiredPermission } from './require-permission.decorator';
import { AuthenticatedRequest } from '../authentication/jwt-auth.guard';

/**
 * Permission Engine — Stage 2 build-order item 8.
 *
 * Deliberately throws 404 (NotFoundException), never 403, on denial —
 * anti-enumeration discipline adopted directly from xnexus-website's
 * consistently-verified pattern (Daii/_source-audits/xnexus-website/,
 * DAII_SECURITY_ARCHITECTURE.md §3): a non-owner never learns the
 * resource exists. This is the one deliberate difference from
 * RolesGuard (item 7), which throws 403 for its coarser admin/staff
 * role gate — Permission Engine guards actual business resources.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permission: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<RequiredPermission>(PERMISSION_METADATA_KEY, context.getHandler());
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthorizedException('Authentication required before permission can be checked.');
    }

    const allowed = await this.permission.hasAtLeast(request.user.id, required.nodeKey, required.access);
    if (!allowed) {
      throw new NotFoundException();
    }
    return true;
  }
}
