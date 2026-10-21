import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface LineCreditPosition {
  invoiceLineId: string;
  invoiceId: string;
  quantity: number;
  unitCostBase: number;
  lineNet: number;
  creditedByNotes: number;
  creditedByReturns: number;
  /** returned (after invoicing) units still pending or posted on live purchase returns */
  returnedQuantity: number;
  remainingNet: number;
}

/**
 * Phase D-2 - the cumulative cap of what can still be credited against an invoice line. Only CREDIT NOTES consume it (policy 2026-10-21: a physical return of invoiced goods does not credit anything by
 * itself - it is settled by a credit note that may link it). A note counts while it is live (not void): a draft / submitted / approved one RESERVES its value, a posted one consumes it. Read-only; the callers hold the advisory lock and re-check
 * inside their posting transaction.
 */
@Injectable()
export class InvoiceCreditCapService {
  constructor(private readonly dataSource: DataSource) {}

  async linePosition(invoiceLineId: string, manager?: EntityManager): Promise<LineCreditPosition | null> {
    const run = manager ?? this.dataSource;
    const [row]: Array<{ invoiceId: string; quantity: string; unitCostBase: string; lineTotalBase: string; byNotes: string; byReturns: string; returnedQty: string }> = await run.query(
      `SELECT sil."supplierInvoiceId" AS "invoiceId", sil."quantity"::text AS quantity, sil."unitCostBase"::text AS "unitCostBase", sil."lineTotalBase"::text AS "lineTotalBase",
              COALESCE((SELECT SUM(cl."amount") FROM "supplier_credit_note_lines" cl JOIN "supplier_credit_notes" cn ON cn."id" = cl."supplierCreditNoteId"
                          JOIN "process_instances" pi ON pi."definitionKey" = 'supplier_credit_note_lifecycle' AND pi."entityId" = cn."id"::text
                         WHERE cl."supplierInvoiceLineId" = sil."id" AND pi."currentState" <> 'void'), 0)::text AS "byNotes",
              0::text AS "byReturns",
              COALESCE((SELECT SUM(rl."quantity") FROM "purchase_return_lines" rl JOIN "purchase_returns" pr ON pr."id" = rl."purchaseReturnId"
                          JOIN "process_instances" pi ON pi."definitionKey" = 'purchase_return_lifecycle' AND pi."entityId" = pr."id"::text
                         WHERE rl."supplierInvoiceLineId" = sil."id" AND pi."currentState" <> 'void'), 0)::text AS "returnedQty"
         FROM "supplier_invoice_lines" sil WHERE sil."id" = $1`,
      [invoiceLineId],
    );
    if (!row) return null;
    const lineNet = Number(row.lineTotalBase);
    const byNotes = Number(row.byNotes);
    const byReturns = Number(row.byReturns);
    return {
      invoiceLineId,
      invoiceId: row.invoiceId,
      quantity: Number(row.quantity),
      unitCostBase: Number(row.unitCostBase),
      lineNet,
      creditedByNotes: byNotes,
      creditedByReturns: byReturns,
      returnedQuantity: Number(row.returnedQty),
      remainingNet: r2(lineNet - byNotes - byReturns),
    };
  }

  /** Input VAT already credited back against an invoice (live notes + live invoiced returns). */
  async invoiceTaxCredited(invoiceId: string, manager?: EntityManager): Promise<number> {
    const run = manager ?? this.dataSource;
    const [row]: Array<{ byNotes: string; byReturns: string }> = await run.query(
      `SELECT COALESCE((SELECT SUM(cn."taxAmount") FROM "supplier_credit_notes" cn JOIN "process_instances" pi ON pi."definitionKey" = 'supplier_credit_note_lifecycle' AND pi."entityId" = cn."id"::text
                         WHERE cn."supplierInvoiceId" = $1 AND pi."currentState" <> 'void'), 0)::text AS "byNotes",
              0::text AS "byReturns"`,
      [invoiceId],
    );
    return r2(Number(row.byNotes) + Number(row.byReturns));
  }

  /** The VAT that goes with a net credit: proportional to the invoice's VAT, never above the VAT not yet credited. */
  async proportionalTax(invoiceId: string, netCredit: number, manager?: EntityManager): Promise<number> {
    const run = manager ?? this.dataSource;
    const [inv]: Array<{ net: string; tax: string }> = await run.query(`SELECT "totalAmount"::text AS net, COALESCE("taxAmount", 0)::text AS tax FROM "supplier_invoices" WHERE "id" = $1`, [invoiceId]);
    if (!inv || Number(inv.tax) <= 0 || Number(inv.net) <= 0) return 0;
    const wanted = r2((Number(inv.tax) * netCredit) / Number(inv.net));
    const left = r2(Number(inv.tax) - (await this.invoiceTaxCredited(invoiceId, manager)));
    return Math.max(0, Math.min(wanted, left));
  }
}
