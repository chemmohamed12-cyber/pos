import { BadRequestException, ConflictException } from '@nestjs/common';
import { QueryFailedError, type EntityManager } from 'typeorm';
import type { NumberingService } from './numbering.service';

/**
 * Default sequential codes for new items, customers and suppliers (owner request 2026-10-20): every kind has its own running serial
 * (`PRD-000001`, `CUST-000001`, `SUP-000001`), shown as the default of the code field and editable to another code. A code can never repeat:
 * a hand-typed code is checked against the existing ones (case-insensitively) before it is used, an issued serial skips any number a hand-typed
 * code already took, and the table's unique index is the final guard.
 */
export interface EntityCodeKind {
  /** numbering_sequences.documentType */
  documentType: string;
  prefix: string;
  /** table and column that hold the code */
  table: 'products' | 'customers' | 'suppliers';
  column: 'sku' | 'code';
  /** how the message names it, English / Arabic */
  labelEn: string;
  labelAr: string;
}

export const PRODUCT_CODE_KIND: EntityCodeKind = { documentType: 'product', prefix: 'PRD', table: 'products', column: 'sku', labelEn: 'Item code', labelAr: 'رمز الصنف' };
export const CUSTOMER_CODE_KIND: EntityCodeKind = { documentType: 'customer', prefix: 'CUST', table: 'customers', column: 'code', labelEn: 'Customer code', labelAr: 'كود العميل' };
export const SUPPLIER_CODE_KIND: EntityCodeKind = { documentType: 'supplier', prefix: 'SUP', table: 'suppliers', column: 'code', labelEn: 'Supplier code', labelAr: 'كود المورد' };

/** Characters allowed in a hand-typed customer / supplier code: letters, digits and - _ . / (no spaces), 1 to 32 characters. */
const NEW_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/;

/** Trims a typed code. Blank → `null` (= "use the next serial"). With `strict`, a code with spaces or odd characters is refused. */
export function normalizeEntityCode(raw: string | null | undefined, kind: EntityCodeKind, strict: boolean): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (strict && !NEW_CODE_PATTERN.test(value)) {
    throw new BadRequestException(
      `${kind.labelEn} "${value}" is not valid: 1 to 32 characters, letters, digits and - _ . / only, no spaces. / ${kind.labelAr} "${value}" غير صالح: من 1 إلى 32 حرفاً، حروف وأرقام و - _ . / فقط، بدون مسافات.`,
    );
  }
  return value;
}

/** Is the code already used (case-insensitively)? Items also share the code namespace with barcodes (master data step 1). */
export async function isEntityCodeTaken(em: EntityManager, kind: EntityCodeKind, code: string): Promise<boolean> {
  const rows = await em.query(`SELECT 1 FROM "${kind.table}" WHERE lower("${kind.column}") = lower($1) LIMIT 1`, [code]);
  if (rows.length > 0) return true;
  if (kind.table === 'products') {
    const barcode = await em.query(`SELECT 1 FROM "product_barcodes" WHERE lower("barcode") = lower($1) LIMIT 1`, [code]);
    return barcode.length > 0;
  }
  return false;
}

export async function assertEntityCodeFree(em: EntityManager, kind: EntityCodeKind, code: string): Promise<void> {
  if (await isEntityCodeTaken(em, kind, code)) {
    throw new ConflictException(`${kind.labelEn} "${code}" is already in use — choose another. / ${kind.labelAr} "${code}" مستخدم من قبل — اختر كوداً آخر.`);
  }
}

const MAX_SKIP = 50;

/** The default shown in the form: the next serial that is not already taken. A preview only — nothing is issued. */
export async function peekEntityCode(numbering: NumberingService, em: EntityManager, kind: EntityCodeKind): Promise<string> {
  await numbering.registerDocumentType(kind.documentType, kind.prefix, false, em);
  for (let ahead = 0; ahead < MAX_SKIP; ahead++) {
    const candidate = await numbering.peekNextNumber(kind.documentType, ahead, em);
    if (candidate && !(await isEntityCodeTaken(em, kind, candidate))) return candidate;
  }
  throw new ConflictException(`Could not find a free ${kind.labelEn.toLowerCase()}; contact an administrator. / تعذّر إيجاد ${kind.labelAr} متاح؛ راجع المسؤول.`);
}

/** Issues the next serial for real (inside the caller's transaction when `em` is one), skipping any number a hand-typed code already took. */
export async function issueEntityCode(numbering: NumberingService, em: EntityManager, kind: EntityCodeKind): Promise<string> {
  await numbering.registerDocumentType(kind.documentType, kind.prefix, false, em);
  for (let i = 0; i < MAX_SKIP; i++) {
    const candidate = await numbering.getNextNumber(kind.documentType, em);
    if (!(await isEntityCodeTaken(em, kind, candidate))) return candidate;
  }
  throw new ConflictException(`Could not issue a unique ${kind.labelEn.toLowerCase()}; contact an administrator. / تعذّر إصدار ${kind.labelAr} فريد؛ راجع المسؤول.`);
}

/** Two people saving the same hand-typed code at the same instant: the unique index refuses the second; turn that into the same clear message. */
export function rethrowDuplicateCode(err: unknown, kind: EntityCodeKind, code: string): never {
  if (err instanceof QueryFailedError && (err as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === '23505') {
    throw new ConflictException(`${kind.labelEn} "${code}" is already in use — choose another. / ${kind.labelAr} "${code}" مستخدم من قبل — اختر كوداً آخر.`);
  }
  throw err;
}
