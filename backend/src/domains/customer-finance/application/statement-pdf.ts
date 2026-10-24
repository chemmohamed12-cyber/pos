import PDFDocument from 'pdfkit';
import bidiFactory from 'bidi-js';
import { NOTO_NASKH_ARABIC_BOLD, NOTO_NASKH_ARABIC_REGULAR, NOTO_SANS_LATIN_BOLD, NOTO_SANS_LATIN_REGULAR } from './statement-fonts';
import type { CustomerStatement } from './customer-statement.service';
import { StatementLang } from '../domain/customer-statement-rules';

/**
 * Server-side statement PDF (D6). One deterministic renderer for Arabic (RTL) and English (LTR): the text is split into direction runs, each run is shaped by the
 * embedded Noto Naskh font (Arabic joining/ligatures through the font's OpenType tables), runs are placed in visual order, tables repeat their header on every page
 * and every page carries the generated reference and "page x of y". No browser, no system fonts.
 */

const ARABIC_FONT_CHAR = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF\u200C\u200D]/;

export interface Piece {
  text: string;
  /** which embedded face draws it: the Arabic faces only carry Arabic letters; digits, Latin letters, spaces and punctuation come from the Latin faces. */
  face: 'ar' | 'lat';
  /** right-to-left embedding level: Arabic pieces are shaped (joined) with the font's `rtla` features. */
  rtl: boolean;
}

/**
 * Unicode Bidirectional Algorithm (UAX #9, `bidi-js`) → the pieces of one logical line in VISUAL left-to-right order, with mirrored characters (parentheses) already
 * swapped and each piece's text in LOGICAL order (what the shaping engine expects). The paragraph direction is explicit: Arabic statements are RTL, English LTR.
 */
export function visualPieces(text: string, baseRtl: boolean): Piece[] {
  if (!text) return [];
  const emb = bidi.getEmbeddingLevels(text, baseRtl ? 'rtl' : 'ltr');
  const order: number[] = Array.from({ length: text.length }, (_, i) => i);
  for (const [start, end] of bidi.getReorderSegments(text, emb)) {
    for (let i = start, j = end; i < j; i++, j--) [order[i], order[j]] = [order[j], order[i]];
  }
  const out: Array<{ chars: string[]; face: 'ar' | 'lat'; rtl: boolean }> = [];
  for (const logical of order) {
    const rtl = (emb.levels[logical] & 1) === 1;
    const ch = (rtl ? bidi.getMirroredCharacter(text[logical]) : null) ?? text[logical];
    const face: 'ar' | 'lat' = ARABIC_FONT_CHAR.test(ch) ? 'ar' : 'lat';
    const last = out[out.length - 1];
    if (last && last.face === face && last.rtl === rtl) last.chars.push(ch);
    else out.push({ chars: [ch], face, rtl });
  }
  // The pieces were collected in VISUAL order. An Arabic piece goes to the shaping engine (`rtla`), which wants LOGICAL order and reverses it itself; a Latin-face piece
  // inside right-to-left text (spaces, dashes, brackets, digits) is drawn as-is, so it must stay in visual order.
  return out.map((p) => ({ text: (p.rtl && p.face === 'ar' ? [...p.chars].reverse() : p.chars).join(''), face: p.face, rtl: p.rtl }));
}

type Doc = InstanceType<typeof PDFDocument>;

class Pen {
  constructor(private readonly doc: Doc) {
    doc.registerFont('ar', Buffer.from(NOTO_NASKH_ARABIC_REGULAR, 'base64'));
    doc.registerFont('arB', Buffer.from(NOTO_NASKH_ARABIC_BOLD, 'base64'));
    doc.registerFont('lat', Buffer.from(NOTO_SANS_LATIN_REGULAR, 'base64'));
    doc.registerFont('latB', Buffer.from(NOTO_SANS_LATIN_BOLD, 'base64'));
  }

  private use(p: Piece, size: number, bold: boolean): PDFKit.Mixins.TextOptions {
    this.doc.font(p.face === 'ar' ? (bold ? 'arB' : 'ar') : bold ? 'latB' : 'lat').fontSize(size);
    return p.face === 'ar' && p.rtl ? ({ features: ['rtla'] } as PDFKit.Mixins.TextOptions) : {};
  }

  private measure(pieces: Piece[], size: number, bold: boolean): number[] {
    return pieces.map((p) => {
      try {
        return this.doc.widthOfString(p.text, this.use(p, size, bold));
      } catch {
        // The font subset has no mark anchors for a few ligatures (e.g. lam + alef-with-hamza-below) and the shaping engine throws: retry once with the hamza/diacritic
        // forms normalised (legible, never fails) instead of failing the whole statement.
        p.text = p.text.replace(/[أإآٱ]/g, 'ا').replace(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g, '');
        return this.doc.widthOfString(p.text, this.use(p, size, bold));
      }
    });
  }

  width(text: string, size: number, bold: boolean, baseRtl: boolean): number {
    return this.measure(visualPieces(text, baseRtl), size, bold).reduce((a, b) => a + b, 0);
  }

  /** Greedy word wrap in logical order; returns the logical lines. */
  wrap(text: string, maxWidth: number, size: number, bold: boolean, baseRtl: boolean): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const trial = cur ? `${cur} ${w}` : w;
      if (cur && this.width(trial, size, bold, baseRtl) > maxWidth) {
        lines.push(cur);
        cur = w;
      } else cur = trial;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  /** Draws one logical line inside [x, x+width]; `edge` = which side the text hugs. */
  line(text: string, x: number, y: number, width: number, size: number, bold: boolean, baseRtl: boolean, edge: 'left' | 'right' | 'center'): void {
    const pieces = visualPieces(text, baseRtl);
    const widths = this.measure(pieces, size, bold);
    const total = widths.reduce((a, b) => a + b, 0);
    let cx = edge === 'left' ? x : edge === 'right' ? x + width - total : x + (width - total) / 2;
    pieces.forEach((p, i) => {
      const opts = this.use(p, size, bold);
      this.doc.text(p.text, cx, y, { lineBreak: false, ...opts });
      cx += widths[i];
    });
  }
}

const bidi = bidiFactory();

const L = {
  title: { ar: 'كشف حساب عميل', en: 'Customer Account Statement' },
  company: { ar: 'الشركة', en: 'Company' },
  customer: { ar: 'العميل', en: 'Customer' },
  code: { ar: 'الكود', en: 'Code' },
  address: { ar: 'العنوان', en: 'Address' },
  tax: { ar: 'الرقم الضريبي', en: 'Tax registration no.' },
  phone: { ar: 'الهاتف', en: 'Phone' },
  terms: { ar: 'شروط السداد', en: 'Payment terms' },
  days: { ar: 'يوم', en: 'days' },
  limit: { ar: 'حد الائتمان', en: 'Credit limit' },
  ref: { ar: 'مرجع الكشف', en: 'Statement reference' },
  issued: { ar: 'تاريخ الكشف', en: 'Issue date' },
  period: { ar: 'الفترة', en: 'Period' },
  toWord: { ar: 'إلى', en: 'to' },
  currency: { ar: 'العملة', en: 'Currency' },
  opening: { ar: 'الرصيد الافتتاحي', en: 'Opening balance' },
  debit: { ar: 'إجمالي المدين', en: 'Total debit' },
  credit: { ar: 'إجمالي الدائن', en: 'Total credit' },
  closing: { ar: 'الرصيد الختامي', en: 'Closing balance' },
  filters: { ar: 'الفلاتر المطبقة', en: 'Applied filters' },
  none: { ar: 'لا يوجد (الكشف كامل)', en: 'None (complete statement)' },
  startOfRecords: { ar: 'من بداية السجلات', en: 'From the first record' },
  upToNow: { ar: 'حتى تاريخه', en: 'Up to date' },
  notComplete: { ar: 'تنبيه: الكشف مصفّى بحسب النوع/الحالة؛ الأرصدة الجارية تخص الدفتر الكامل، والإجماليات أعلاه للفترة كاملة.', en: 'Note: this view is filtered by type/status; running balances belong to the full ledger and the totals above cover the whole period.' },
  excl: { ar: 'بعد استبعاد المعكوس وقيود العكس', en: 'Excluding reversed rows and reversal entries' },
  page: { ar: 'صفحة', en: 'Page' },
  of: { ar: 'من', en: 'of' },
  empty: { ar: 'لا توجد حركات في هذه الفترة.', en: 'No movements in this period.' },
  generatedBy: { ar: 'تم إنشاؤه آليًا من منظومة DAII', en: 'Generated automatically by DAII' },
};
const COLS = [
  { key: 'date', w: 62, ar: 'التاريخ', en: 'Date' },
  { key: 'type', w: 80, ar: 'نوع الحركة', en: 'Type' },
  { key: 'description', w: 268, ar: 'البيان', en: 'Description' },
  { key: 'document', w: 82, ar: 'رقم المستند', en: 'Document no.' },
  { key: 'due', w: 58, ar: 'الاستحقاق', en: 'Due date' },
  { key: 'debit', w: 66, ar: 'مدين', en: 'Debit' },
  { key: 'credit', w: 66, ar: 'دائن', en: 'Credit' },
  { key: 'balance', w: 70, ar: 'الرصيد', en: 'Balance' },
  { key: 'status', w: 34, ar: 'الحالة', en: 'Status' },
] as const;

export const fmtMoney = (v: string): string => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso: string): string => iso.slice(0, 10);

export async function buildStatementPdf(s: CustomerStatement, lang: StatementLang, companyName: string): Promise<Buffer> {
  const rtl = lang === 'ar';
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 28,
    bufferPages: true,
    info: { Title: `${L.title[lang]} ${s.customer.code}`, Author: companyName, CreationDate: new Date(s.generatedAt), Producer: 'DAII' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const pen = new Pen(doc);

  const M = 28;
  const W = doc.page.width - M * 2;
  const bottom = doc.page.height - M - 18;
  const edge: 'left' | 'right' = rtl ? 'right' : 'left';
  const t = <K extends keyof typeof L>(k: K): string => L[k][lang];

  // ---- header -----------------------------------------------------------------------------------------------------------------------------------------------
  doc.rect(M, M, W, 54).fill('#f1f5f9');
  doc.fillColor('#0f172a');
  pen.line(companyName, M + 10, M + 8, W - 20, 15, true, rtl, edge);
  pen.line(t('title'), M + 10, M + 30, W - 20, 13, true, rtl, edge);
  const meta = `${t('ref')}: ${s.reference}`;
  pen.line(meta, M + 10, M + 10, W - 20, 8.5, false, rtl, rtl ? 'left' : 'right');
  pen.line(`${t('issued')}: ${fmtDate(s.generatedAt)}`, M + 10, M + 24, W - 20, 8.5, false, rtl, rtl ? 'left' : 'right');
  const periodText = `${s.period.from ?? t('startOfRecords')} ${t('toWord')} ${s.period.to ?? t('upToNow')}`;
  pen.line(`${t('period')}: ${periodText}   |   ${t('currency')}: ${s.currency.code}`, M + 10, M + 38, W - 20, 8.5, false, rtl, rtl ? 'left' : 'right');

  // ---- customer block ----------------------------------------------------------------------------------------------------------------------------------------
  let y = M + 62;
  const c = s.customer;
  const cLines: string[] = [`${t('customer')}: ${c.name}  (${c.code})`];
  if (c.address) cLines.push(`${t('address')}: ${[c.address, c.governorate].filter(Boolean).join('، ')}`);
  const tail = [c.taxRegistrationNumber ? `${t('tax')}: ${c.taxRegistrationNumber}` : null, c.phone ? `${t('phone')}: ${c.phone}` : null, c.paymentTermsDays != null ? `${t('terms')}: ${c.paymentTermsDays} ${t('days')}` : null, c.creditLimit ? `${t('limit')}: ${fmtMoney(c.creditLimit)}` : null].filter(Boolean) as string[];
  if (tail.length) cLines.push(tail.join('   |   '));
  doc.rect(M, y, W, 14 + cLines.length * 12).strokeColor('#cbd5e1').lineWidth(0.6).stroke();
  doc.fillColor('#0f172a');
  cLines.forEach((ln, i) => pen.line(ln, M + 8, y + 6 + i * 12, W - 16, 9.5, i === 0, rtl, edge));
  y += 22 + cLines.length * 12;

  // ---- summary strip -----------------------------------------------------------------------------------------------------------------------------------------
  const tiles: Array<[string, string]> = [
    [t('opening'), fmtMoney(s.openingBalance)],
    [t('debit'), fmtMoney(s.totals.debit)],
    [t('credit'), fmtMoney(s.totals.credit)],
    [t('closing'), fmtMoney(s.closingBalance)],
  ];
  const tw = W / 4;
  tiles.forEach(([label, value], i) => {
    const slot = rtl ? 3 - i : i;
    const x = M + slot * tw;
    doc.rect(x + 2, y, tw - 4, 36).fillAndStroke(i === 3 ? '#e2e8f0' : '#f8fafc', '#cbd5e1');
    doc.fillColor('#475569');
    pen.line(label, x + 2, y + 5, tw - 4, 8.5, false, rtl, 'center');
    doc.fillColor('#0f172a');
    pen.line(value, x + 2, y + 18, tw - 4, 12, true, false, 'center');
  });
  y += 44;
  if (!s.isComplete) {
    doc.fillColor('#b45309');
    pen.line(t('notComplete'), M, y, W, 8.5, false, rtl, edge);
    y += 14;
  }
  doc.fillColor('#0f172a');

  // ---- table ---------------------------------------------------------------------------------------------------------------------------------------------------
  const scale = W / COLS.reduce((a, col) => a + col.w, 0);
  const cols = COLS.map((col) => ({ ...col, w: col.w * scale }));
  const colX = (i: number): number => {
    const before = cols.slice(0, i).reduce((a, col) => a + col.w, 0);
    return rtl ? M + W - before - cols[i].w : M + before;
  };
  const header = (yy: number): number => {
    doc.rect(M, yy, W, 18).fill('#1e293b');
    doc.fillColor('#ffffff');
    cols.forEach((col, i) => pen.line(col[lang], colX(i) + 3, yy + 4, col.w - 6, 8.5, true, rtl, rtl ? 'right' : 'left'));
    doc.fillColor('#0f172a');
    return yy + 20;
  };
  y = header(y);

  const cell = (key: string, r: CustomerStatement['rows'][number]): string => {
    switch (key) {
      case 'date': return fmtDate(r.date);
      case 'type': return r.typeLabel[lang];
      case 'description': return r.description[lang] + (r.flags.length ? (rtl ? '  (!) حركة الخزينة معكوسة' : '  (!) cash reversed') : '');
      case 'document': return r.documentNumber ?? '';
      case 'due': return r.dueDate ?? '';
      case 'debit': return r.debit === '0.00' ? '' : fmtMoney(r.debit);
      case 'credit': return r.credit === '0.00' ? '' : fmtMoney(r.credit);
      case 'balance': return fmtMoney(r.balance);
      case 'status': return r.status === 'reversed' ? (rtl ? 'معكوس' : 'Reversed') : r.isReversalLeg ? (rtl ? 'عكس' : 'Reversal') : rtl ? 'مرحّل' : 'Posted';
      default: return '';
    }
  };

  // opening row
  const openRow = (yy: number): number => {
    doc.rect(M, yy, W, 16).fill('#f1f5f9');
    doc.fillColor('#0f172a');
    pen.line(t('opening'), colX(2) + 3, yy + 4, cols[2].w - 6, 9, true, rtl, rtl ? 'right' : 'left');
    pen.line(fmtMoney(s.openingBalance), colX(7) + 3, yy + 4, cols[7].w - 6, 9, true, false, 'right');
    return yy + 18;
  };
  y = openRow(y);

  if (s.rows.length === 0) {
    pen.line(t('empty'), M, y + 6, W, 10, false, rtl, 'center');
    y += 24;
  }
  for (const r of s.rows) {
    const descLines = pen.wrap(cell('description', r), cols[2].w - 6, 8.5, false, rtl);
    const typeLines = pen.wrap(cell('type', r), cols[1].w - 6, 8.5, false, rtl);
    const nLines = Math.max(descLines.length, typeLines.length, 1);
    const h = 6 + nLines * 11;
    if (y + h > bottom) {
      doc.addPage();
      y = header(M);
    }
    if (r.nettedOut) doc.rect(M, y - 1, W, h).fill('#fafafa');
    doc.fillColor(r.nettedOut ? '#64748b' : '#0f172a');
    cols.forEach((col, i) => {
      const x = colX(i) + 3;
      const w = col.w - 6;
      if (col.key === 'description') descLines.forEach((ln, k) => pen.line(ln, x, y + 3 + k * 11, w, 8.5, false, rtl, rtl ? 'right' : 'left'));
      else if (col.key === 'type') typeLines.forEach((ln, k) => pen.line(ln, x, y + 3 + k * 11, w, 8.5, false, rtl, rtl ? 'right' : 'left'));
      else if (col.key === 'debit' || col.key === 'credit' || col.key === 'balance') pen.line(cell(col.key, r), x, y + 3, w, 8.5, col.key === 'balance', false, 'right');
      else pen.line(cell(col.key, r), x, y + 3, w, 8.5, false, rtl, rtl ? 'right' : 'left');
    });
    doc.moveTo(M, y + h - 2).lineTo(M + W, y + h - 2).strokeColor('#e2e8f0').lineWidth(0.4).stroke();
    y += h;
  }
  doc.fillColor('#0f172a');

  // totals
  if (y + 60 > bottom) {
    doc.addPage();
    y = M;
  }
  y += 6;
  doc.rect(M, y, W, 18).fill('#e2e8f0');
  doc.fillColor('#0f172a');
  pen.line(`${t('closing')}`, colX(2) + 3, y + 5, cols[2].w - 6, 9, true, rtl, rtl ? 'right' : 'left');
  pen.line(fmtMoney(s.totals.debit), colX(5) + 3, y + 5, cols[5].w - 6, 9, true, false, 'right');
  pen.line(fmtMoney(s.totals.credit), colX(6) + 3, y + 5, cols[6].w - 6, 9, true, false, 'right');
  pen.line(fmtMoney(s.closingBalance), colX(7) + 3, y + 5, cols[7].w - 6, 9, true, false, 'right');
  y += 24;
  pen.line(`${t('excl')}: ${t('debit')} ${fmtMoney(s.totalsExcludingReversals.debit)}  |  ${t('credit')} ${fmtMoney(s.totalsExcludingReversals.credit)}`, M, y, W, 8.5, false, rtl, edge);
  y += 14;
  for (const wn of s.warnings) {
    doc.fillColor('#b91c1c');
    pen.line(`(!) ${wn[lang]} (${wn.entryNumbers.join(', ')})`, M, y, W, 8.5, false, rtl, edge);
    y += 12;
  }
  doc.fillColor('#475569');
  pen.line(s.referenceNote[lang], M, y, W, 8, false, rtl, edge);
  y += 11;
  pen.line(s.currency.note[lang], M, y, W, 8, false, rtl, edge);

  // footers: reference + page x of y on every page
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.fillColor('#64748b');
    pen.line(`${s.reference}   |   ${t('generatedBy')}`, M, doc.page.height - M - 6, W, 7.5, false, rtl, rtl ? 'right' : 'left');
    pen.line(`${t('page')} ${i + 1} ${t('of')} ${range.count}`, M, doc.page.height - M - 6, W, 7.5, false, rtl, rtl ? 'left' : 'right');
  }
  doc.end();
  return done;
}
