import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult } from './handler-registry';

/**
 * Phase D-2 (owner decision D6) - `finance.supplier_credit_note.tax_adjusted`: the Input VAT leg of a posted supplier credit note. Dr Accounts payable / Cr Input VAT (the single `tax_receivable`
 * control account), for exactly the VAT the credit note carries. The cost leg is a separate event (`finance.supplier_credit_note.cost_adjusted`); together they equal the Supplier Ledger debit.
 * Pure; rejects visibly when the AP or the unique Input VAT account is missing.
 */
export async function handleSupplierCreditNoteTax(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const raw = event.payload.taxAmount;
  const tax = Number(typeof raw === 'string' || typeof raw === 'number' ? raw : NaN);
  if (!Number.isFinite(tax) || tax <= 0) return { kind: 'rejected', reason: 'supplier_credit_note.tax_adjusted: missing/invalid taxAmount' };
  const ap = await ctx.resolveControlAccount('ap');
  if (!ap) return { kind: 'rejected', reason: 'supplier_credit_note.tax_adjusted: no AP control account in the chart' };
  const vat = await ctx.resolveUniqueControlAccount('tax_receivable');
  if (!vat.ok) return { kind: 'rejected', reason: `supplier_credit_note.tax_adjusted: Input VAT account (tax_receivable) is ${vat.reason} — exactly one active postable account must carry it` };
  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Supplier credit note ${typeof event.payload.invoiceNumber === 'string' ? event.payload.invoiceNumber : event.sourceEntityId} - Input VAT`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: ap, debit: tax.toFixed(4), description: 'Accounts payable (VAT of the credit note)' },
        { accountId: vat.id, credit: tax.toFixed(4), description: 'Input VAT (credited back)' },
      ],
    },
  };
}
