import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';
import { DeliveryService } from '../application/delivery.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RequireModuleGuard, RequireModule } from '../../../foundation/module-registry/require-module.decorator';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { RequirePermission } from '../../../foundation/permission/require-permission.decorator';
import { DeliveryOutcomeType } from '../domain/delivery-outcome-type';

class RecordOutcomeDto {
  @IsString()
  shipmentId!: string;

  @IsIn(['delivered', 'failed', 'refused', 'returned'])
  outcome!: DeliveryOutcomeType;

  @IsOptional()
  @IsString()
  failureReason?: string;
}

class RecordCollectionDto {
  @IsString()
  shipmentId!: string;

  @IsNumberString()
  amount!: string;

  @IsString()
  method!: string;
}

class RemitCollectionDto {
  @IsOptional()
  @IsUUID()
  treasuryAccountId?: string;
}

@Controller('delivery')
@UseGuards(JwtAuthGuard, RequireModuleGuard)
@RequireModule('logistics')
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Post('outcomes')
  async recordOutcome(@Req() req: AuthenticatedRequest, @Body() dto: RecordOutcomeDto) {
    return this.delivery.recordOutcome(dto.shipmentId, dto.outcome, dto.failureReason ?? null, req.user.id);
  }

  @Post('collections')
  async recordCollection(@Req() req: AuthenticatedRequest, @Body() dto: RecordCollectionDto) {
    return this.delivery.recordCollection(dto.shipmentId, dto.amount, dto.method, req.user.id);
  }

  @Get('outcomes')
  async getOutcome(@Req() req: AuthenticatedRequest, @Query('shipmentId') shipmentId: string) {
    return this.delivery.getOutcomeForShipment(shipmentId, req.user.id);
  }

  @Get('collections')
  async getCollection(@Req() req: AuthenticatedRequest, @Query('shipmentId') shipmentId: string) {
    return this.delivery.getCollectionForShipment(shipmentId, req.user.id);
  }

  /** CTO directive — "Shipping Company Settlement → Treasury/Financial Posting" queue, finance/admin only (same tier as Treasury's own routes). */
  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.collection.view', 'read-only')
  @Get('collections/pending-remittance')
  async listPendingRemittances() {
    return this.delivery.listPendingRemittances();
  }

  /**
   * Security/gap review — backs the Collection Receipt print page from the
   * Collection Settlements screen (finance/admin), which the existing
   * `GET /collections?shipmentId=` route can't serve: that route is
   * driver-or-admin scoped (`assertDriverOrAdmin`), not finance-visible.
   * Declared before the `:id` wildcard below, same route-ordering
   * discipline as every other `by-x` route in this codebase. Reuses the
   * already-existing unscoped read (`getCollectionForShipmentUnscoped`,
   * already used internally by Returns' own financial guard) — no new
   * query, no new calculation.
   */
  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.collection.view', 'read-only')
  @Get('collections/by-shipment/:shipmentId')
  async getCollectionForShipmentAsFinance(@Param('shipmentId') shipmentId: string) {
    return this.delivery.getCollectionForShipmentUnscoped(shipmentId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('logistics.collection.post', 'editable')
  @Post('collections/:id/remit')
  async remitCollection(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: RemitCollectionDto) {
    return this.delivery.remitCollection(id, req.user.id, dto.treasuryAccountId ?? null);
  }
}
