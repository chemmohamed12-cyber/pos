import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useNavGroups } from '../lib/navVisibility';

/**
 * NAV-13 — the Dashboard's KPIs are sales/fulfilment only, so a finance / procurement / HR user lands on data that is not theirs. This adds, without
 * touching those KPIs or any role/company behaviour, a "your work areas" row: one link per section the user can actually reach (taken from the same
 * server-driven navigation as the sidebar, so it always matches their role, entitlement and Company). Links go to each section's cover page.
 */
export function DashboardSections() {
  const { t, preload } = useLanguage();
  const groups = useNavGroups();
  const sections = (groups ?? []).filter((g) => g.code && (g.coverTo || g.items[0]));
  preload(['panel.dashboard_sections_title', ...sections.map((g) => g.code)]);
  if (sections.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="dashboard-sections">
      <h3 style={{ marginTop: 0 }}>{t('panel.dashboard_sections_title')}</h3>
      <div className="section-cover-shortcuts">
        {sections.map((g) => (
          <Link key={g.code} to={g.coverTo ?? g.items[0].to} className="section-cover-shortcut">
            {t(g.code)}
          </Link>
        ))}
      </div>
    </div>
  );
}
