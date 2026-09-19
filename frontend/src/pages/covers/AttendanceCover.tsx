import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { SectionCover } from '../../components/SectionCover';

interface AttendanceRawRecord {
  id: string;
}
interface AttendanceApprovalBatch {
  id: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
}

/** ADR-065 (Attendance Phase 1) — `attendance`'s own landing page, same shape as `HrCover`. */
export function AttendanceCover() {
  const { hasRole } = useAuth();
  const [kpis, setKpis] = useState<{ unmapped: number; pendingBatches: number } | null>(null);
  const canView = hasRole('admin');

  useEffect(() => {
    if (!canView) return;
    (async () => {
      const [unmapped, batches] = await Promise.all([
        api.get<AttendanceRawRecord[]>('/attendance/raw-records/unmapped'),
        api.get<AttendanceApprovalBatch[]>('/attendance/approval-batches'),
      ]);
      setKpis({ unmapped: unmapped.length, pendingBatches: batches.filter((b) => b.status === 'submitted').length });
    })();
  }, [canView]);

  return (
    <SectionCover
      titleCode="module.attendance"
      shortcuts={[
        { to: '/attendance/connectors', labelCode: 'nav.attendance_connectors' },
        { to: '/attendance/import', labelCode: 'nav.attendance_import' },
        { to: '/attendance/days', labelCode: 'nav.attendance_days' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'panel.no_unmapped_records_yet', value: kpis.unmapped, to: '/attendance/connectors' },
              { labelCode: 'nav.attendance_days', value: kpis.pendingBatches, to: '/attendance/days' },
            ]
          : undefined
      }
    />
  );
}
