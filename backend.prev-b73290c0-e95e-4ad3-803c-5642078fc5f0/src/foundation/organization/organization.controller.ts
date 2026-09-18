import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { OrganizationService } from './organization.service';
import { OrgUnitType } from './org-unit.entity';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { RolesGuard } from '../authorization/roles.guard';
import { RequireRole } from '../authorization/require-role.decorator';

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
@UseGuards(JwtAuthGuard)
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Get('units')
  async listUnits() {
    return this.organization.listUnits();
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin')
  @Post('units')
  async createUnit(@Body() dto: CreateUnitDto) {
    return this.organization.createUnit(dto.type, dto.name, dto.parentId ?? null);
  }

  @Get('units/:id/members')
  async listMembers(@Param('id') id: string) {
    return this.organization.getMemberIds(id);
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin')
  @Post('units/:id/members')
  async assignMember(@Param('id') id: string, @Body() dto: AssignMemberDto) {
    await this.organization.assignMember(dto.userId, id);
    return { assigned: true };
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin')
  @Delete('units/:id/members')
  async removeMember(@Param('id') id: string, @Query('userId') userId: string) {
    await this.organization.removeMember(userId, id);
    return { removed: true };
  }
}
