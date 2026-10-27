import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import ExcelJS from 'exceljs';
import { ScopeResolver } from '../../../foundation/scope/scope-resolver.service';
import { TreasuryAccount } from '../infrastructure/treasury-account.entity';
import { LEDGER_KIND_LABELS, LedgerKind, LedgerSummary, NOT_SPECIFIED, directionOf, summarize } from './treasury-ledger-labels';

export interface LedgerReportFilters {
  from?: string;
  to?: string;
  accountId?: string;
  /** receipt | payment | transfer — the direction family. */
  family?: string;
  kind?: string;
  status?: string;
  search?: string;
}

export interface LedgerReportRow {
  id: string;
  transactionNumber: string;
  movementDate: string;
  kind: LedgerKind;
  kindLabelAr: string;
  kindLabelEn: string;
  type: string;
  direction: 1 | -1;
  amount: string;
  status: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  partyType: 'customer' | 'supplier' | 'employee' | null;
  partyId: string | null;
  partyCode: string | null;
  partyName: string | null;
  description: string;
  reason: string | null;
  documentType: string | null;
  documentNumber: string | null;
  documentLink: string | null;
}

/** Mirrors `classifyLedgerRow` in treasury-ledger-labels.ts (the unit spec asserts both agree on every origin). */
export const KIND_SQL = `CASE
  WHEN t."reversalOfTransactionId" IS NOT NULL THEN 'reversal'
  WHEN t."type" IN ('transfer_in','transfer_out') THEN 'transfer'
  WHEN t."type" = 'cash_in' THEN CASE
    WHEN t."depositId" IS NOT NULL OR t."reason" = 'Customer deposit' THEN 'customer_deposit'
    WHEN t."reason" = 'customer_payment' THEN CASE WHEN t."reference" IS NOT NULL THEN 'customer_payment_invoice' ELSE 'customer_payment_on_account' END
    WHEN t."reason" = 'cod_collection_custody' THEN 'cod_collection'
    WHEN t."reason" = 'shipping_collection_remittance' THEN 'cod_remittance'
    ELSE 'cash_receipt' END
  ELSE CASE
    WHEN t."reason" = 'supplier_payment' OR (t."supplierId" IS NOT NULL AND t."reason" IS DISTINCT FROM 'payroll_disbursement') THEN 'supplier_payment'
    WHEN t."reason" = 'payroll_disbursement' THEN 'payroll_disbursement'
    ELSE 'cash_disbursement' END
END`;

const FROM_SQL = `FROM "treasury_transactions" t
  JOIN "treasury_accounts" a ON a."id" = t."treasuryAccountId"
  LEFT JOIN "customers" c ON c."id" = t."customerId"
  LEFT JOIN "suppliers" s ON s."id" = t."supplierId"
  LEFT JOIN "hr_employees" e ON e."id" = t."employeeId"
  LEFT JOIN "sales_orders" so ON so."id" = t."salesOrderId"
  LEFT JOIN "supplier_invoices" si ON si."id" = t."supplierInvoiceId"
  LEFT JOIN "payroll_runs" pr ON pr."id" = t."payrollRunId"
  LEFT JOIN "sales_invoices" inv ON inv."id"::text = t."reference" AND t."reason" = 'customer_payment'
  LEFT JOIN "collections" col ON col."id"::text = t."reference" AND t."reason" IN ('shipping_collection_remittance','shipping_collection_settlement')
  LEFT JOIN "shipments" sh ON sh."id"::text = CASE WHEN t."reason" = 'cod_collection_custody' THEN t."reference" ELSE col."shipmentId" END`;

const SELECT_SQL = `t."id", t."transactionNumber", t."movementDate", t."type", t."amount", t."status", t."reason", t."reference",
  t."customerId", t."supplierId", t."employeeId", t."salesOrderId", t."supplierInvoiceId", t."payrollRunId", t."depositId",
  t."transferGroupId", t."reversalOfTransactionId", t."createdByUserId", t."createdAt",
  a."id" AS "accountId", a."code" AS "accountCode", a."name" AS "accountName",
  c."code" AS "customerCode", c."name" AS "customerName", s."code" AS "supplierCode", s."legalName" AS "supplierName",
  e."code" AS "employeeCode", e."fullName" AS "employeeName",
  so."orderNumber" AS "orderNumber", si."invoiceNumber" AS "supplierInvoiceNumber", pr."code" AS "payrollRunCode",
  inv."id" AS "invoiceId", inv."invoiceNumber" AS "invoiceNumber", sh."id" AS "shipmentId", sh."waybillNumber" AS "waybillNumber",
  ${KIND_SQL} AS "kind"`;

type Raw = Record<string, string | null>;

/**
 * Treasury Hotfix — read-only reporting over `treasury_transactions`. No new table, no schema change and no
 * posting behaviour: movement rows are only joined to the party/document records they already point at.
 * A party/reason/document the source rows do not carry is reported as «غير محدد», never guessed.
 */
@Injectable()
export class TreasuryLedgerReportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly scope: ScopeResolver,
  ) {}

  /** Accounts the caller may see (same org-unit scope the Accounts list applies). */
  private async allowedAccountIds(userId: string, manager: EntityManager): Promise<string[]> {
    const accounts = await manager.getRepository(TreasuryAccount).find();
    return (await this.scope.filterAllowedByOrgUnit(userId, accounts, manager)).map((a) => a.id);
  }

  buildWhere(filters: LedgerReportFilters, allowedIds: string[]): { where: string; params: unknown[] } {
    const params: unknown[] = [allowedIds];
    const cond: string[] = [`t."treasuryAccountId" = ANY($1::uuid[])`];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      cond.push(sql.replace('?', `$${params.length}`));
    };
    // UTC-day bounds — the same convention as the GL business date (foundation/localization/business-date.ts).
    if (filters.from) add(`t."movementDate" >= (?::date)::timestamp AT TIME ZONE 'UTC'`, filters.from);
    if (filters.to) add(`t."movementDate" < ((?::date) + 1)::timestamp AT TIME ZONE 'UTC'`, filters.to);
    if (filters.accountId) add(`t."treasuryAccountId" = ?::uuid`, filters.accountId);
    if (filters.status) add(`t."status" = ?`, filters.status);
    if (filters.family === 'receipt') cond.push(`t."type" = 'cash_in'`);
    else if (filters.family === 'payment') cond.push(`t."type" = 'cash_out'`);
    else if (filters.family === 'transfer') cond.push(`t."type" IN ('transfer_in','transfer_out')`);
    if (filters.kind) add(`(${KIND_SQL}) = ?`, filters.kind);
    const q = filters.search?.trim();
    if (q) {
      params.push(`%${q}%`);
      const p = `$${params.length}`;
      cond.push(
        `(t."transactionNumber" ILIKE ${p} OR t."reference" ILIKE ${p} OR t."reason" ILIKE ${p} OR c."name" ILIKE ${p} OR c."code" ILIKE ${p} OR s."legalName" ILIKE ${p} OR s."code" ILIKE ${p}
          OR e."fullName" ILIKE ${p} OR so."orderNumber" ILIKE ${p} OR si."invoiceNumber" ILIKE ${p} OR inv."invoiceNumber" ILIKE ${p} OR sh."waybillNumber" ILIKE ${p} OR pr."code" ILIKE ${p})`,
      );
    }
    return { where: `WHERE ${cond.join(' AND ')}`, params };
  }

  shape(r: Raw): LedgerReportRow {
    const kind = r.kind as LedgerKind;
    const labels = LEDGER_KIND_LABELS[kind];
    let partyType: LedgerReportRow['partyType'] = null;
    let partyId: string | null = null;
    let partyCode: string | null = null;
    let partyName: string | null = null;
    if (r.customerId) [partyType, partyId, partyCode, partyName] = ['customer', r.customerId, r.customerCode, r.customerName];
    else if (r.supplierId) [partyType, partyId, partyCode, partyName] = ['supplier', r.supplierId, r.supplierCode, r.supplierName];
    else if (r.employeeId) [partyType, partyId, partyCode, partyName] = ['employee', r.employeeId, r.employeeCode, r.employeeName];

    let documentType: string | null = null;
    let documentNumber: string | null = null;
    let documentLink: string | null = null;
    if (r.invoiceNumber) [documentType, documentNumber, documentLink] = ['sales_invoice', r.invoiceNumber, `/invoices/${r.invoiceId}`];
    else if (r.supplierInvoiceNumber) [documentType, documentNumber, documentLink] = ['supplier_invoice', r.supplierInvoiceNumber, '/supplier-invoices'];
    else if (r.payrollRunCode) [documentType, documentNumber, documentLink] = ['payroll_run', r.payrollRunCode, `/payroll/runs/${r.payrollRunId}`];
    else if (r.waybillNumber) [documentType, documentNumber, documentLink] = ['shipment', r.waybillNumber, '/shipments'];
    else if (r.orderNumber) [documentType, documentNumber, documentLink] = ['sales_order', r.orderNumber, `/sales-orders/${r.salesOrderId}`];

    // Description = label — party — document; only parts present in the source rows are included.
    const parts = [labels.ar];
    if (partyName) parts.push(`${partyType === 'customer' ? 'العميل' : partyType === 'supplier' ? 'المورد' : 'الموظف'}: ${partyName}`);
    if (documentNumber) parts.push(`المستند: ${documentNumber}`);
    return {
      id: r.id as string,
      transactionNumber: r.transactionNumber as string,
      movementDate: new Date(r.movementDate as string).toISOString(),
      kind,
      kindLabelAr: labels.ar,
      kindLabelEn: labels.en,
      type: r.type as string,
      direction: directionOf(r.type as 'cash_in'),
      amount: r.amount as string,
      status: r.status as string,
      accountId: r.accountId as string,
      accountCode: r.accountCode as string,
      accountName: r.accountName as string,
      partyType,
      partyId,
      partyCode,
      partyName,
      description: parts.join(' — '),
      reason: r.reason,
      documentType,
      documentNumber,
      documentLink,
    };
  }

  async report(
    userId: string,
    filters: LedgerReportFilters,
    page: { page: number; pageSize: number } | null,
    manager?: EntityManager,
  ): Promise<{ rows: LedgerReportRow[]; total: number; summary: LedgerSummary; scope: 'page' | 'all' }> {
    const m = manager ?? this.dataSource.manager;
    const allowed = await this.allowedAccountIds(userId, m);
    const { where, params } = this.buildWhere(filters, allowed);
    // The summary always covers ALL matching rows, never just the visible page.
    const summaryRows = (await m.query(`SELECT t."type", t."amount", t."status", ${KIND_SQL} AS "kind" ${FROM_SQL} ${where}`, params)) as Array<{
      type: 'cash_in' | 'cash_out' | 'transfer_in' | 'transfer_out';
      amount: string;
      status: string;
      kind: LedgerKind;
    }>;
    const summary = summarize(summaryRows.map((r) => ({ kind: r.kind, status: r.status, direction: directionOf(r.type), amount: r.amount })));
    const order = `ORDER BY t."movementDate" DESC, t."createdAt" DESC, t."id" DESC`;
    const limit = page ? `LIMIT ${page.pageSize} OFFSET ${(page.page - 1) * page.pageSize}` : '';
    const raw = (await m.query(`SELECT ${SELECT_SQL} ${FROM_SQL} ${where} ${order} ${limit}`, params)) as Raw[];
    return { rows: raw.map((r) => this.shape(r)), total: summaryRows.length, summary, scope: page ? 'page' : 'all' };
  }

  async details(userId: string, id: string, manager?: EntityManager) {
    const m = manager ?? this.dataSource.manager;
    const allowed = await this.allowedAccountIds(userId, m);
    const raw = (await m.query(
      `SELECT ${SELECT_SQL}, u."fullName" AS "createdByName" ${FROM_SQL} LEFT JOIN "users" u ON u."id" = t."createdByUserId"
        WHERE t."id" = $1::uuid AND t."treasuryAccountId" = ANY($2::uuid[])`,
      [id, allowed],
    )) as Raw[];
    if (raw.length === 0) throw new NotFoundException(`Treasury transaction "${id}" not found.`);
    const r = raw[0];
    const related = (await m.query(
      `SELECT t."id", t."transactionNumber", t."type", t."amount", t."status", t."movementDate", t."reason"
         FROM "treasury_transactions" t
        WHERE t."reversalOfTransactionId" = $1::uuid OR t."id" = $2::uuid
           OR ($3::uuid IS NOT NULL AND t."transferGroupId" = $3::uuid AND t."id" <> $1::uuid)
        ORDER BY t."movementDate"`,
      [id, r.reversalOfTransactionId, r.transferGroupId],
    )) as Array<Record<string, string>>;
    return {
      ...this.shape(r),
      technicalId: r.id,
      reference: r.reference,
      createdByUserId: r.createdByUserId,
      createdByName: r.createdByName ?? null,
      createdAt: r.createdAt,
      reversalOfTransactionId: r.reversalOfTransactionId,
      transferGroupId: r.transferGroupId,
      related,
    };
  }

  /** Full-result export — every row matching the filters (never just a page) with a header block stating company, period, scope and totals. */
  async export(
    userId: string,
    filters: LedgerReportFilters,
    format: 'csv' | 'xlsx',
    companyName: string,
    manager?: EntityManager,
  ): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
    const { rows, total, summary } = await this.report(userId, filters, null, manager);
    const generatedAt = new Date().toISOString();
    const statusAr: Record<string, string> = { posted: 'مرحّلة', reversed: 'معكوسة' };
    const meta: Array<[string, string]> = [
      ['الشركة', companyName],
      ['التقرير', 'سجل الحركات المالية'],
      ['الفترة', `${filters.from ?? '—'} → ${filters.to ?? '—'}`],
      ['نطاق التصدير', `كل النتائج المطابقة للفلاتر (${total} حركة)`],
      ['تاريخ الإنتاج', generatedAt],
      ['إجمالي المقبوضات', summary.receipts],
      ['إجمالي المدفوعات', summary.payments],
      ['صافي الحركة', summary.net],
      ['ملاحظة', 'الإجماليات تستثني التحويلات بين الحسابات والحركات المعكوسة وقيود العكس؛ كل المبالغ بعملة الشركة الأساسية.'],
    ];
    const head = ['رقم الحركة', 'التاريخ والوقت', 'نوع الحركة', 'الطرف', 'كود الطرف', 'البيان', 'السبب', 'الحساب', 'الاتجاه', 'المبلغ', 'الحالة', 'المستند'];
    const body = rows.map((r) => [
      r.transactionNumber,
      r.movementDate,
      r.kindLabelAr,
      r.partyName ?? NOT_SPECIFIED.ar,
      r.partyCode ?? '',
      r.description,
      r.reason ?? NOT_SPECIFIED.ar,
      `${r.accountCode} — ${r.accountName}`,
      r.direction === 1 ? 'قبض' : 'صرف',
      r.amount,
      statusAr[r.status] ?? r.status,
      r.documentNumber ?? NOT_SPECIFIED.ar,
    ]);
    const stamp = generatedAt.slice(0, 10);
    if (format === 'csv') {
      // Formula-injection guard: a cell starting with = + - @ is prefixed with a quote.
      const cell = (v: string) => {
        const s = /^[=+\-@]/.test(v) ? `'${v}` : v;
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [...meta, [], head, ...body].map((l) => l.map((c) => cell(String(c))).join(','));
      return { buffer: Buffer.from('﻿' + lines.join('\r\n'), 'utf8'), contentType: 'text/csv; charset=utf-8', filename: `treasury-ledger-${stamp}.csv` };
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('سجل الحركات', { views: [{ rightToLeft: true }] });
    meta.forEach(([k, v]) => ws.addRow([k, v]));
    ws.addRow([]);
    ws.addRow(head).font = { bold: true };
    body.forEach((b) => {
      const row = ws.addRow(b);
      row.getCell(10).value = Number(b[9]);
      row.getCell(10).numFmt = '#,##0.00';
    });
    ws.columns.forEach((c) => (c.width = 22));
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `treasury-ledger-${stamp}.xlsx` };
  }
}
