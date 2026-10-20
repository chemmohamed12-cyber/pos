import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Supplier } from './infrastructure/supplier.entity';
import { SupplierContact } from './infrastructure/supplier-contact.entity';
import { SupplierAddress } from './infrastructure/supplier-address.entity';
import { SupplierBankAccount } from './infrastructure/supplier-bank-account.entity';
import { PurchaseOrder } from './infrastructure/purchase-order.entity';
import { PurchaseOrderLine } from './infrastructure/purchase-order-line.entity';
import { GoodsReceipt } from './infrastructure/goods-receipt.entity';
import { GoodsReceiptLine } from './infrastructure/goods-receipt-line.entity';
import { SupplierInvoice } from './infrastructure/supplier-invoice.entity';
import { SupplierInvoiceLine } from './infrastructure/supplier-invoice-line.entity';
import { SupplierInvoiceLineReceipt } from './infrastructure/supplier-invoice-line-receipt.entity';
import { SupplierPaymentAllocation } from './infrastructure/supplier-payment-allocation.entity';
import { InvoiceAllocationService } from './application/invoice-allocation.service';
import { SupplierLedgerEntry } from './infrastructure/supplier-ledger-entry.entity';
import { SupplierPayment } from './infrastructure/supplier-payment.entity';
import { PurchaseRequest } from './infrastructure/purchase-request.entity';
import { PurchaseRequestLine } from './infrastructure/purchase-request-line.entity';
import { Rfq } from './infrastructure/rfq.entity';
import { RfqSupplierInvite } from './infrastructure/rfq-supplier-invite.entity';
import { SupplierQuotation } from './infrastructure/supplier-quotation.entity';
import { SupplierQuotationLine } from './infrastructure/supplier-quotation-line.entity';
import { SupplierService } from './application/supplier.service';
import { SupplierProfileService } from './application/supplier-profile.service';
import { PurchaseOrderService } from './application/purchase-order.service';
import { GoodsReceiptService } from './application/goods-receipt.service';
import { SupplierLedgerService } from './application/supplier-ledger.service';
import { GrniLedgerService } from './application/grni-ledger.service';
import { SupplierInvoiceService } from './application/supplier-invoice.service';
import { SupplierPaymentService } from './application/supplier-payment.service';
import { PurchaseRequestService } from './application/purchase-request.service';
import { RfqService } from './application/rfq.service';
import { SupplierController } from './interface/supplier.controller';
import { PurchaseOrderController } from './interface/purchase-order.controller';
import { GoodsReceiptController } from './interface/goods-receipt.controller';
import { SupplierInvoiceController } from './interface/supplier-invoice.controller';
import { SupplierPaymentController } from './interface/supplier-payment.controller';
import { PurchaseRequestController } from './interface/purchase-request.controller';
import { RfqController } from './interface/rfq.controller';
import { AuditModule } from '../../foundation/audit/audit.module';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { AuthorizationModule } from '../../foundation/authorization/authorization.module';
import { PermissionModule } from '../../foundation/permission/permission.module';
import { ApprovalEngineModule } from '../../foundation/approval-engine/approval-engine.module';
import { ProcessEngineModule } from '../../foundation/process-engine/process-engine.module';
import { NumberingModule } from '../../foundation/numbering/numbering.module';
import { CommerceModule } from '../commerce/commerce.module';
import { ProductItemRequest } from './infrastructure/product-item-request.entity';
import { ProductLifecycleGate } from './application/product-lifecycle-gate.service';
import { NewItemRequestService } from './application/new-item-request.service';
import { NewItemRequestController } from './interface/new-item-request.controller';
import { EventsModule } from '../../foundation/events/events.module';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { SUPPLIER_LEDGER_CONTRACT } from '../../foundation/module-registry/contracts/ap-events.contract';
import { GRNI_LEDGER_CONTRACT } from '../../foundation/module-registry/contracts/grni-events.contract';
import { CompanyModule } from '../../foundation/company/company.module';
import { DatabaseRegistryModule } from '../../foundation/database-registry/database-registry.module';
import { ScopeModule } from '../../foundation/scope/scope.module';

/**
 * ADR-048 — Procurement domain (promoted from `ReservedModuleCode`).
 * Houses all three bounded contexts under one module tree: `supplier`
 * (Supplier Master), `purchasing` (Path A direct PO + Path B Purchase
 * Request/RFQ/Quotations, both converging on the same Goods Receipt),
 * `supplier-finance` (Supplier Invoice/AP/Supplier Ledger/Supplier
 * Payment) — matching how `accounting` groups several sub-areas under
 * one module.
 *
 * `InventoryWarehouseModule` is imported directly (not via a contract
 * token) — the same one-directional domain-to-domain pattern
 * `InventoryService` already permits (ADR-027 only gates against import
 * CYCLES). `TreasuryModule` is ALSO still imported directly — but only for
 * the `FINANCE_TREASURY_CONTRACT` token it exports; P0 correction
 * (OP-Procurement/AP Blueprint §8, CTO ratification Decision 1: APPROVED
 * — Option A, applied 2026-09-18) moved `SupplierPaymentService` off a
 * raw `TreasuryService` injection onto that contract's `cashOutForSupplier`
 * — this module import is what makes the token available to inject, not
 * a green light to import the concrete class anywhere in this domain.
 * `SupplierLedgerService` is exported under
 * the `SUPPLIER_LEDGER_CONTRACT` token — `AccountingModule` imports THIS
 * module (one new, acyclic edge: Procurement has no reason to ever import
 * Accounting back) so `ApReconciliationService`/`ApAdjustmentService`'s
 * pre-existing `@Optional()` injection finally resolves to a real
 * implementation instead of staying permanently unbound (ADR-037 D2).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Supplier,
      SupplierContact,
      SupplierAddress,
      SupplierBankAccount,
      PurchaseOrder,
      PurchaseOrderLine,
      GoodsReceipt,
      GoodsReceiptLine,
      SupplierInvoice,
      SupplierInvoiceLine,
      SupplierInvoiceLineReceipt,
      SupplierPaymentAllocation,
      SupplierLedgerEntry,
      SupplierPayment,
      PurchaseRequest,
      PurchaseRequestLine,
      Rfq,
      RfqSupplierInvite,
      SupplierQuotation,
      SupplierQuotationLine,
      ProductItemRequest,
    ]),
    AuditModule,
    AuthenticationModule,
    AuthorizationModule,
    PermissionModule,
    ApprovalEngineModule,
    ProcessEngineModule,
    NumberingModule,
    EventsModule,
    InventoryWarehouseModule,
    // D7 — the Sales product contract (SALES_PRODUCTS_CONTRACT) for the lifecycle gate and New Item Requests; acyclic (Commerce never imports Procurement).
    CommerceModule,
    TreasuryModule,
    // Area 21 Operational Company Scoping Retrofit (2026-09-27) — for
    // `CompanyContextGuard` on `SupplierInvoiceController` only (the
    // other 6 controllers in this module are not yet retrofitted).
    // `DatabaseRegistryModule` alongside it, the same required pairing
    // discovered during `products.controller.ts`'s retrofit.
    CompanyModule,
    DatabaseRegistryModule,
    // F6 — AccessScopeService + WarehouseScopeGuard (scope pilot: PR / PO / GR).
    ScopeModule,
  ],
  controllers: [
    SupplierController,
    PurchaseOrderController,
    GoodsReceiptController,
    SupplierInvoiceController,
    SupplierPaymentController,
    PurchaseRequestController,
    RfqController,
    NewItemRequestController,
  ],
  providers: [
    SupplierService,
    SupplierProfileService,
    PurchaseOrderService,
    GoodsReceiptService,
    SupplierLedgerService,
    SupplierInvoiceService,
    InvoiceAllocationService,
    SupplierPaymentService,
    PurchaseRequestService,
    RfqService,
    GrniLedgerService,
    ProductLifecycleGate,
    NewItemRequestService,
    { provide: SUPPLIER_LEDGER_CONTRACT, useExisting: SupplierLedgerService },
    { provide: GRNI_LEDGER_CONTRACT, useExisting: GrniLedgerService },
  ],
  exports: [
    SupplierService,
    PurchaseOrderService,
    GoodsReceiptService,
    SupplierLedgerService,
    SupplierInvoiceService,
    SupplierPaymentService,
    PurchaseRequestService,
    RfqService,
    GrniLedgerService,
    SUPPLIER_LEDGER_CONTRACT,
    GRNI_LEDGER_CONTRACT,
  ],
})
export class ProcurementModule {}
