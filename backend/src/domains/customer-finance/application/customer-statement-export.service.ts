import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { CustomerStatement } from './customer-statement.service';
import { buildStatementPdf } from './statement-pdf';
import { StatementLang } from '../domain/customer-statement-rules';

export type StatementFormat = 'pdf' | 'xlsx' | 'csv';

const HEAD: Record<StatementLang, string[]> = {
  ar: ['التاريخ', 'رقم القيد', 'نوع الحركة', 'البيان', 'رقم المستند', 'تاريخ الاستحقاق', 'مدين', 'دائن', 'الرصيد الجاري', 'الحالة'],
  en: ['Date', 'Entry no.', 'Type', 'Description', 'Document no.', 'Due date', 'Debit', 'Credit', 'Running balance', 'Status'],
};
const STATUS: Record<StatementLang, { posted: string; reversed: string; reversal: string }> = {
  ar: { posted: 'مرحّل', reversed: 'معكوس', reversal: 'قيد عكس' },
  en: { posted: 'Posted', reversed: 'Reversed', reversal: 'Reversal' },
};
const META: Record<StatementLang, Record<string, string>> = {
  ar: { company: 'الشركة', title: 'كشف حساب عميل', customer: 'العميل', tax: 'الرقم الضريبي', address: 'العنوان', ref: 'مرجع الكشف', issued: 'تاريخ الإصدار', period: 'الفترة', currency: 'العملة', filters: 'الفلاتر', opening: 'الرصيد الافتتاحي', debit: 'إجمالي المدين', credit: 'إجمالي الدائن', closing: 'الرصيد الختامي', excl: 'بعد استبعاد المعكوس وقيود العكس', none: 'لا يوجد (الكشف كامل)', from: 'من بداية السجلات', to: 'حتى تاريخه', type: 'نوع الحركة', status: 'الحالة', warn: 'تنبيه' },
  en: { company: 'Company', title: 'Customer Account Statement', customer: 'Customer', tax: 'Tax registration no.', address: 'Address', ref: 'Statement reference', issued: 'Issue date', period: 'Period', currency: 'Currency', filters: 'Filters', opening: 'Opening balance', debit: 'Total debit', credit: 'Total credit', closing: 'Closing balance', excl: 'Excluding reversed rows and reversal entries', none: 'None (complete statement)', from: 'From the first record', to: 'Up to date', type: 'Type', status: 'Status', warn: 'Warning' },
};

const statusOf = (r: CustomerStatement['rows'][number], lang: StatementLang): string => (r.status === 'reversed' ? STATUS[lang].reversed : r.isReversalLeg ? STATUS[lang].reversal : STATUS[lang].posted);

/** A cell that starts with = + - @ would be a formula in a spreadsheet — prefixed with a quote. */
const csvCell = (v: string): string => {
  const s = /^[=+\-@]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function headerBlock(s: CustomerStatement, lang: StatementLang, company: string): Array<[string, string]> {
  const m = META[lang];
  const filterText = s.isComplete ? m.none : [s.filters.entryType ? `${m.type}=${s.filters.entryType}` : null, s.filters.status ? `${m.status}=${s.filters.status}` : null].filter(Boolean).join(' ; ');
  return [
    [m.company, company],
    [m.title, ''],
    [m.ref, s.reference],
    [m.issued, s.generatedAt.slice(0, 10)],
    [m.customer, `${s.customer.name} (${s.customer.code})`],
    [m.tax, s.customer.taxRegistrationNumber ?? ''],
    [m.address, [s.customer.address, s.customer.governorate].filter(Boolean).join(', ')],
    [m.period, `${s.period.from ?? m.from} → ${s.period.to ?? m.to}`],
    [m.currency, s.currency.code],
    [m.filters, filterText],
    [m.opening, s.openingBalance],
    [m.debit, s.totals.debit],
    [m.credit, s.totals.credit],
    [m.closing, s.closingBalance],
    [m.excl, `${s.totalsExcludingReversals.debit} / ${s.totalsExcludingReversals.credit}`],
    ...s.warnings.map((w): [string, string] => [m.warn, `${w[lang]} (${w.entryNumbers.join(', ')})`]),
    ['', s.referenceNote[lang]],
  ];
}

function bodyRows(s: CustomerStatement, lang: StatementLang): string[][] {
  return s.rows.map((r) => [r.date.slice(0, 10), r.entryNumber, r.typeLabel[lang], r.description[lang], r.documentNumber ?? '', r.dueDate ?? '', r.debit, r.credit, r.balance, statusOf(r, lang)]);
}

@Injectable()
export class CustomerStatementExportService {
  async render(s: CustomerStatement, format: StatementFormat, lang: StatementLang, company: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
    const base = `customer-statement-${s.customer.code}-${s.period.from ?? 'start'}_${s.period.to ?? 'today'}-${lang}`;
    if (format === 'csv') {
      const lines = [...headerBlock(s, lang, company).map(([k, v]) => [k, v]), [], HEAD[lang], [META[lang].opening, '', '', '', '', '', '', '', s.openingBalance, ''], ...bodyRows(s, lang)].map((l) => l.map((c) => csvCell(String(c))).join(','));
      lines.push([META[lang].closing, '', '', '', '', '', s.totals.debit, s.totals.credit, s.closingBalance, ''].map((c) => csvCell(String(c))).join(','));
      return { buffer: Buffer.from('﻿' + lines.join('\r\n'), 'utf8'), contentType: 'text/csv; charset=utf-8', filename: `${base}.csv` };
    }
    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      wb.created = new Date(s.generatedAt);
      const ws = wb.addWorksheet(lang === 'ar' ? 'كشف الحساب' : 'Statement', { views: [{ rightToLeft: lang === 'ar' }] });
      headerBlock(s, lang, company).forEach(([k, v]) => {
        const row = ws.addRow([k, v]);
        row.getCell(1).font = { bold: true };
      });
      ws.addRow([]);
      const headRow = ws.addRow(HEAD[lang]);
      headRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headRow.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }));
      const headRowNumber = headRow.number;
      const open = ws.addRow([META[lang].opening, '', '', '', '', '', '', '', Number(s.openingBalance), '']);
      open.font = { bold: true };
      for (const r of bodyRows(s, lang)) {
        const row = ws.addRow(r);
        for (const col of [7, 8, 9]) {
          row.getCell(col).value = Number(r[col - 1]);
          row.getCell(col).numFmt = '#,##0.00';
        }
      }
      const close = ws.addRow([META[lang].closing, '', '', '', '', '', Number(s.totals.debit), Number(s.totals.credit), Number(s.closingBalance), '']);
      close.font = { bold: true };
      for (const col of [7, 8, 9]) {
        close.getCell(col).numFmt = '#,##0.00';
        open.getCell(col).numFmt = '#,##0.00';
      }
      ws.columns = [14, 18, 22, 60, 20, 16, 14, 14, 16, 12].map((width) => ({ width }));
      ws.views = [{ rightToLeft: lang === 'ar', state: 'frozen', ySplit: headRowNumber }];
      ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headRowNumber}:${headRowNumber}` };
      return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${base}.xlsx` };
    }
    return { buffer: await buildStatementPdf(s, lang, company), contentType: 'application/pdf', filename: `${base}.pdf` };
  }
}
