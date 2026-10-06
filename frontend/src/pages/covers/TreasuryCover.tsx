import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { SectionCover } from '../../components/SectionCover';
import { MiniBarChart } from '../../components/MiniBarChart';

interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
  balance: string;
}
interface LedgerEntry {
  createdAt: string;
}

/** CTO directive ("Section Cover / Main Dashboard System") — the Treasury section's own landing page: total balance across every real account and today's ledger activity, from the exact endpoints `TreasuryAccounts.tsx`/`TreasuryLedger.tsx` already read. */
export function TreasuryCover() {
  const { hasRole } = useAuth();
  const { t } = useLanguage();
  const [kpis, setKpis] = useState<{ totalBalance: string; todaysCount: number } | null>(null);
  const [topAccounts, setTopAccounts] = useState<TreasuryAccount[]>([]);
  const canView = hasRole('admin', 'finance');

  useEffect(() => {
    if (!canView) return;
    (async () => {
      try {
        const [accounts, ledger] = await Promise.all([
          api.get<TreasuryAccount[]>('/treasury/accounts'),
          api.get<LedgerEntry[]>('/treasury/ledger'),
        ]);
        const today = new Date().toISOString().slice(0, 10);
        setKpis({
          totalBalance: accounts.reduce((sum, a) => sum + Number(a.balance), 0).toFixed(2),
          todaysCount: ledger.filter((e) => e.createdAt.slice(0, 10) === today).length,
        });
        setTopAccounts([...accounts].sort((a, b) => Number(b.balance) - Number(a.balance)).slice(0, 5));
      } catch {
        // Foundation fix: degrade to no-KPIs rather than an unhandled rejection.
      }
    })();
  }, [canView]);

  return (
    <SectionCover
      titleCode="nav_group.treasury"
      shortcuts={[
        { to: '/treasury/accounts', labelCode: 'nav.treasury_accounts' },
        { to: '/treasury/ledger', labelCode: 'nav.treasury_ledger' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'field.total_treasury_balance', value: kpis.totalBalance, to: '/treasury/accounts' },
              { labelCode: 'field.todays_transactions', value: kpis.todaysCount, to: '/treasury/ledger' },
            ]
          : undefined
      }
    >
      {topAccounts.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('field.top_accounts_by_balance')}</h3>
          <MiniBarChart
            data={topAccounts.map((a) => ({ label: `${a.code} — ${a.name}`, value: Number(a.balance) }))}
            formatValue={(v) => v.toFixed(2)}
          />
        </div>
      )}
    </SectionCover>
  );
}
