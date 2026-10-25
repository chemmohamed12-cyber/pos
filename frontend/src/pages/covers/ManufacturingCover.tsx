import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { DataTable, EmptyState, LinkButton, StatusChip } from '../../components/mfg';
import { StatusBadge } from '../../components/StatusBadge';

interface WorkOrder {
  id: string;
  workOrderNumber: string;
  finishedProductId: string;
  quantityPlanned: number;
  quantityProduced: number;
  quantityScrapped?: number;
  state: string;
  processVersionId?: string | null;
  createdAt?: string;
}
interface FinancialEvent {
  id: string;
  eventType: string;
  status: string;
}

/**
 * Manufacturing overview (UX redesign, stage 2). Two clearly separated entry points - Quick Assembly and Multi-Stage Manufacturing - then only what needs the user's decision now.
 * Every number comes from an existing list endpoint; a user without the permission behind a source simply gets no tile for it (never an error, never a guess).
 */
export function ManufacturingCover() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [orders, setOrders] = useState<WorkOrder[] | null>(null);
  const [activeBoms, setActiveBoms] = useState<number | null>(null);
  const [activeProcesses, setActiveProcesses] = useState<number | null>(null);
  const [rejected, setRejected] = useState<number | null>(null);
  const [products, setProducts] = useState<Map<string, string>>(new Map());

  const canOrders = can('manufacturing.work_order.view', 'read-only');
  const canAssemble = can('inventory.assembly.create', 'editable');
  const canBoms = can('manufacturing.bom.view', 'read-only');
  const canProcesses = can('manufacturing.routing.view', 'read-only');
  const canEvents = can('accounting.financial_event.view', 'read-only');

  useEffect(() => {
    void (async () => {
      const safe = async <T,>(go: boolean, f: () => Promise<T>): Promise<T | null> => {
        if (!go) return null;
        try {
          return await f();
        } catch {
          return null;
        }
      };
      const [wo, boms, procs, evs, prods] = await Promise.all([
        safe(canOrders, () => api.get<WorkOrder[]>('/manufacturing/work-orders')),
        safe(canBoms || canAssemble, () => api.get<Array<{ status: string }>>('/manufacturing/boms')),
        safe(canProcesses, () => api.get<Array<{ status: string }>>('/manufacturing/processes')),
        safe(canEvents, () => api.get<FinancialEvent[]>('/accounting/financial-events?status=REJECTED')),
        safe(true, () => api.get<Array<{ id: string; sku: string; name: string }>>('/products/all')),
      ]);
      setOrders(wo);
      setActiveBoms(boms ? boms.filter((b) => b.status === 'active').length : null);
      setActiveProcesses(procs ? procs.filter((p) => p.status === 'active').length : null);
      setRejected(evs ? evs.filter((e) => e.eventType.startsWith('manufacturing.')).length : null);
      setProducts(new Map((prods ?? []).map((p) => [p.id, `${p.sku} — ${p.name}`])));
    })();
  }, [canOrders, canAssemble, canBoms, canProcesses, canEvents]);

  const count = (s: string) => (orders ?? []).filter((o) => o.state === s).length;
  const attention: Array<{ key: string; label: string; n: number; to: string; alert?: boolean }> = [];
  if (orders) {
    attention.push({ key: 'draft', label: t('mfg2.overview.attention.draft'), n: count('draft'), to: '/manufacturing/work-orders?state=draft' });
    attention.push({ key: 'released', label: t('mfg2.overview.attention.released'), n: count('released'), to: '/manufacturing/work-orders?state=released' });
    attention.push({ key: 'in_progress', label: t('mfg2.overview.attention.in_progress'), n: count('in_progress'), to: '/manufacturing/work-orders?state=in_progress' });
    attention.push({ key: 'on_hold', label: t('mfg2.overview.attention.on_hold'), n: count('on_hold'), to: '/manufacturing/work-orders?state=on_hold' });
  }
  if (rejected !== null) attention.push({ key: 'rejected', label: t('mfg2.overview.attention.rejected'), n: rejected, to: '/accounting/financial-events', alert: rejected > 0 });
  const recent = (orders ?? []).filter((o) => o.state === 'completed').slice(0, 5);

  return (
    <div>
      <div className="page-header">
        <h1>{t('mfg2.overview.title')}</h1>
      </div>
      <p className="mfg-note" style={{ marginBlockStart: 0, fontSize: '0.95rem' }}>
        {t('mfg2.overview.subtitle')}
      </p>

      <div className="mfg-grid cols-2" style={{ marginBlockEnd: 24 }}>
        {canAssemble && (
          <section className="mfg-path-card qa" aria-labelledby="mfg-qa-title">
            <h2 id="mfg-qa-title">{t('mfg2.overview.qa.title')}</h2>
            <p>{t('mfg2.overview.qa.when')}</p>
            <p>{t('mfg2.overview.qa.effect')}</p>
            {activeBoms !== null && (
              <div>
                <StatusChip tone={activeBoms > 0 ? 'success' : 'warning'}>
                  {t('mfg2.overview.qa.ready_label')}: {activeBoms}
                </StatusChip>
              </div>
            )}
            <div className="mfg-path-actions">
              <LinkButton to="/manufacturing/assembly" primary>
                {t('mfg2.overview.qa.cta')}
              </LinkButton>
              {canBoms && <LinkButton to="/manufacturing/boms">{t('nav.manufacturing_boms')}</LinkButton>}
            </div>
          </section>
        )}
        {canOrders && (
          <section className="mfg-path-card ms" aria-labelledby="mfg-ms-title">
            <h2 id="mfg-ms-title">{t('mfg2.overview.ms.title')}</h2>
            <p>{t('mfg2.overview.ms.when')}</p>
            <p>{t('mfg2.overview.ms.requires')}</p>
            {activeProcesses !== null && (
              <div>
                <StatusChip tone={activeProcesses > 0 ? 'success' : 'warning'}>
                  {t('mfg2.overview.ms.ready_label')}: {activeProcesses}
                </StatusChip>
              </div>
            )}
            <div className="mfg-path-actions">
              <LinkButton to="/manufacturing/work-orders" primary>
                {t('mfg2.overview.ms.cta')}
              </LinkButton>
              {canProcesses && <LinkButton to="/manufacturing/processes">{t('nav.manufacturing_processes')}</LinkButton>}
            </div>
          </section>
        )}
      </div>

      {attention.length > 0 && (
        <section aria-labelledby="mfg-attn-title" style={{ marginBlockEnd: 24 }}>
          <h2 id="mfg-attn-title" style={{ fontSize: '1.1rem' }}>
            {t('mfg2.overview.attention.title')}
          </h2>
          <div className="mfg-grid cols-4">
            {attention.map((a) => (
              <Link key={a.key} to={a.to} className={`mfg-kpi${a.alert ? ' alert' : ''}`}>
                <strong>{a.n}</strong>
                <span>{a.label}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {orders && (
        <section aria-labelledby="mfg-recent-title">
          <h2 id="mfg-recent-title" style={{ fontSize: '1.1rem' }}>
            {t('mfg2.overview.recent.title')}
          </h2>
          <DataTable
            caption={t('mfg2.overview.recent.title')}
            rows={recent}
            rowKey={(o) => o.id}
            empty={<EmptyState title={t('mfg2.overview.recent.empty_title')} description={t('mfg2.overview.recent.empty_desc')} />}
            columns={[
              { key: 'n', header: t('mfg2.col.order_no'), render: (o) => <Link to={`/manufacturing/work-orders/${o.id}`}>{o.workOrderNumber}</Link> },
              { key: 'p', header: t('mfg2.col.product'), render: (o) => products.get(o.finishedProductId) ?? '—' },
              { key: 'path', header: t('mfg2.col.path'), render: (o) => (o.processVersionId ? t('mfg2.path.process') : t('mfg2.path.basic')) },
              { key: 'q', header: t('mfg2.col.produced_planned'), align: 'end', render: (o) => `${o.quantityProduced} / ${o.quantityPlanned}` },
              { key: 's', header: t('mfg2.col.scrapped'), align: 'end', render: (o) => o.quantityScrapped ?? 0 },
              { key: 'st', header: t('mfg2.col.status'), render: (o) => <StatusBadge code={`work_order_lifecycle.state.${o.state}`} /> },
            ]}
          />
        </section>
      )}
    </div>
  );
}
