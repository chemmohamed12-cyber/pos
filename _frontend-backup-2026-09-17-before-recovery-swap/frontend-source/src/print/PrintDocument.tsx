import { useLanguage } from '../context/LanguageContext';
import type { BusinessDocument } from './documentTypes';
import './print.css';

/**
 * The one reusable "Print / PDF Renderer" (CTO directive §6) every
 * business document goes through — a print page assembles a
 * `BusinessDocument` contract and hands it here; nothing about Sales
 * Orders, Shipments, Deposits, etc. is known by this component. Adding a
 * new document type never means writing a new print implementation,
 * only a new contract + a thin page that fetches data through the same
 * domain endpoints the operational screens already use (CTO directive
 * §11 — no print-specific business calculations).
 *
 * Today's renderer target is the browser's native print/"Save as PDF" —
 * deliberately not a bespoke PDF library (CTO directive: don't build
 * tomorrow's complexity today). Because every document already flows
 * through this one component, swapping in a real server-side PDF
 * renderer later is a change to THIS file alone.
 */
export function PrintDocument({ doc, children }: { doc: BusinessDocument; children?: React.ReactNode }) {
  const { t, lang } = useLanguage();

  return (
    <div className="print-page" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <div className="print-toolbar no-print">
        <button className="btn btn-primary" onClick={() => window.print()}>
          {lang === 'ar' ? 'طباعة / PDF' : 'Print / PDF'}
        </button>
      </div>

      <div className="print-sheet">
        <header className="print-header">
          <div className="print-brand">{lang === 'ar' ? 'منصة دائي' : 'Daii Platform'}</div>
          <div className="print-doc-title">
            <div className="print-doc-title-text">{t(doc.documentTitleCode)}</div>
            <div className="print-doc-number">{doc.documentNumber}</div>
          </div>
        </header>

        <div className="print-meta-row">
          <span>{lang === 'ar' ? 'التاريخ' : 'Date'}: {new Date(doc.issuedAt).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-US')}</span>
          {doc.statusLabel && <span>{lang === 'ar' ? 'الحالة' : 'Status'}: {doc.statusLabel}</span>}
        </div>

        {doc.fields.length > 0 && (
          <div className="print-fields">
            {doc.fields.map((f) => (
              <div key={f.label} className="print-field">
                <div className="print-field-label">{f.label}</div>
                <div className="print-field-value">{f.value}</div>
              </div>
            ))}
          </div>
        )}

        {doc.lines && doc.lines.length > 0 && (
          <table className="print-lines-table">
            <thead>
              <tr>
                <th>{lang === 'ar' ? 'الصنف' : 'Item'}</th>
                <th>{lang === 'ar' ? 'الكمية' : 'Qty'}</th>
                <th>{lang === 'ar' ? 'سعر الوحدة' : 'Unit Price'}</th>
                <th>{lang === 'ar' ? 'الإجمالي' : 'Total'}</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.label}</td>
                  <td>{l.quantity ?? '—'}</td>
                  <td>{l.unitPrice ?? '—'}</td>
                  <td>{l.total ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {doc.totals && doc.totals.length > 0 && (
          <div className="print-totals">
            {doc.totals.map((f) => (
              <div key={f.label} className="print-total-row">
                <span>{f.label}</span>
                <strong>{f.value}</strong>
              </div>
            ))}
          </div>
        )}

        {children}

        {doc.footerNote && <p className="print-footer-note">{doc.footerNote}</p>}

        <div className="print-signatures">
          <div className="print-signature-block">
            <div className="print-signature-line" />
            <div>{lang === 'ar' ? 'إعداد' : 'Prepared By'}{doc.responsibleUser ? `: ${doc.responsibleUser}` : ''}</div>
          </div>
          <div className="print-signature-block">
            <div className="print-signature-line" />
            <div>{lang === 'ar' ? 'الاعتماد' : 'Approved By'}</div>
          </div>
          <div className="print-signature-block">
            <div className="print-signature-line" />
            <div>{lang === 'ar' ? 'الاستلام' : 'Received By'}</div>
          </div>
        </div>

        <footer className="print-footer">Daii Platform — {new Date().getFullYear()}</footer>
      </div>
    </div>
  );
}
