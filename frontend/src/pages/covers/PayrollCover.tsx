import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { SectionCover } from '../../components/SectionCover';

interface PayrollRun {
  id: string;
  status: string;
}
interface ReconciliationGap {
  payrollRunId: string;
}

/** ADR-070 — `payroll`'s own landing page, same shape as `AttendanceCover`/`HrCover`. */
export function PayrollCover() {
  const { can } = useAuth();
  const [kpis, setKpis] = useState<{ pendingRuns: number; reconciliationGaps: number } | null>(null);
  const canView = can('payroll');

  useEffect(() => {
    if (!canView) return;
    (async () => {
      try {
        const [runs, gaps] = await Promise.all([api.get<PayrollRun[]>('/payroll/runs'), api.get<ReconciliationGap[]>('/payroll/reconciliation-gaps')]);
        setKpis({
          pendingRuns: runs.filter((r) => r.status !== 'posted').length,
          reconciliationGaps: gaps.length,
        });
      } catch {
        // Foundation fix: degrade to no-KPIs rather than an unhandled rejection.
      }
    })();
  }, [canView]);

  return (
    <SectionCover
      titleCode="module.payroll"
      shortcuts={[
        { to: '/payroll/periods', labelCode: 'nav.payroll_periods' },
        { to: '/payroll/compensation', labelCode: 'nav.payroll_compensation' },
        { to: '/payroll/runs', labelCode: 'nav.payroll_runs' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'nav.payroll_runs', value: kpis.pendingRuns, to: '/payroll/runs' },
              { labelCode: 'panel.reconciliation_gaps', value: kpis.reconciliationGaps, to: '/payroll/runs' },
            ]
          : undefined
      }
    />
  );
}
