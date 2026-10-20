import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';

export interface SectionShortcut {
  to: string;
  labelCode: string;
}

export interface SectionKpi {
  labelCode: string;
  /** a ready label (already in the page language) for a tile that has no terminology entry yet; wins over `labelCode` */
  label?: string;
  value: string | number;
  to?: string;
  tone?: 'default' | 'warning' | 'danger' | 'positive';
}

/**
 * CTO directive ("Section Cover / Main Dashboard System") — the one
 * reusable landing-page shell every major module (Sales, Warehouses,
 * Fulfillment, Shipping, Catalog, Treasury, Administration) is built on:
 * a clickable shortcut row at the top (every function/screen the section
 * owns, one click away) and a KPI area below it. Same design system
 * everywhere — a section's own page supplies real data (KPIs computed
 * from the same domain endpoints its own screens already use, never a
 * separate decorative computation) and any section-specific extra
 * content (tables, mini-charts) as `children`; this component owns only
 * the shared layout.
 */
export function SectionCover({
  titleCode,
  shortcuts,
  kpis,
  children,
}: {
  titleCode: string;
  shortcuts: SectionShortcut[];
  kpis?: SectionKpi[];
  children?: React.ReactNode;
}) {
  const { t } = useLanguage();

  return (
    <div>
      <div className="page-header">
        <h1>{t(titleCode)}</h1>
      </div>

      {shortcuts.length > 0 && (
        <div className="section-cover-shortcuts">
          {shortcuts.map((s) => (
            <Link key={s.to} to={s.to} className="section-cover-shortcut">
              {t(s.labelCode)}
            </Link>
          ))}
        </div>
      )}

      {kpis && kpis.length > 0 && (
        <div className="detail-grid" style={{ marginBottom: 20 }}>
          {kpis.map((kpi) => {
            const tileClass = `kpi-tile${kpi.tone && kpi.tone !== 'default' ? ` tone-${kpi.tone}` : ''}`;
            const content = (
              <>
                <div className="label">{kpi.label ?? t(kpi.labelCode)}</div>
                <div className="value">{kpi.value}</div>
              </>
            );
            return kpi.to ? (
              <Link key={kpi.labelCode} to={kpi.to} className={tileClass}>
                {content}
              </Link>
            ) : (
              <div key={kpi.labelCode} className={tileClass}>
                {content}
              </div>
            );
          })}
        </div>
      )}

      {children}
    </div>
  );
}
