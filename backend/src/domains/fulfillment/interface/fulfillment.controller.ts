import { Body, Controller, Get, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsInt, IsString, Min } from 'class-validator';
import { FulfillmentService } from '../application/fulfillment.service';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard, CompanyScopedRequest } from '../../../foundation/company/company-context.guard';
import { RequireModule, RequireModuleGuard } from '../../../foundation/module-registry/require-module.decorator';

class CreateFulfillmentOrderDto {
  @IsString()
  salesOrderId!: string;
}

class AssignTaskDto {
  @IsString()
  userId!: string;
}

class TransitionDto {
  @IsString()
  action!: string;
}

class PrepareLineDto {
  @IsInt()
  @Min(1)
  quantity!: number;
}

/**
 * Area 21 Operational Company Scoping Retrofit (2026-09-28, CTO-authorized,
 * controller #12). `CompanyContextGuard` added at the class level — every
 * route now threads `req.companyContext.dataSource.manager` into
 * `FulfillmentService`.
 */
@Controller('fulfillment')
@UseGuards(JwtAuthGuard, CompanyContextGuard, RequireModuleGuard)
@RequireModule('inventory')
export class FulfillmentController {
  constructor(private readonly fulfillment: FulfillmentService) {}

  @Post('orders')
  async create(@Req() req: CompanyScopedRequest, @Body() dto: CreateFulfillmentOrderDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.createFulfillmentOrder(dto.salesOrderId, req.user.id, req.companyContext.dataSource.manager);
  }

  @Get('orders')
  async listOrders(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.listFulfillmentOrders(req.companyContext.dataSource.manager);
  }

  @Get('orders/by-sales-order')
  async byOrder(@Req() req: CompanyScopedRequest, @Query('salesOrderId') salesOrderId: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.getFulfillmentOrderBySalesOrderId(salesOrderId, req.companyContext.dataSource.manager);
  }

  @Get('orders/:id')
  async getOrder(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.getFulfillmentOrder(id, req.companyContext.dataSource.manager);
  }

  @Get('pick-tasks/:id')
  async getPick(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.getPickTask(id, req.companyContext.dataSource.manager);
  }

  @Get('pack-tasks/:id')
  async getPack(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.getPackTask(id, req.companyContext.dataSource.manager);
  }

  @Get('pick-tasks')
  async listPick(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.listPickTasks(req.companyContext.dataSource.manager);
  }

  @Get('pack-tasks')
  async listPack(@Req() req: CompanyScopedRequest) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.listPackTasks(req.companyContext.dataSource.manager);
  }

  @Post('pick-tasks/:id/assign')
  async assignPick(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: AssignTaskDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.assignPickTask(id, dto.userId, req.user.id, req.companyContext.dataSource.manager);
  }

  @Post('pick-tasks/:id/transition')
  async transitionPick(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: TransitionDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const result = await this.fulfillment.transitionPickTask(id, dto.action, req.user.id, req.companyContext.dataSource.manager);
    return { pickTaskId: id, status: result.state, packTaskId: result.packTaskId };
  }

  /** CTO directive — "استلام وبدء التجهيز" as one action, not two clicks. */
  @Post('pick-tasks/:id/receive-and-start')
  async receiveAndStart(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const result = await this.fulfillment.receiveAndStartPickTask(id, req.user.id, req.companyContext.dataSource.manager);
    return { pickTaskId: id, status: result.state };
  }

  @Post('pack-tasks/:id/transition')
  async transitionPack(@Req() req: CompanyScopedRequest, @Param('id') id: string, @Body() dto: TransitionDto) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    const status = await this.fulfillment.transitionPackTask(id, dto.action, req.user.id, req.companyContext.dataSource.manager);
    return { packTaskId: id, status };
  }

  /** CTO directive ("PRIORITY: ITEM PREPARATION") — backs the per-item Preparation screen. */
  @Get('pick-tasks/:id/lines')
  async listPickTaskLines(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.listPickTaskLines(id, req.companyContext.dataSource.manager);
  }

  @Post('pick-tasks/:id/lines/:lineId/prepare')
  async prepareLine(
    @Req() req: CompanyScopedRequest,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: PrepareLineDto,
  ) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.markPickTaskLineDone(id, lineId, dto.quantity, req.user.id, req.companyContext.dataSource.manager);
  }

  /** "تم للجميع" — marks every remaining line fully prepared in one call. */
  @Post('pick-tasks/:id/prepare-all')
  async prepareAllLines(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.markAllPickTaskLinesDone(id, req.user.id, req.companyContext.dataSource.manager);
  }

  /** "تم التغليف وجاهز للشحن" — Preparation Review + the whole Pack Task cycle, in one click. */
  @Post('pick-tasks/:id/finish-and-ready-for-shipping')
  async finishAndReadyForShipping(@Req() req: CompanyScopedRequest, @Param('id') id: string) {
    if (!req.user || !req.companyContext) throw new UnauthorizedException();
    return this.fulfillment.finishPreparationAndReadyForShipping(id, req.user.id, req.companyContext.dataSource.manager);
  }
}
