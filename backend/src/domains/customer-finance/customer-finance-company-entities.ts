import { CustomerLedgerEntry } from './infrastructure/customer-ledger-entry.entity';
import { SalesInvoice } from './infrastructure/sales-invoice.entity';
import { SalesInvoiceLine } from './infrastructure/sales-invoice-line.entity';
import { Payment } from './infrastructure/payment.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Customer Finance's own
 * Company-connection-capable entities (`CustomerLedgerService`,
 * `InvoicesService`, `PaymentsService`).
 */
export const CUSTOMER_FINANCE_COMPANY_ENTITIES = [CustomerLedgerEntry, SalesInvoice, SalesInvoiceLine, Payment];
