-- READ-ONLY preflight for the procurement allocation migrations (1790020000000 receipt allocations, 1790020100000 payment allocations).
-- Run it on a Company database BEFORE the migrations; every query only SELECTs. A check that returns ROWS is a finding; zero rows = clean.
-- A finding in checks 1-3 means the receipt-allocation backfill would STOP (nothing is written) - decide those documents first.
-- The migrations never change an amount, number, journal, stock movement or status; this report is only meant to avoid a stopped migration.

-- 1. live (not void) invoice lines whose quantity cannot be covered by the receipts of the order line (invoiced > received)
SELECT '1_invoiced_beyond_received' AS "check", pol."id" AS "purchaseOrderLineId", pol."quantityReceived"::text AS received, SUM(sil."quantity")::text AS "liveInvoiced"
  FROM "purchase_order_lines" pol
  JOIN "supplier_invoice_lines" sil ON sil."purchaseOrderLineId" = pol."id"
  JOIN "supplier_invoices" si ON si."id" = sil."supplierInvoiceId"
  LEFT JOIN "process_instances" pi ON pi."definitionKey" = 'supplier_invoice_lifecycle' AND pi."entityId" = si."id"::text
 WHERE COALESCE(pi."currentState", 'draft') <> 'void'
 GROUP BY pol."id", pol."quantityReceived"
HAVING SUM(sil."quantity") > pol."quantityReceived";

-- 2. purchase-order lines whose received quantity is not backed by goods-receipt lines (the backfill allocates against receipt lines)
SELECT '2_received_without_receipt_lines' AS "check", pol."id" AS "purchaseOrderLineId", pol."quantityReceived"::text AS "poLineReceived",
       COALESCE((SELECT SUM(grl."quantityReceived") FROM "goods_receipt_lines" grl WHERE grl."purchaseOrderLineId" = pol."id"), 0)::text AS "receiptLinesTotal"
  FROM "purchase_order_lines" pol
 WHERE pol."quantityReceived" <> COALESCE((SELECT SUM(grl."quantityReceived") FROM "goods_receipt_lines" grl WHERE grl."purchaseOrderLineId" = pol."id"), 0);

-- 3. the maintained invoiced aggregate must equal the live invoice lines
SELECT '3_aggregate_vs_live_lines' AS "check", pol."id" AS "purchaseOrderLineId", pol."quantityInvoiced"::text AS aggregate,
       COALESCE((SELECT SUM(sil."quantity") FROM "supplier_invoice_lines" sil JOIN "supplier_invoices" si ON si."id" = sil."supplierInvoiceId"
                   LEFT JOIN "process_instances" pi ON pi."definitionKey" = 'supplier_invoice_lifecycle' AND pi."entityId" = si."id"::text
                  WHERE sil."purchaseOrderLineId" = pol."id" AND COALESCE(pi."currentState", 'draft') <> 'void'), 0)::text AS "liveLines"
  FROM "purchase_order_lines" pol
 WHERE pol."quantityInvoiced" <> COALESCE((SELECT SUM(sil."quantity") FROM "supplier_invoice_lines" sil JOIN "supplier_invoices" si ON si."id" = sil."supplierInvoiceId"
                   LEFT JOIN "process_instances" pi ON pi."definitionKey" = 'supplier_invoice_lifecycle' AND pi."entityId" = si."id"::text
                  WHERE sil."purchaseOrderLineId" = pol."id" AND COALESCE(pi."currentState", 'draft') <> 'void'), 0);

-- 4. payments recorded against an invoice that is void (informational - the payment allocation backfill copies the link as it is)
SELECT '4_payment_on_void_invoice' AS "check", p."id" AS "supplierPaymentId", p."paymentNumber", p."supplierInvoiceId"
  FROM "supplier_payments" p
  JOIN "process_instances" pi ON pi."definitionKey" = 'supplier_invoice_lifecycle' AND pi."entityId" = p."supplierInvoiceId"::text
 WHERE pi."currentState" = 'void';

-- 5. payments above the invoice's gross (informational)
SELECT '5_payments_above_invoice' AS "check", si."id" AS "supplierInvoiceId", si."invoiceNumber",
       (si."totalAmount" + COALESCE(si."taxAmount", 0))::text AS gross, SUM(p."amount")::text AS paid
  FROM "supplier_invoices" si JOIN "supplier_payments" p ON p."supplierInvoiceId" = si."id"
 GROUP BY si."id", si."invoiceNumber", si."totalAmount", si."taxAmount"
HAVING SUM(p."amount") > si."totalAmount" + COALESCE(si."taxAmount", 0);

-- 6. context counts (informational): invoices per order, orders with more than one live invoice
SELECT '6_orders_with_several_invoices' AS "check", si."purchaseOrderId", COUNT(*)::text AS invoices
  FROM "supplier_invoices" si GROUP BY si."purchaseOrderId" HAVING COUNT(*) > 1;
