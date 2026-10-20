import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument, DocumentLine } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';
import { fmtDate } from '../../lib/formatDateTime';

interface LedgerEntry {
  entryNumber: string;
  entryType: string;
  direction: 'debit' | 'credit';
  amount: string;
  entryDate: string;
  reference: string | null;
}
interface Customer {
  code: string;
  name: string;
}

interface CustomerStatementData {
  customer: Customer;
  entries: LedgerEntry[];
}

/** ERP UI Integration (CTO directive) — "كشف حساب عميل" print, the SAME `GET /customer-finance/ledger/:id` (with the same Date/Type filters carried over via query params) the on-screen Customer Statement uses, running balance computed identically. */
export function CustomerStatementPrint() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<CustomerStatementData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload(['document.customer_statement_title', 'field.customer', 'field.date_from', 'field.date_to', 'field.running_balance']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const params = new URLSearchParams();
        const entryType = searchParams.get('entryType');
        const from = searchParams.get('from');
        const to = searchParams.get('to');
        if (entryType) params.set('entryType', entryType);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        const qs = params.toString();

        const [customer, entries] = await Promise.all([
          api.get<Customer>(`/customers/${id}`),
          api.get<LedgerEntry[]>(`/customer-finance/ledger/${id}${qs ? `?${qs}` : ''}`),
        ]);

        setData({ customer, entries });
      } catch (err) {
        // Foundation fix: mount-time load had no error handling.
        setLoadError(err);
      }
    })();
  }, [id, searchParams]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { customer, entries } = data;
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  const { lines, running } = entries.reduce<{ lines: DocumentLine[]; running: number }>(
    (acc, e) => {
      const running = acc.running + (e.direction === 'debit' ? Number(e.amount) : -Number(e.amount));
      return {
        running,
        lines: [
          ...acc.lines,
          {
            label: `${fmtDate(e.entryDate)} — ${t(`customer_ledger_entry_type.${e.entryType}`)} — ${e.entryNumber}`,
            quantity: '',
            unitPrice: e.direction === 'debit' ? e.amount : `(${e.amount})`,
            total: running.toFixed(2),
          },
        ],
      };
    },
    { lines: [], running: 0 },
  );

  const doc: BusinessDocument = {
    documentTitleCode: 'document.customer_statement_title',
    documentNumber: `${customer.code}`,
    issuedAt: new Date().toISOString(),
    fields: [
      { label: t('field.customer'), value: `${customer.code} — ${customer.name}` },
      { label: t('field.date_from'), value: from ? fmtDate(from) : '—' },
      { label: t('field.date_to'), value: to ? fmtDate(to) : '—' },
    ],
    lines,
    totals: [{ label: t('field.running_balance'), value: running.toFixed(2) }],
  };

  return <PrintDocument doc={doc} />;
}
