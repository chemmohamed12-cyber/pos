import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './infrastructure/product.entity';
import { PriceList } from './infrastructure/price-list.entity';
import { PriceListItem } from './infrastructure/price-list-item.entity';
import { BillOfMaterial } from './infrastructure/bill-of-materials.entity';
import { BomComponent } from './infrastructure/bom-component.entity';
import { ProductsService } from './application/products.service';
import { PriceListsService } from './application/price-lists.service';
import { BomService } from './application/bom.service';
import { ProductsController } from './interface/products.controller';
import { PriceListsController } from './interface/price-lists.controller';
import { BomController } from './interface/bom.controller';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { ExcelModule } from '../../foundation/excel/excel.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { EventsModule } from '../../foundation/events/events.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, PriceList, PriceListItem, BillOfMaterial, BomComponent]),
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
    ExcelModule,
    NumberingModule,
    EventsModule,
  ],
  controllers: [ProductsController, PriceListsController, BomController],
  providers: [ProductsService, PriceListsService, BomService],
  exports: [ProductsService, PriceListsService, BomService],
})
export class CommerceModule {}
