import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';

/**
 * One generic print view for every Reports tab (CTO directive §10:
 * "consume the existing reusable Printing/Data Contract; do not rebuild
 * printing"). A report is a variable-width table, which doesn't fit
 * `BusinessDocument.lines` (a fixed 4-column line-item shape built for
 * order lines) — so this uses `<PrintDocument>`'s own `children` slot,
 * the exact extension point it already exposes for exactly this case,
 * and renders the report's own column/row shape as a plain table
 * instead of forcing it into the order-line contract. The branded
 * header/RTL/footer/signature chrome is still 100% the shared
 * component — nothing about that is reimplemented here.
 */
const STATUS_CODES = [
  'draft', 'supervisor_review', 'manager_approval', 'pending_resubmission', 'deposit_verification', 'released',
].map((s) => `sales_order_approval.state.${s}`);

export function ReportPrint() {
  const [params] = useSearchParams();
  const { t, lang, preload } = useLanguage();
  const type = params.get('type') ?? 'sales_orders';
  const [columns, setColumns] = useState<ReportColumn[]>([]);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);

  const { cols } = REPORT_ENDPOINTS[type] ?? REPORT_ENDPOINTS.sales_orders;
  preload([TITLE_CODE[type] ?? 'nav.reports', ...cols.map((c) => c.code), ...STATUS_CODES]);

  useEffect(() => {
    (async () => {
      try {
        const qs = new URLSearchParams(params);
        qs.delete('type');
        const query = qs.toString() ? `?${qs.toString()}` : '';
        const { path, cols } = REPORT_ENDPOINTS[type] ?? REPORT_ENDPOINTS.sales_orders;
        const data = await api.get<Array<Record<string, unknown>>>(`${path}${query}`);
        setColumns(cols);
        setRows(data);
        setLoaded(true);
      } catch (err) {
        // Foundation fix: mount-time load had no error handling.
        setLoadError(err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, params.toString()]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!loaded) return <div style={{ padding: 24 }}>…</div>;

  const doc: BusinessDocument = {
    documentTitleCode: TITLE_CODE[type] ?? 'nav.reports',
    documentNumber: new Date().toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US'),
    issuedAt: new Date().toISOString(),
    fields: [],
    footerNote: `${rows.length} ${lang === 'ar' ? 'سجل' : 'records'}`,
  };

  return (
    <PrintDocument doc={doc}>
      <table className="print-lines-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{t(c.code)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key}>{formatCell(row[c.key], c.kind, lang, t)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </PrintDocument>
  );
}

function formatCell(value: unknown, kind: ColumnKind | undefined, lang: string, t: (code: string) => string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (kind === 'date') return new Date(String(value)).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US');
  if (kind === 'status') return t(`sales_order_approval.state.${value}`);
  return String(value);
}

type ColumnKind = 'date' | 'status';
interface ReportColumn {
  key: string;
  code: string; // Terminology Registry code
  kind?: ColumnKind;
}

const REPORT_ENDPOINTS: Record<string, { path: string; cols: ReportColumn[] }> = {
  sales_orders: {
    path: '/reports/sales-orders',
    cols: [
      { key: 'orderNumber', code: 'field.order_number' },
      { key: 'createdAt', code: 'field.created_at', kind: 'date' },
      { key: 'customerName', code: 'field.customer' },
      { key: 'salesRepName', code: 'role.sales_rep' },
      { key: 'status', code: 'field.status', kind: 'status' },
      { key: 'totalAmount', code: 'field.total_amount' },
    ],
  },
  sales_by_period: {
    path: '/reports/sales-by-period',
    cols: [
      { key: 'period', code: 'field.period' },
      { key: 'orderCount', code: 'field.order_count' },
      { key: 'totalAmount', code: 'field.total_amount' },
    ],
  },
  sales_by_customer: {
    path: '/reports/sales-by-customer',
    cols: [
      { key: 'customerName', code: 'field.customer' },
      { key: 'orderCount', code: 'field.order_count' },
      { key: 'totalAmount', code: 'field.total_amount' },
    ],
  },
  sales_by_rep: {
    path: '/reports/sales-by-rep',
    cols: [
      { key: 'salesRepName', code: 'role.sales_rep' },
      { key: 'orderCount', code: 'field.order_count' },
      { key: 'totalAmount', code: 'field.total_amount' },
    ],
  },
};

const TITLE_CODE: Record<string, string> = {
  sales_orders: 'nav.sales_orders',
  sales_by_period: 'field.sales_by_period',
  sales_by_customer: 'field.sales_by_customer',
  sales_by_rep: 'field.sales_by_rep',
};
