import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { SectionCover } from '../../components/SectionCover';

interface CustomerRow {
  id: string;
  status: string;
}
interface BalanceRow {
  customerId: string;
  balance: string;
}
interface InvoiceRow {
  id: string;
  state: string;
  remaining: string;
}
interface ArAgingRow {
  bucket: string;
  remaining: string;
}
interface PaymentRow {
  id: string;
}
interface CreditRow {
  remainingAmount: string;
}

/**
 * ERP UI Integration (CTO directive) — the "العملاء والحسابات" section's own
 * landing page. Every KPI here is read straight from the SAME endpoints the
 * dedicated screens below it use (`/customer-finance/balances`, `/invoices`,
 * `/ar-aging`, `/payments`, `/returns/credits`) — no independent financial
 * calculation, no decorative chart. "لا نريد Charts للزينة."
 */
export function CustomersAccountsCover() {
  const [kpis, setKpis] = useState<{
    totalCustomers: number;
    totalBalances: string;
    totalOutstanding: string;
    totalOverdue: string;
    openInvoices: number;
    collectionsCount: number;
    overdueInvoices: number;
    availableCredits: string;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const [customers, balances, invoices, arAging, payments, credits] = await Promise.all([
        api.get<CustomerRow[]>('/customers'),
        api.get<BalanceRow[]>('/customer-finance/balances'),
        api.get<InvoiceRow[]>('/invoices'),
        api.get<ArAgingRow[]>('/ar-aging'),
        api.get<PaymentRow[]>('/payments'),
        api.get<CreditRow[]>('/returns/credits'),
      ]);

      const totalBalances = balances.reduce((sum, b) => sum + Number(b.balance), 0);
      const openInvoices = invoices.filter((i) => i.state !== 'draft' && i.state !== 'void' && i.state !== 'paid');
      const totalOutstanding = openInvoices.reduce((sum, i) => sum + Number(i.remaining), 0);
      const totalOverdue = arAging.reduce((sum, r) => (r.bucket === 'current' ? sum : sum + Number(r.remaining)), 0);
      const overdueInvoices = arAging.filter((r) => r.bucket !== 'current').length;
      const availableCredits = credits.reduce((sum, c) => sum + Number(c.remainingAmount), 0);

      setKpis({
        totalCustomers: customers.length,
        totalBalances: totalBalances.toFixed(2),
        totalOutstanding: totalOutstanding.toFixed(2),
        totalOverdue: totalOverdue.toFixed(2),
        openInvoices: openInvoices.length,
        collectionsCount: payments.length,
        overdueInvoices,
        availableCredits: availableCredits.toFixed(2),
      });
    })();
  }, []);

  return (
    <SectionCover
      titleCode="nav_group.customers_accounts"
      shortcuts={[
        { to: '/customers', labelCode: 'nav.customers' },
        { to: '/customer-accounts', labelCode: 'nav.customer_accounts' },
        { to: '/customer-statement', labelCode: 'nav.customer_statement' },
        { to: '/invoices', labelCode: 'nav.invoices' },
        { to: '/payments', labelCode: 'nav.payments' },
        { to: '/ar-aging', labelCode: 'nav.ar_aging' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'field.total_customers', value: kpis.totalCustomers, to: '/customer-accounts' },
              { labelCode: 'field.total_customer_balances', value: kpis.totalBalances, to: '/customer-accounts' },
              { labelCode: 'field.total_outstanding_all', value: kpis.totalOutstanding, to: '/invoices', tone: 'warning' },
              { labelCode: 'field.total_overdue_all', value: kpis.totalOverdue, to: '/ar-aging', tone: kpis.overdueInvoices > 0 ? 'danger' : 'default' },
              { labelCode: 'field.open_invoices_count', value: kpis.openInvoices, to: '/invoices' },
              { labelCode: 'field.collections_count', value: kpis.collectionsCount, to: '/payments' },
              { labelCode: 'field.overdue_invoices_count', value: kpis.overdueInvoices, to: '/ar-aging', tone: kpis.overdueInvoices > 0 ? 'danger' : 'default' },
              { labelCode: 'field.available_return_credits', value: kpis.availableCredits, to: '/customer-accounts', tone: 'positive' },
            ]
          : undefined
      }
    />
  );
}
