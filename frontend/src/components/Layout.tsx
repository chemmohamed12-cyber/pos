import { useEffect, useState, Fragment } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { api } from '../lib/api';
import { CompanySwitcher } from './CompanySwitcher';
import { ErrorState } from './ErrorState';
import { companyRemountKey } from '../lib/companyScope';
import './Layout.css';
import { loadingLabel, roleLabel } from '../lib/displayNames';

interface NavItem {
  to: string;
  code: string;
  /** Optional sub-heading (terminology code) shown above the first item of each run of items sharing it - presentation only. */
  section?: string;
}
interface NavGroup {
  code: string; // section header terminology code, or '' for the standalone top-level item
  items: NavItem[];
  /** CTO directive ("Section Cover / Main Dashboard System") — the group header itself links to this section's Cover page, not just a toggle. */
  coverTo?: string;
}

/** Accordion: at most one group open at a time — opening one closes any other, avoiding the crowded all-expanded sidebar. */
function loadOpenGroup(): string | null {
  try {
    return localStorage.getItem('daii_nav_open_group') || null;
  } catch {
    return null;
  }
}

/**
 * Foundation fix (Permission/Entitlement-aware nav): the sidebar used to be
 * a hardcoded `NAV_GROUPS` array filtered client-side by a role check —
 * exactly the "frontend re-invents authorization" anti-pattern the CTO
 * directive forbids, and it silently drifted from the backend's own
 * `NAVIGATION_REGISTRY`. `GET /me/navigation` (`NavigationService.resolveFor`,
 * already built server-side: Module -> Feature -> Entitlement -> Permission
 * -> Role) is "the SPA's only source of sidebar structure" per its own doc
 * comment — this now actually uses it instead of duplicating it.
 */
function useNavigation() {
  const [groups, setGroups] = useState<NavGroup[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .get<{ groups: NavGroup[] }>('/me/navigation')
      .then((res) => {
        if (!cancelled) setGroups(res.groups);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return { groups, error, retry: () => setReloadToken((n) => n + 1) };
}

export function Layout() {
  const { user, logout, companyContext, canPlatform, authz } = useAuth();
  const { lang, setLang, t, preload } = useLanguage();
  const [openGroup, setOpenGroup] = useState<string | null>(loadOpenGroup);
  const [navOpen, setNavOpen] = useState(false); // phone widths: the sidebar is an off-canvas drawer
  const { groups: visibleGroups, error: navError, retry: retryNav } = useNavigation();

  useEffect(() => {
    if (!visibleGroups) return;
    const codes = visibleGroups.flatMap((g) => [g.code, ...g.items.map((i) => i.code)]).filter(Boolean);
    preload(codes);
  }, [visibleGroups, preload]);

  useEffect(() => {
    preload(['module.control_plane', 'nav.company_registry']);
  }, [preload]);

  function toggleGroup(code: string) {
    setOpenGroup((prev) => {
      const next = prev === code ? null : code;
      localStorage.setItem('daii_nav_open_group', next ?? '');
      return next;
    });
  }

  // Used by the section title's own Cover-page link: navigating there should
  // always reveal its children too, never collapse them (unlike the chevron
  // toggle / header-row click, which do toggle open<->closed).
  function expandGroup(code: string) {
    setOpenGroup(code);
    localStorage.setItem('daii_nav_open_group', code);
  }

  return (
    <div className="app-shell">
      <button type="button" className="nav-toggle" aria-label={lang === 'ar' ? 'القائمة' : 'Menu'} aria-expanded={navOpen} onClick={() => setNavOpen((o) => !o)}>
        ☰
      </button>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={navOpen ? 'sidebar open' : 'sidebar'} onClick={(e) => { if ((e.target as HTMLElement).closest('a')) setNavOpen(false); }}>
        <div className="brand">Daii</div>
        {(canPlatform('platform.company.view') || canPlatform('platform.support.view')) && (
          // XNEXUS Control Plane — Installation-level, gated by the platform
          // `admin` role directly (same authorization axis as the backend's
          // `RolesGuard`/`@RequireRole('admin')` on `CompanyRegistryController`,
          // never `CompanyContextGuard`). Deliberately outside `/me/navigation`
          // and `navigation-registry.ts` — this is not a Company-scoped nav
          // item and XNEXUS is not an operational Company tenant.
          <div className="nav-section expanded control-plane-section">
            <div className="nav-section-header">
              <span className="nav-section-header-title">{t('module.control_plane')}</span>
            </div>
            <div className="nav-section-items">
              {canPlatform('platform.company.view') && (
                <NavLink to="/control-plane" end className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
                  {t('nav.company_registry')}
                </NavLink>
              )}
              {canPlatform('platform.support.view') && (
                <NavLink to="/control-plane/support" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
                  {lang === 'ar' ? 'وصول الدعم' : 'Support access'}
                </NavLink>
              )}
              {canPlatform('platform.role.view') && (
                <NavLink to="/control-plane/roles" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
                  {lang === 'ar' ? 'أدوار المنصة' : 'Platform roles'}
                </NavLink>
              )}
            </div>
          </div>
        )}
        <nav>
          {visibleGroups === null && !navError && <div className="empty-state">{lang === 'ar' ? 'جارِ التحميل…' : loadingLabel()}</div>}
          {Boolean(navError) && <ErrorState error={navError} onRetry={retryNav} />}
          {visibleGroups?.length === 0 && (
            <div className="empty-state">{lang === 'ar' ? 'لا توجد عناصر تنقل متاحة' : 'No navigation items available'}</div>
          )}
          {visibleGroups?.map((group, i) =>
            group.code === '' ? (
              group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
                  {t(item.code)}
                </NavLink>
              ))
            ) : (
              <div key={group.code || i} className={`nav-section${openGroup === group.code ? ' expanded' : ''}`}>
                <div
                  className="nav-section-header"
                  onClick={(e) => {
                    // The title text still links to the section's Cover page (CTO
                    // directive), and the chevron button has its own handler — only
                    // expand/collapse here when the click landed elsewhere on the row.
                    if ((e.target as HTMLElement).closest('a, button')) return;
                    toggleGroup(group.code);
                  }}
                >
                  {group.coverTo ? (
                    <NavLink to={group.coverTo} className="nav-section-header-title" onClick={() => expandGroup(group.code)}>
                      {t(group.code)}
                    </NavLink>
                  ) : (
                    <span className="nav-section-header-title">{t(group.code)}</span>
                  )}
                  <button className="nav-chevron-btn" onClick={() => toggleGroup(group.code)} aria-label={t(group.code)}>
                    <span className={`nav-chevron ${openGroup === group.code ? '' : 'collapsed'}`}>▾</span>
                  </button>
                </div>
                {openGroup === group.code && (
                  <div className="nav-section-items">
                    {group.items.map((item, idx) => (
                      <Fragment key={item.to}>
                        {item.section && item.section !== group.items[idx - 1]?.section && <div className="nav-subsection">{t(item.section)}</div>}
                        <NavLink to={item.to} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
                          {t(item.code)}
                        </NavLink>
                      </Fragment>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
        </nav>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="topbar-user">
            {user && (
              <>
                <span className="user-name">{user.fullName}</span>
                <span className="user-roles">{user.roles.map((r) => roleLabel(t, r)).join(', ')}</span>
              </>
            )}
            <CompanySwitcher />
          </div>
          <div className="topbar-actions">
            <button className="lang-toggle" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
              {lang === 'ar' ? 'EN' : 'ع'}
            </button>
            <button className="logout-btn" onClick={logout}>
              {t('action.logout')}
            </button>
          </div>
        </header>
        {/* Company-aware remount: switching Company (see CompanySwitcher) reloads
            the whole page today, but this key is the documented Foundation
            convention (lib/companyScope.ts) for the day a lighter-weight switch
            replaces that reload — every Company-scoped screen under here must
            remount, never keep stale state, when companyContext changes. */}
        {authz?.membership?.kind === 'support' && authz.membership.expiresAt && (
          <div role="status" data-testid="support-banner" style={{ background: '#fef3c7', color: '#92400e', padding: '8px 16px', fontSize: '0.9rem' }}>
            {lang === 'ar'
              ? `وصول دعم محدد المدة إلى «${companyContext?.companyName ?? ''}» — للقراءة فقط — ينتهي ${new Date(authz.membership.expiresAt).toLocaleString('ar-EG')}`
              : `Time-boxed support access to “${companyContext?.companyName ?? ''}” — read-only — ends ${new Date(authz.membership.expiresAt).toLocaleString('en-GB')}`}
          </div>
        )}
        <main className="content" key={companyRemountKey(companyContext?.companyId ?? null)}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
