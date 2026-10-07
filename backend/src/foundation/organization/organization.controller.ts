import { Body, Controller, Delete, Get, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { OrganizationService } from './organization.service';
import { OrgUnitType } from './org-unit.entity';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { RequireRole } from '../authorization/require-role.decorator';
import { CompanyContextGuard, CompanyScopedRequest } from '../company/company-context.guard';

class CreateUnitDto {
  @IsIn(['company', 'branch', 'department', 'team', 'warehouse'])
  type!: OrgUnitType;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

class AssignMemberDto {
  @IsString()
  userId!: string;
}

/**
 * Organization — Stage 2 build-order item 10. This HTTP interface layer
 * did not exist until the operational UI needed it (Organization had
 * only ever been consumed internally, never over the wire) — no service
 * logic changes, just the standard thin controller wrapper every other
 * domain already has.
 */
@Controller('organization')
/**
 * Authorization Program F1.5 (finding F-1 / AZ-03) — the org tree is COMPANY-owned data. Before this change the controller had `JwtAuthGuard` only and
 * every route read/wrote the AMBIENT (platform) org tables: any authenticated user, whatever Company they had selected, could read the platform tree
 * and its member ids. Now: JWT -> `CompanyContextGuard` (membership + Company status validated) -> the Company's OWN DataSource; the ambient tables are
 * never reached over HTTP. Authorization semantics are otherwise unchanged (reads: any Company member, as before; writes: role `admin` — now resolved
 * from the Company's roles via the guard chain). Redesigning the Organization module is out of scope for F1.
 */
@UseGuards(JwtAuthGuard, CompanyContextGuard)
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  private manager(req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return req.companyContext.dataSource.manager;
  }

  @Get('units')
  async listUnits(@Req() req: CompanyScopedRequest) {
    return this.organization.listUnits(this.manager(req));
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin')
  @Post('units')
  async createUnit(@Req() req: CompanyScopedRequest, @Body() dto: CreateUnitDto) {
    return this.organization.createUnit(dto.type, dto.name, dto.parentId ?? null, null, this.manager(req));
  }

  @Get('units/:id/members')
  async listMembers(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    return this.organization.getMemberIds(id, this.manager(req));
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin')
  @Post('units/:id/members')
  async assignMember(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: AssignMemberDto) {
    await this.organization.assignMember(dto.userId, id, this.manager(req));
    return { assigned: true };
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin')
  @Delete('units/:id/members')
  async removeMember(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Query('userId') userId: string) {
    await this.organization.removeMember(userId, id, this.manager(req));
    return { removed: true };
  }
}
