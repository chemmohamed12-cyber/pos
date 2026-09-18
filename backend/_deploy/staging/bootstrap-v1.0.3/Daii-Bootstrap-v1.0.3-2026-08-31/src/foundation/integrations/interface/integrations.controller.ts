import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { IntegrationsService } from '../application/integrations.service';
import { CONNECTOR_TYPES } from '../domain/connector-types';
import { JwtAuthGuard, AuthenticatedRequest } from '../../authentication/jwt-auth.guard';
import { RolesGuard } from '../../authorization/roles.guard';
import { RequireRole } from '../../authorization/require-role.decorator';

class CreateConnectorDto {
  @IsIn(CONNECTOR_TYPES)
  connectorType!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsObject()
  config!: Record<string, unknown>;
}

class PairDto {
  @IsString()
  @MinLength(8)
  pairingToken!: string;
}

class CreateMappingDto {
  @IsUUID()
  daiiProductId!: string;

  @IsString()
  externalProductId!: string;
}

class ReconciliationEntryDto {
  @IsString()
  externalProductId!: string;

  @IsString()
  sku!: string;

  @IsString()
  name!: string;
}

class ProposeReconciliationDto {
  @IsObject({ each: true })
  externalProducts!: Array<{ externalProductId: string; sku: string; name: string }>;
}

class ConfirmReconciliationDto {
  @IsObject({ each: true })
  confirmed!: Array<{ daiiProductId: string; externalProductId: string }>;
}

class PublishOrderStatusDto {
  @IsUUID()
  salesOrderId!: string;

  @IsString()
  externalOrderId!: string;

  @IsOptional()
  @IsIn(['received', 'accepted', 'rejected', 'processing', 'preparing', 'ready', 'shipped', 'delivered', 'cancelled', 'returned'])
  status?: string;
}

/**
 * External Integrations Control Center — CTO handover directive §9:
 * "Add a reusable Control Center -> Settings -> External Integrations...
 * do NOT create a QR-specific hardcoded configuration inside business
 * modules." Every write route is admin-only — pairing credentials and
 * product mappings are a platform-configuration concern, not a
 * day-to-day operational action.
 */
@Controller('integrations/connectors')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @RequireRole('admin')
  @Get()
  async list() {
    return this.integrations.listConnectors();
  }

  @RequireRole('admin')
  @Get(':id')
  async get(@Param('id') id: string) {
    return this.integrations.getConnector(id);
  }

  @RequireRole('admin')
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateConnectorDto) {
    return this.integrations.createConnector(dto.connectorType, dto.name, dto.config, req.user.id);
  }

  @RequireRole('admin')
  @Post(':id/pair')
  async pair(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: PairDto) {
    return this.integrations.pairConnector(id, dto.pairingToken, req.user.id);
  }

  @RequireRole('admin')
  @Post(':id/rotate-credential')
  async rotate(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: PairDto) {
    await this.integrations.rotateCredential(id, dto.pairingToken, req.user.id);
    return { rotated: true };
  }

  @RequireRole('admin')
  @Post(':id/test')
  async test(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.integrations.testConnection(id, req.user.id);
  }

  @RequireRole('admin')
  @Post(':id/disconnect')
  async disconnect(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.integrations.disconnectConnector(id, req.user.id);
  }

  @RequireRole('admin')
  @Get(':id/mappings')
  async listMappings(@Param('id') id: string) {
    return this.integrations.listMappings(id);
  }

  @RequireRole('admin')
  @Post(':id/mappings')
  async createMapping(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: CreateMappingDto) {
    return this.integrations.createMapping(id, dto.daiiProductId, dto.externalProductId, req.user.id);
  }

  @RequireRole('admin')
  @Post(':id/reconcile/propose')
  async proposeReconciliation(@Param('id') id: string, @Body() dto: ProposeReconciliationDto) {
    return this.integrations.proposeReconciliation(id, dto.externalProducts);
  }

  @RequireRole('admin')
  @Post(':id/reconcile/confirm')
  async confirmReconciliation(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: ConfirmReconciliationDto) {
    return this.integrations.confirmReconciliation(id, dto.confirmed, req.user.id);
  }

  @RequireRole('admin')
  @Post(':id/publish/products')
  async publishAllProducts(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.integrations.publishAllProducts(id, req.user.id);
  }

  @RequireRole('admin')
  @Post(':id/publish/availability')
  async publishAllAvailability(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.integrations.publishAllAvailability(id, req.user.id);
  }

  @RequireRole('admin')
  @Post(':id/publish/order-status')
  async publishOrderStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: PublishOrderStatusDto) {
    await this.integrations.publishOrderStatus(id, dto.salesOrderId, dto.externalOrderId, req.user.id, dto.status as never);
    return { published: true };
  }

  @RequireRole('admin')
  @Get(':id/logs')
  async logs(@Param('id') id: string) {
    return this.integrations.listSyncLogs(id);
  }
}
