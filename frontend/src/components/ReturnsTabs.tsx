import { Link, useLocation } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useVisibleRoutes } from '../lib/navVisibility';

/**
 * NAV-06 — the four return screens (customer returns, sales returns, shipment returns, custody returns) live in two sidebar groups. Their routes and
 * permissions are untouched; this strip groups them for the user by linking the others from each one. Only screens the user can reach are listed.
 */
const RETURN_SCREENS = [
  { to: '/returns', labelCode: 'nav.returns' },
  { to: '/sales-returns', labelCode: 'nav.sales_returns' },
  { to: '/shipment-returns', labelCode: 'nav.shipment_returns' },
  { to: '/custody-returns', labelCode: 'nav.custody_returns' },
] as const;

export function ReturnsTabs() {
  const { t, preload } = useLanguage();
  const { pathname } = useLocation();
  const visible = useVisibleRoutes();
  preload(RETURN_SCREENS.map((s) => s.labelCode));
  const shown = RETURN_SCREENS.filter((s) => visible?.has(s.to) || pathname === s.to);
  if (shown.length < 2) return null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }} data-testid="returns-tabs">
      {shown.map((s) => (
        <Link key={s.to} to={s.to} className={`btn ${pathname === s.to ? 'btn-primary' : 'btn-secondary'}`}>
          {t(s.labelCode)}
        </Link>
      ))}
    </div>
  );
}
