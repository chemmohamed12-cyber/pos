import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './infrastructure/product.entity';
import { PriceList } from './infrastructure/price-list.entity';
import { PriceListItem } from './infrastructure/price-list-item.entity';
import { BillOfMaterial } from './infrastructure/bill-of-materials.entity';
import { BomComponent } from './infrastructure/bom-component.entity';
import { ProductCategory } from './infrastructure/product-category.entity';
import { ProductBarcode } from './infrastructure/product-barcode.entity';
import { ProductMasterDataService } from './application/product-master-data.service';
import { ProductImageService } from './application/product-image.service';
import { MediaModule } from '../../foundation/media/media.module';
import { ProductCategoriesController } from './interface/product-categories.controller';
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
import { SALES_PRODUCTS_CONTRACT, SALES_BOM_CONTRACT } from '../../foundation/module-registry/contracts/sales.contract';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product, PriceList, PriceListItem, BillOfMaterial, BomComponent, ProductCategory, ProductBarcode]),
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
    ExcelModule,
    MediaModule,
    NumberingModule,
    EventsModule,
    PermissionModule,
    // Area 21 Operational Company Scoping Retrofit (2026-09-27) — for `CompanyContextGuard`.
    // `DatabaseRegistryModule` alongside it — `CompanyContextGuard` needs
    // `CompanyConnectionManagerService` resolvable in THIS module's own
    // scope too (same shape `SalesOrdersModule`'s own retrofit already
    // required and confirmed works).
    CompanyModule,
    DatabaseRegistryModule,
  ],
  controllers: [ProductsController, PriceListsController, BomController, ProductCategoriesController],
  providers: [
    ProductsService,
    PriceListsService,
    BomService,
    ProductMasterDataService,
    ProductImageService,
    // P4 Tranche-2 (ADR-027) — the `sales` module's public contract for other
    // modules (today: `inventory`). Same concrete service, resolved via a
    // stable token instead of a direct cross-domain class import.
    { provide: SALES_PRODUCTS_CONTRACT, useExisting: ProductsService },
    { provide: SALES_BOM_CONTRACT, useExisting: BomService },
  ],
  exports: [ProductsService, PriceListsService, BomService, SALES_PRODUCTS_CONTRACT, SALES_BOM_CONTRACT],
})
export class CommerceModule {}
