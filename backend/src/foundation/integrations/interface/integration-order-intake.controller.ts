import { Body, Controller, ForbiddenException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsInt, IsNumberString, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { IntegrationsService } from '../application/integrations.service';
import { IntegrationAuthGuard, IntegrationRequest } from './integration-auth.guard';

class OrderCustomerDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(1)
  phone!: string;
}

class OrderLineDto {
  @IsString()
  externalProductId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsNumberString()
  discountAmount?: string;
}

class ReceiveOrderDto {
  @IsString()
  @MinLength(1)
  externalOrderId!: string;

  @ValidateNested()
  @Type(() => OrderCustomerDto)
  customer!: OrderCustomerDto;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];
}

/**
 * QR -> Daii order intake — CTO handover directive §4/§5/§15/§16.
 * Machine-to-machine: authenticated via `IntegrationAuthGuard` (the
 * connector's own pairing credential), never a Daii user JWT. The
 * connector id in the URL is redundant with `req.connector.id` from the
 * guard but kept explicit in the path for a legible, RESTful, per-
 * connector contract (`/integrations/qr/:connectorId/orders`) rather
 * than inferring it purely from a header.
 */
@Controller('integrations/qr/:connectorId')
@UseGuards(IntegrationAuthGuard)
export class IntegrationOrderIntakeController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Post('orders')
  async receiveOrder(@Req() req: IntegrationRequest, @Param('connectorId') connectorId: string, @Body() dto: ReceiveOrderDto) {
    if (req.connector.id !== connectorId) {
      // The guard authenticated the credential FOR req.connector — a
      // caller cannot use one connector's credential to post as another.
      throw new ForbiddenException('Connector id does not match the authenticated credential.');
    }
    return this.integrations.receiveOrder(connectorId, dto.externalOrderId, dto.customer, dto.lines, null);
  }
}
