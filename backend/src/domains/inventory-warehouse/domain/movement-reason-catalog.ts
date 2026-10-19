/**
 * ADR-INV-04 (CTO authorisation 2026-10-19) - the approved catalog of movement reasons and the validation matrix of reason + reference per document type.
 *
 * ACCOUNTING IS NOT CHANGED HERE (decision G-ISS-1): the reasons of an ISSUE (`internal_consumption`, `sample`, `scrap_waste`) are captured and validated, but an issue document still posts
 * `Dr COGS / Cr Inventory` exactly as before; the receipt offset account still comes only from `accounting.inventory_manual_receipt_reason_accounts`; adjustments still use the gain / loss
 * accounts. `financial` below documents that, it never drives a posting.
 */
export type MovementReferenceKind = 'none_with_note' | 'count_document' | 'source_document' | 'opening_batch' | 'transfer_document';

export interface MovementReasonEntry {
  /** lower-case code; matching is case-insensitive (receipt codes are configured upper-case in some installations) */
  code: string;
  movementTypes: string[];
  referenceKind: MovementReferenceKind;
  approval: 'required' | 'system_only';
  /** reserved for a controlled workflow (opening batch, shipment): cannot be chosen on a document */
  reserved?: boolean;
  financial: 'receipt_reason_account' | 'cogs_unchanged' | 'gain_loss_unchanged' | 'none' | 'opening_batch';
}

export const DEFAULT_MOVEMENT_REASON_CATALOG: MovementReasonEntry[] = [
  { code: 'found_stock', movementTypes: ['receipt'], referenceKind: 'none_with_note', approval: 'required', financial: 'receipt_reason_account' },
  { code: 'donation', movementTypes: ['receipt'], referenceKind: 'none_with_note', approval: 'required', financial: 'receipt_reason_account' },
  { code: 'opening_balance', movementTypes: ['receipt'], referenceKind: 'opening_batch', approval: 'system_only', reserved: true, financial: 'opening_batch' },
  { code: 'internal_consumption', movementTypes: ['issue'], referenceKind: 'none_with_note', approval: 'required', financial: 'cogs_unchanged' },
  { code: 'sample', movementTypes: ['issue'], referenceKind: 'none_with_note', approval: 'required', financial: 'cogs_unchanged' },
  { code: 'scrap_waste', movementTypes: ['issue'], referenceKind: 'none_with_note', approval: 'required', financial: 'cogs_unchanged' },
  { code: 'sale', movementTypes: ['issue'], referenceKind: 'source_document', approval: 'system_only', reserved: true, financial: 'cogs_unchanged' },
  { code: 'count_variance', movementTypes: ['adjustment', 'count'], referenceKind: 'count_document', approval: 'required', financial: 'gain_loss_unchanged' },
  { code: 'damage', movementTypes: ['adjustment'], referenceKind: 'none_with_note', approval: 'required', financial: 'gain_loss_unchanged' },
  { code: 'correction', movementTypes: ['adjustment'], referenceKind: 'none_with_note', approval: 'required', financial: 'gain_loss_unchanged' },
  { code: 'opening_correction', movementTypes: ['adjustment'], referenceKind: 'opening_batch', approval: 'system_only', reserved: true, financial: 'opening_batch' },
  { code: 'internal_transfer', movementTypes: ['transfer'], referenceKind: 'transfer_document', approval: 'required', financial: 'none' },
];

/** The record types a document may point at, and the Company table that holds them (a fixed allow-list: nothing user-controlled ever reaches a table name). */
export const REFERENCE_TABLES: Record<string, string> = {
  warehouse_transaction: 'warehouse_transactions',
  opening_batch: 'inventory_opening_batches',
  sales_order: 'sales_orders',
  shipment: 'shipments',
  sales_return: 'sales_returns',
  shipment_return: 'shipment_returns',
  purchase_order: 'purchase_orders',
  goods_receipt: 'goods_receipts',
};

/** What a manual (document) receipt must never cite: a purchase order / goods receipt belongs to the Goods Receipt path with its own rules. */
const GOODS_RECEIPT_ONLY_REFERENCES = new Set(['purchase_order', 'goods_receipt']);
const SOURCE_DOCUMENT_TYPES = new Set(['sales_order', 'shipment', 'sales_return', 'shipment_return']);
const MIN_NOTE_LENGTH = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMovementReasonCatalog(raw: unknown): MovementReasonEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_MOVEMENT_REASON_CATALOG;
  const out: MovementReasonEntry[] = [];
  for (const e of raw as Array<Record<string, unknown>>) {
    if (!e || typeof e.code !== 'string' || !Array.isArray(e.movementTypes) || typeof e.referenceKind !== 'string') return DEFAULT_MOVEMENT_REASON_CATALOG; // a malformed catalog never silently relaxes the rules
    out.push(e as unknown as MovementReasonEntry);
  }
  return out;
}

export interface ReferenceRecord {
  exists: boolean;
  /** the document type of a warehouse transaction / the lifecycle state, when the record has one */
  docType?: string;
  state?: string;
}

export interface ReasonReferenceInput {
  type: string;
  reasonCode: string | null;
  referenceType: string | null;
  referenceId: string | null;
  /** the written note (document notes, else the free-text reason) */
  note: string | null;
}

/**
 * Every reason this document's reason / reference is NOT acceptable (an empty list = acceptable). Pure: the only I/O is the injected `lookup` of a referenced record, which the caller runs
 * on the Company's own connection (so a record of another Company simply does not exist).
 */
export async function validateReasonAndReference(
  input: ReasonReferenceInput,
  catalog: MovementReasonEntry[],
  lookup: (referenceType: string, referenceId: string) => Promise<ReferenceRecord>,
): Promise<string[]> {
  const problems: string[] = [];
  const code = (input.reasonCode ?? '').trim();
  const note = (input.note ?? '').trim();

  if (input.referenceType || input.referenceId) {
    if (!input.referenceType || !input.referenceId) problems.push('a reference needs both its type and its id');
    else if (!(input.referenceType in REFERENCE_TABLES)) problems.push(`the reference type "${input.referenceType}" is not accepted`);
    else if (!UUID.test(input.referenceId)) problems.push('the reference id is not a valid id');
    else if (input.type === 'receipt' && GOODS_RECEIPT_ONLY_REFERENCES.has(input.referenceType)) {
      problems.push(`a ${input.referenceType.replace('_', ' ')} cannot be cited on a manual receipt: stock received against a purchase order comes in through Goods Receipt`);
    }
  }

  if (!code) {
    if (input.type !== 'count') problems.push('a reason code is required');
    return problems;
  }
  const entry = catalog.find((c) => c.code.toLowerCase() === code.toLowerCase());
  if (!entry) return [...problems, `the reason "${code}" is not in the approved catalog`];
  if (entry.reserved || entry.approval === 'system_only') problems.push(`the reason "${code}" is reserved for a controlled workflow and cannot be chosen on a document`);
  if (!entry.movementTypes.includes(input.type)) problems.push(`the reason "${code}" is not valid for a ${input.type} document`);

  const refOk = !!input.referenceType && !!input.referenceId && input.referenceType in REFERENCE_TABLES && UUID.test(input.referenceId);
  const found = refOk ? await lookup(input.referenceType!, input.referenceId!) : { exists: false };
  switch (entry.referenceKind) {
    case 'none_with_note':
      if (note.length < MIN_NOTE_LENGTH) problems.push(`the reason "${code}" needs a written note of at least ${MIN_NOTE_LENGTH} characters`);
      break;
    case 'count_document':
      if (input.type === 'count') break; // the count document IS the reference
      if (!refOk || input.referenceType !== 'warehouse_transaction') problems.push(`the reason "${code}" needs the stock count document as its reference`);
      else if (!found.exists || found.docType !== 'count') problems.push('the referenced stock count document was not found in this Company');
      else if (found.state !== 'posted') problems.push(`the referenced stock count document is "${found.state ?? 'unknown'}", not posted`);
      break;
    case 'opening_batch':
      if (!refOk || input.referenceType !== 'opening_batch') problems.push(`the reason "${code}" needs the opening batch as its reference`);
      else if (!found.exists) problems.push('the referenced opening batch was not found in this Company');
      else if (found.state !== 'posted') problems.push(`the referenced opening batch is "${found.state ?? 'unknown'}", not posted`);
      break;
    case 'source_document':
      if (!refOk || !SOURCE_DOCUMENT_TYPES.has(input.referenceType!)) problems.push(`the reason "${code}" needs its source document (sales order, shipment or return) as its reference`);
      else if (!found.exists) problems.push('the referenced source document was not found in this Company');
      break;
    case 'transfer_document':
      break; // the document itself
  }
  return problems;
}
