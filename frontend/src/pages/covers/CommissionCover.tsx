import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { SectionCover } from '../../components/SectionCover';

interface CommissionResult {
  id: string;
  batchId: string | null;
}
interface CommissionApprovalBatch {
  id: string;
  status: string;
}

/** ADR-071 — `commission`'s own landing page, same shape as `PayrollCover`/`TargetsCover`. */
export function CommissionCover() {
  const { hasRole } = useAuth();
  const [kpis, setKpis] = useState<{ unbatchedResults: number; pendingBatches: number } | null>(null);
  const canView = hasRole('admin');

  useEffect(() => {
    if (!canView) return;
    (async () => {
      const [results, batches] = await Promise.all([api.get<CommissionResult[]>('/commission/results'), api.get<CommissionApprovalBatch[]>('/commission/batches')]);
      setKpis({
        unbatchedResults: results.filter((r) => r.batchId === null).length,
        pendingBatches: batches.filter((b) => b.status === 'submitted').length,
      });
    })();
  }, [canView]);

  return (
    <SectionCover
      titleCode="module.commission"
      shortcuts={[
        { to: '/commission/policies', labelCode: 'nav.commission_policies' },
        { to: '/commission/results', labelCode: 'nav.commission_results' },
        { to: '/commission/batches', labelCode: 'nav.commission_batches' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'field.unbatched_results', value: kpis.unbatchedResults, to: '/commission/results' },
              { labelCode: 'value.approval_status.pending', value: kpis.pendingBatches, to: '/commission/batches' },
            ]
          : undefined
      }
    />
  );
}
