import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { UsersService } from '../identity/users.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { RequireWorkflow } from '../authorization/require-role.decorator';
import { CompanyContextGuard, CompanyScopedRequest } from '../company/company-context.guard';

/**
 * Authorization Foundation F5 — `GET /admin/sales-reps`, converted from a platform-wide listing into a COMPANY surface.
 *
 * Before F5 the route lived on `AdminController` and answered from the AMBIENT (platform) role tables: a Company's sales manager saw the platform's reps
 * (which is not a Company's staff), and `sales_rep` was treated as a platform role. `sales_rep` is a Company-scoped role (CTO decision): the guard chain is now
 * JWT -> `CompanyContextGuard` (membership + Company validated) -> `RolesGuard` with the `sales.rep.list` workflow rule, and the reps are read from THIS Company's own
 * `roles`/`user_roles`. The URL is unchanged (the Sales Order screen keeps working); the platform-level `sales_rep` mechanism stays only as legacy compatibility.
 * Result shape is unchanged: the users that hold `sales_rep` (never the whole user table).
 */
@Controller('admin/sales-reps')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RolesGuard)
export class SalesRepsDirectoryController {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly users: UsersService,
  ) {}

  @RequireWorkflow('sales.rep.list')
  @Get()
  async listSalesReps(@Req() req: CompanyScopedRequest) {
    const manager = req.companyContext?.dataSource.manager;
    const ids = await this.authorization.getUserIdsForRole('sales_rep', manager);
    return this.users.findByIds(ids);
  }
}
