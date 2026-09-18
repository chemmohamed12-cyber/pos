import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { SectionCover } from '../../components/SectionCover';

interface Employee {
  id: string;
  status: 'active' | 'on_leave' | 'terminated';
}
interface Department {
  id: string;
}

/** CTO directive ("Section Cover / Main Dashboard System") — `hr`'s own landing page. Terminology seeded by `SeedHrCoverTerminology1755859500000`. */
export function HrCover() {
  const { hasRole } = useAuth();
  const [kpis, setKpis] = useState<{ total: number; active: number; departments: number } | null>(null);
  const canView = hasRole('admin');

  useEffect(() => {
    if (!canView) return;
    (async () => {
      const [employees, departments] = await Promise.all([
        api.get<Employee[]>('/hr/employees'),
        api.get<Department[]>('/hr/departments'),
      ]);
      setKpis({
        total: employees.length,
        active: employees.filter((e) => e.status === 'active').length,
        departments: departments.length,
      });
    })();
  }, [canView]);

  return (
    <SectionCover
      titleCode="module.hr"
      shortcuts={[
        { to: '/hr/employees', labelCode: 'nav.hr_employees' },
        { to: '/hr/departments', labelCode: 'nav.hr_departments' },
        { to: '/hr/leave-requests', labelCode: 'nav.hr_leave_requests' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'field.total_employees', value: kpis.total, to: '/hr/employees' },
              { labelCode: 'field.active_employees', value: kpis.active, to: '/hr/employees' },
              { labelCode: 'field.total_departments', value: kpis.departments, to: '/hr/departments' },
            ]
          : undefined
      }
    />
  );
}
