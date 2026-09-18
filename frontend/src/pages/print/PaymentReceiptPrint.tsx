import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';

interface PaymentRow {
  id: string;
  paymentNumber: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  invoiceId: string;
  invoiceNumber: string | null;
  amount: string;
  method: string;
  reference: string | null;
  occurredAt: string;
}

interface PaymentReceiptData {
  payment: PaymentRow;
}

/** ERP UI Integration (CTO directive) — the Payment/Collection receipt, sourced from the SAME `GET /payments` list the Payments screen reads (there is no separate payment-detail endpoint — the list row itself is the record). */
export function PaymentReceiptPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<PaymentReceiptData | null>(null);

  preload(['document.payment_receipt_title', 'field.customer', 'field.invoice', 'field.payment_method', 'field.reference', 'field.total_amount']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const payments = await api.get<PaymentRow[]>('/payments');
      const payment = payments.find((p) => p.id === id);
      if (!payment) return;

      setData({ payment });
    })();
  }, [id]);

  if (!data) return <div className="empty-state">Loading…</div>;
  const { payment } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.payment_receipt_title',
    documentNumber: payment.paymentNumber,
    issuedAt: payment.occurredAt,
    fields: [
      { label: t('field.customer'), value: `${payment.customerCode} — ${payment.customerName}` },
      { label: t('field.invoice'), value: payment.invoiceNumber ?? '—' },
      { label: t('field.payment_method'), value: payment.method },
      { label: t('field.reference'), value: payment.reference ?? '—' },
    ],
    totals: [{ label: t('field.total_amount'), value: payment.amount }],
  };

  return <PrintDocument doc={doc} />;
}
