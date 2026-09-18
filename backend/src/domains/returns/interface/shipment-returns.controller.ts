import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsNumberString, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ShipmentReturnsService } from '../application/shipment-returns.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';

class ShipmentReturnLineDto {
  @IsString()
  shipmentLineId!: string;

  @IsInt()
  @Min(1)
  returnQuantity!: number;

  @IsNumberString()
  returnPrice!: string;
}

class CreateShipmentReturnDto {
  @IsString()
  shipmentId!: string;

  @IsIn(['full', 'partial'])
  returnMode!: 'full' | 'partial';

  @ValidateNested({ each: true })
  @Type(() => ShipmentReturnLineDto)
  lines!: ShipmentReturnLineDto[];

  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * Separate namespace from `/returns` (`ReturnsController`) — a Shipment
 * Return is never the same document/workflow as `ReturnRequest`'s
 * custody reversal (CTO ratification: keep both untouched and distinct).
 */
@Controller('shipment-returns')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('logistics')
export class ShipmentReturnsController {
  constructor(private readonly shipmentReturns: ShipmentReturnsService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.shipment_return.create', 'editable')
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateShipmentReturnDto) {
    return this.shipmentReturns.createShipmentReturn(dto.shipmentId, dto.returnMode, dto.lines, dto.reason ?? null, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.shipment_return.post', 'editable')
  @Post(':id/complete')
  async complete(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const state = await this.shipmentReturns.completeShipmentReturn(id, req.user.id);
    return { shipmentReturnId: id, state };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.shipment_return.view')
  @Get()
  async list() {
    return this.shipmentReturns.listShipmentReturns();
  }

  /**
   * Historical Requirements Audit (2026-09-17), A1.7 — pre-submit read for
   * the create form: shipped/previously-returned/remaining per shipment
   * line. MUST be declared before `:id` below (NestJS route-matching
   * order) — same precedent as `FixedAssetController`'s own
   * `reconciliation` static-route-first note.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.shipment_return.view')
  @Get('returnable-lines/:shipmentId')
  async returnableLines(@Param('shipmentId') shipmentId: string) {
    return this.shipmentReturns.getReturnableLines(shipmentId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.shipment_return.view')
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.shipmentReturns.getShipmentReturnDetail(id);
  }
}
