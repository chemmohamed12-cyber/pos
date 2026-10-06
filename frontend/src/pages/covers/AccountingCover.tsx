import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { SectionCover } from '../../components/SectionCover';

interface TrialBalance {
  totalDebitBase: string;
  totalCreditBase: string;
  balanced: boolean;
}
interface JournalEntry {
  createdAt: string;
}

/** CTO directive ("Section Cover / Main Dashboard System") — `accounting`'s own landing page: trial-balance totals + today's journal activity, from the same endpoints the module's own screens already read. */
export function AccountingCover() {
  const { hasRole } = useAuth();
  const [kpis, setKpis] = useState<{ totalDebit: string; balanced: boolean; todaysJournals: number } | null>(null);
  const canView = hasRole('admin');

  useEffect(() => {
    if (!canView) return;
    (async () => {
      try {
        const [tb, journals] = await Promise.all([
          api.get<TrialBalance>('/accounting/trial-balance'),
          api.get<JournalEntry[]>('/accounting/journals'),
        ]);
        const today = new Date().toISOString().slice(0, 10);
        setKpis({
          totalDebit: tb.totalDebitBase,
          balanced: tb.balanced,
          todaysJournals: journals.filter((j) => j.createdAt.slice(0, 10) === today).length,
        });
      } catch {
        // Foundation fix: degrade to no-KPIs rather than an unhandled rejection.
      }
    })();
  }, [canView]);

  return (
    <SectionCover
      titleCode="module.accounting"
      shortcuts={[
        { to: '/accounting/chart-of-accounts', labelCode: 'nav.chart_of_accounts' },
        { to: '/accounting/journals', labelCode: 'nav.journals' },
        { to: '/accounting/ledger', labelCode: 'nav.general_ledger' },
        { to: '/accounting/trial-balance', labelCode: 'nav.trial_balance' },
        { to: '/accounting/financial-events', labelCode: 'nav.financial_events' },
        { to: '/accounting/ar', labelCode: 'nav.ar_reconciliation' },
        { to: '/accounting/ap', labelCode: 'nav.ap_reconciliation' },
        { to: '/accounting/cash-bank', labelCode: 'nav.cash_bank_reconciliation' },
        { to: '/accounting/fixed-assets', labelCode: 'nav.fixed_assets' },
        { to: '/accounting/inventory', labelCode: 'nav.inventory_accounting' },
        { to: '/accounting/dimensions', labelCode: 'nav.dimensions' },
        { to: '/accounting/settings', labelCode: 'nav.accounting_settings' },
        { to: '/accounting/reports/balance-sheet', labelCode: 'nav.balance_sheet' },
        { to: '/accounting/reports/profit-and-loss', labelCode: 'nav.profit_and_loss' },
        { to: '/accounting/reports/cash-flow', labelCode: 'nav.cash_flow' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'field.debit_base', value: kpis.totalDebit, to: '/accounting/trial-balance' },
              { labelCode: 'panel.balanced', value: kpis.balanced ? '✓' : '✗', to: '/accounting/trial-balance', tone: kpis.balanced ? 'positive' : 'danger' },
              { labelCode: 'nav.journals', value: kpis.todaysJournals, to: '/accounting/journals' },
            ]
          : undefined
      }
    />
  );
}
