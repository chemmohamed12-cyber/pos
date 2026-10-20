import { SupplierAddress } from './infrastructure/supplier-address.entity';
import { SupplierBankAccount } from './infrastructure/supplier-bank-account.entity';
import { SupplierContact } from './infrastructure/supplier-contact.entity';
import { SupplierQuotation } from './infrastructure/supplier-quotation.entity';
import { SupplierQuotationLine } from './infrastructure/supplier-quotation-line.entity';
import { PurchaseOrder } from './infrastructure/purchase-order.entity';
import { PurchaseOrderLine } from './infrastructure/purchase-order-line.entity';
import { Supplier } from './infrastructure/supplier.entity';
import { SupplierInvoice } from './infrastructure/supplier-invoice.entity';
import { SupplierInvoiceLine } from './infrastructure/supplier-invoice-line.entity';
import { SupplierLedgerEntry } from './infrastructure/supplier-ledger-entry.entity';
import { GoodsReceipt } from './infrastructure/goods-receipt.entity';
import { GoodsReceiptLine } from './infrastructure/goods-receipt-line.entity';
import { PurchaseRequest } from './infrastructure/purchase-request.entity';
import { PurchaseRequestLine } from './infrastructure/purchase-request-line.entity';
import { Rfq } from './infrastructure/rfq.entity';
import { RfqSupplierInvite } from './infrastructure/rfq-supplier-invite.entity';
import { SupplierPayment } from './infrastructure/supplier-payment.entity';
import { ProductItemRequest } from './infrastructure/product-item-request.entity';
import { SupplierInvoiceLineReceipt } from './infrastructure/supplier-invoice-line-receipt.entity';
import { SupplierPaymentAllocation } from './infrastructure/supplier-payment-allocation.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Procurement's own
 * Company-connection-capable entities (`SupplierInvoiceService`,
 * `SupplierLedgerService`). `GoodsReceipt`/`GoodsReceiptLine` added 2026-09-28
 * (Area 21, `goods-receipt.controller.ts`'s own turn) — found missing
 * entirely by the real-PG isolation spec, same shape as §34/§36/§37.
 * `PurchaseRequest`/`PurchaseRequestLine`/`Rfq`/`RfqSupplierInvite` added
 * 2026-09-28 (`purchase-request.controller.ts`'s turn — `createRfqFromRequest`
 * writes the RFQ + invites itself; `RfqService`/`rfq.controller.ts` remain
 * untouched, Approval-Engine-blocked). `SupplierPayment` added 2026-09-28
 * (`supplier-payment.controller.ts`'s turn). `SupplierAddress`/`SupplierBankAccount`/`SupplierContact`/`SupplierQuotation`/
 * `SupplierQuotationLine` added 2026-10-05 (Area 21, `supplier.controller.ts` + `rfq.controller.ts`'s turn).
 */
export const PROCUREMENT_COMPANY_ENTITIES = [
  PurchaseOrder,
  PurchaseOrderLine,
  Supplier,
  SupplierInvoice,
  SupplierInvoiceLine,
  SupplierLedgerEntry,
  GoodsReceipt,
  GoodsReceiptLine,
  PurchaseRequest,
  PurchaseRequestLine,
  Rfq,
  RfqSupplierInvite,
  SupplierPayment,
  SupplierAddress,
  SupplierBankAccount,
  SupplierContact,
  SupplierQuotation,
  SupplierQuotationLine,
  ProductItemRequest,
  SupplierInvoiceLineReceipt,
  SupplierPaymentAllocation,
];
