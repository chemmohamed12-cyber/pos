// The "Document Data Contract" layer (CTO directive §6): every printable
// business document is described by one of these plain interfaces before
// it ever reaches a renderer. A future PDF/thermal renderer consumes the
// exact same contract — nothing here is renderer-specific.

export interface DocumentLine {
  label: string;
  quantity?: number | string;
  unitPrice?: string;
  total?: string;
}

export interface DocumentField {
  label: string;
  value: string;
}

/** The one shape every print page assembles and hands to <PrintDocument>. */
export interface BusinessDocument {
  documentTitleCode: string; // Terminology code, e.g. 'document.sales_order_title'
  documentNumber: string;
  issuedAt: string; // ISO date
  statusLabel?: string;
  fields: DocumentField[]; // key facts (customer, warehouse, driver, ...)
  lines?: DocumentLine[]; // line items, when the document has any
  totals?: DocumentField[]; // grand total / summary rows shown after lines
  footerNote?: string;
  responsibleUser?: string; // "prepared by" / "recorded by"
}
