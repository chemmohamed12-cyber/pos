import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsInt, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BomService } from '../application/bom.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../../../foundation/authentication/jwt-auth.guard';
import { RolesGuard } from '../../../foundation/authorization/roles.guard';
import { RequireRole } from '../../../foundation/authorization/require-role.decorator';

class BomComponentDto {
  @IsString()
  componentProductId!: string;

  @IsInt()
  @Min(1)
  quantityPerUnit!: number;
}

class DefineBomDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BomComponentDto)
  components!: BomComponentDto[];
}

/**
 * Commerce / Bill of Materials — Gap G-2. Reads broadly available
 * (a warehouse worker needs to see a recipe to run an assembly); writes
 * admin-only — defining what a product is physically built from is an
 * engineering/production fact, not a day-to-day operational action
 * (distinct from Price Lists' admin+sales_manager tier, which is a
 * commercial-policy decision — this is a technical one).
 */
@Controller('bom')
@UseGuards(JwtAuthGuard)
export class BomController {
  constructor(private readonly bom: BomService) {}

  @Get()
  async list() {
    return this.bom.listBoms();
  }

  @Get(':productId')
  async get(@Param('productId') productId: string) {
    const bom = await this.bom.getBom(productId);
    if (!bom) throw new NotFoundException(`No Bill of Materials defined for product "${productId}".`);
    return bom;
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin')
  @Post(':productId')
  async define(@Req() req: AuthenticatedRequest, @Param('productId') productId: string, @Body() dto: DefineBomDto) {
    return this.bom.defineBom(productId, dto.components, req.user.id);
  }

  @UseGuards(RolesGuard)
  @RequireRole('admin')
  @Delete(':productId')
  async remove(@Req() req: AuthenticatedRequest, @Param('productId') productId: string) {
    await this.bom.deleteBom(productId, req.user.id);
    return { removed: true };
  }
}
