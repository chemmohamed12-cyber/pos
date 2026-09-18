import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';

export interface ColumnSpec {
  key: string;
  header: string;
  width?: number;
  example?: string | number;
}

export interface ImportRowResult {
  row: number; // 1-based, matching the row a user sees in Excel (header is row 1)
  errors: string[];
}

export interface ImportSummary<T> {
  totalRows: number;
  succeeded: T[];
  rejected: ImportRowResult[];
  warnings: string[];
}

/**
 * Excel Engine — CTO finalization directive §3/§4/§6. The one shared
 * implementation every domain's import/export goes through (same
 * "build once" discipline as Audit/Terminology/Numbering) — no domain
 * writes its own xlsx parsing/generation.
 *
 * Deliberately thin: reading/writing spreadsheet mechanics only. Every
 * business rule (required fields, data types, duplicate detection,
 * reference validation) lives in the CALLER's per-domain import method,
 * which then calls the SAME domain/application service methods the UI
 * uses (`ProductsService.createProduct`, etc.) — this file never touches
 * a database, per the directive's "Excel must enter through the same
 * domain/application contracts used by normal UI operations" rule.
 */
@Injectable()
export class ExcelService {
  /** A downloadable template — headers only, plus one example row so the expected format is obvious. */
  async buildTemplate(sheetName: string, columns: ColumnSpec[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName, { views: [{ rightToLeft: false }] });
    sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 20 }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14213D' } };
    sheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
    if (columns.some((c) => c.example !== undefined)) {
      sheet.addRow(Object.fromEntries(columns.map((c) => [c.key, c.example ?? ''])));
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  /** A populated export — the caller passes already-authorized, already-scoped rows; this never queries anything itself. */
  async buildExport(sheetName: string, columns: ColumnSpec[], rows: Array<Record<string, unknown>>): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName);
    sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 20 }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14213D' } };
    sheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  /**
   * Reads every data row (row 2 onward) into a plain object keyed by
   * `columns[].key`, matched by HEADER TEXT (not column position) so a
   * user who reorders columns in Excel doesn't silently corrupt data —
   * an unrecognized or missing header is a caller-visible concern, not
   * silently ignored here.
   */
  async parseWorkbook(buffer: Buffer, columns: ColumnSpec[]): Promise<{ rows: Array<Record<string, string>>; headerErrors: string[] }> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.worksheets[0];
    const headerErrors: string[] = [];
    if (!sheet) {
      return { rows: [], headerErrors: ['The uploaded file has no worksheet.'] };
    }

    const headerRow = sheet.getRow(1);
    const headerToColumnIndex = new Map<string, number>();
    headerRow.eachCell((cell, colNumber) => {
      const text = String(cell.value ?? '').trim();
      if (text) headerToColumnIndex.set(text, colNumber);
    });

    for (const col of columns) {
      if (!headerToColumnIndex.has(col.header)) {
        headerErrors.push(`Missing required column "${col.header}".`);
      }
    }
    if (headerErrors.length > 0) return { rows: [], headerErrors };

    const rows: Array<Record<string, string>> = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const isBlank = row.values == null || (Array.isArray(row.values) && row.values.every((v) => v === null || v === undefined || v === ''));
      if (isBlank) return;
      const record: Record<string, string> = {};
      for (const col of columns) {
        const colIndex = headerToColumnIndex.get(col.header)!;
        const cellValue = row.getCell(colIndex).value;
        record[col.key] = cellValue === null || cellValue === undefined ? '' : String(cellValue).trim();
      }
      rows.push(record);
    });

    return { rows, headerErrors: [] };
  }
}
