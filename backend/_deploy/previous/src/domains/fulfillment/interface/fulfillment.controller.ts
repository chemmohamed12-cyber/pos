import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsString, Min } from 'class-validator';
import { FulfillmentService } from '../application/fulfillment.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';

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

@Controller('fulfillment')
@UseGuards(JwtAuthGuard)
export class FulfillmentController {
  constructor(private readonly fulfillment: FulfillmentService) {}

  @Post('orders')
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateFulfillmentOrderDto) {
    return this.fulfillment.createFulfillmentOrder(dto.salesOrderId, req.user.id);
  }

  @Get('orders')
  async listOrders() {
    return this.fulfillment.listFulfillmentOrders();
  }

  @Get('orders/by-sales-order')
  async byOrder(@Query('salesOrderId') salesOrderId: string) {
    return this.fulfillment.getFulfillmentOrderBySalesOrderId(salesOrderId);
  }

  @Get('orders/:id')
  async getOrder(@Param('id') id: string) {
    return this.fulfillment.getFulfillmentOrder(id);
  }

  @Get('pick-tasks/:id')
  async getPick(@Param('id') id: string) {
    return this.fulfillment.getPickTask(id);
  }

  @Get('pack-tasks/:id')
  async getPack(@Param('id') id: string) {
    return this.fulfillment.getPackTask(id);
  }

  @Get('pick-tasks')
  async listPick() {
    return this.fulfillment.listPickTasks();
  }

  @Get('pack-tasks')
  async listPack() {
    return this.fulfillment.listPackTasks();
  }

  @Post('pick-tasks/:id/assign')
  async assignPick(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: AssignTaskDto) {
    return this.fulfillment.assignPickTask(id, dto.userId, req.user.id);
  }

  @Post('pick-tasks/:id/transition')
  async transitionPick(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: TransitionDto) {
    const result = await this.fulfillment.transitionPickTask(id, dto.action, req.user.id);
    return { pickTaskId: id, status: result.state, packTaskId: result.packTaskId };
  }

  /** CTO directive — "استلام وبدء التجهيز" as one action, not two clicks. */
  @Post('pick-tasks/:id/receive-and-start')
  async receiveAndStart(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const result = await this.fulfillment.receiveAndStartPickTask(id, req.user.id);
    return { pickTaskId: id, status: result.state };
  }

  @Post('pack-tasks/:id/transition')
  async transitionPack(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: TransitionDto) {
    const status = await this.fulfillment.transitionPackTask(id, dto.action, req.user.id);
    return { packTaskId: id, status };
  }

  /** CTO directive ("PRIORITY: ITEM PREPARATION") — backs the per-item Preparation screen. */
  @Get('pick-tasks/:id/lines')
  async listPickTaskLines(@Param('id') id: string) {
    return this.fulfillment.listPickTaskLines(id);
  }

  @Post('pick-tasks/:id/lines/:lineId/prepare')
  async prepareLine(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: PrepareLineDto,
  ) {
    return this.fulfillment.markPickTaskLineDone(id, lineId, dto.quantity, req.user.id);
  }

  /** "تم للجميع" — marks every remaining line fully prepared in one call. */
  @Post('pick-tasks/:id/prepare-all')
  async prepareAllLines(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.fulfillment.markAllPickTaskLinesDone(id, req.user.id);
  }

  /** "تم التغليف وجاهز للشحن" — Preparation Review + the whole Pack Task cycle, in one click. */
  @Post('pick-tasks/:id/finish-and-ready-for-shipping')
  async finishAndReadyForShipping(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.fulfillment.finishPreparationAndReadyForShipping(id, req.user.id);
  }
}
