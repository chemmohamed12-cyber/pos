import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { SectionCover } from '../../components/SectionCover';
import { MiniBarChart } from '../../components/MiniBarChart';

interface AdminUser {
  roles: string[];
}
interface Connector {
  status: string;
}

/** CTO directive ("Section Cover / Main Dashboard System") — the Administration section's own landing page: real user/role/integration counts, from the exact endpoints `Admin.tsx`/`ExternalIntegrations.tsx` already read. */
export function AdminCover() {
  const { hasRole, user } = useAuth();
  const { t } = useLanguage();
  const [kpis, setKpis] = useState<{ totalUsers: number; activeIntegrations: number } | null>(null);
  const [roleBreakdown, setRoleBreakdown] = useState<Array<{ label: string; value: number }>>([]);
  const canView = hasRole('admin');

  useEffect(() => {
    if (!canView) return;
    (async () => {
      const [users, connectors] = await Promise.all([
        api.get<AdminUser[]>('/admin/users'),
        api.get<Connector[]>('/integrations/connectors'),
      ]);
      setKpis({
        totalUsers: users.length,
        activeIntegrations: connectors.filter((c) => c.status === 'connected').length,
      });
      const counts = new Map<string, number>();
      for (const u of users) {
        for (const role of u.roles) counts.set(role, (counts.get(role) ?? 0) + 1);
      }
      setRoleBreakdown([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([role, count]) => ({ label: t(`role.${role}`), value: count })));
    })();
  }, [canView, t]);

  return (
    <SectionCover
      titleCode="nav_group.administration"
      shortcuts={[
        { to: '/organization', labelCode: 'nav.organization' },
        { to: '/admin', labelCode: 'nav.admin' },
        { to: '/integrations', labelCode: 'nav.integrations' },
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'field.total_users', value: kpis.totalUsers, to: '/admin' },
              { labelCode: 'field.active_integrations', value: kpis.activeIntegrations, to: '/integrations' },
            ]
          : undefined
      }
    >
      {roleBreakdown.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('field.users_by_role')}</h3>
          <MiniBarChart data={roleBreakdown} />
        </div>
      )}
      {!canView && user && <div className="empty-state">—</div>}
    </SectionCover>
  );
}
