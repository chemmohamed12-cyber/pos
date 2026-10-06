import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { SectionCover } from '../../components/SectionCover';

interface Target {
  id: string;
  status: string;
}

/** ADR-071 — `targets`'s own landing page, same shape as `PayrollCover`/`AttendanceCover`. */
export function TargetsCover() {
  const { hasRole } = useAuth();
  const [kpis, setKpis] = useState<{ pendingApproval: number; approved: number } | null>(null);
  const canView = hasRole('admin');

  useEffect(() => {
    if (!canView) return;
    (async () => {
      try {
        const targets = await api.get<Target[]>('/targets/targets');
        setKpis({
          pendingApproval: targets.filter((t) => t.status === 'pending_approval').length,
          approved: targets.filter((t) => t.status === 'approved').length,
        });
      } catch {
        // Foundation fix: degrade to no-KPIs rather than an unhandled rejection.
      }
    })();
  }, [canView]);

  return (
    <SectionCover
      titleCode="module.targets"
      shortcuts={[{ to: '/targets/targets', labelCode: 'nav.targets' }]}
      kpis={
        kpis
          ? [
              { labelCode: 'value.approval_status.pending', value: kpis.pendingApproval, to: '/targets/targets' },
              { labelCode: 'value.target_status.approved', value: kpis.approved, to: '/targets/targets' },
            ]
          : undefined
      }
    />
  );
}
