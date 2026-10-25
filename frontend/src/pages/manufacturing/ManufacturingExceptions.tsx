import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { BlockedReason, DataTable, EmptyState, StatusChip, type Tone } from '../../components/mfg';
import { StatusBadge } from '../../components/StatusBadge';
import { fmtDate } from '../../lib/formatDateTime';

interface FinEvent {
  id: string;
  eventType: string;
  sourceDomain: string;
  sourceEntityId: string;
  status: string;
  businessDate: string;
  rejectionReason: string | null;
  payload: Record<string, unknown>;
}
interface WorkOrder {
  id: string;
  workOrderNumber: string;
  state: string;
  finishedProductId: string;
}

const TONE: Record<string, Tone> = { REJECTED: 'danger', FAILED: 'danger', RECEIVED: 'warning', PENDING: 'warning' };

/**
 * Manufacturing exceptions (UX redesign stage 5): everything that needs a decision, from authoritative records - manufacturing accounting events that did NOT post (rejected / waiting), orders on hold, and whether
 * scrap can be recorded at all. A recovery action (re-drive) is offered only to users who may post journals and always reports the REAL resulting status; nothing is presented as posted unless it is.
 */
export function ManufacturingExceptions() {
  const { t, preload } = useLanguage();
  const { can } = useAuth();
  const canEvents = can('accounting.financial_event.view', 'read-only');
  const canRedrive = can('accounting.journal.post', 'editable');
  const canFixPolicy = can('accounting.account.edit', 'editable');
  const [events, setEvents] = useState<FinEvent[] | null>(null);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [scrap, setScrap] = useState<{ ready: boolean; reason: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; status: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [wo, sr] = await Promise.all([api.get<WorkOrder[]>('/manufacturing/work-orders'), api.get<{ ready: boolean; reason: string | null }>('/manufacturing/work-orders/scrap-readiness').catch(() => null)]);
      setOrders(wo);
      setScrap(sr);
      if (canEvents) {
        const ev = await api.get<FinEvent[]>('/accounting/financial-events?sourceDomain=manufacturing');
        setEvents(ev.filter((e) => !['POSTED', 'IGNORED'].includes(e.status.toUpperCase())));
      } else {
        setEvents(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
    }
  }, [canEvents, t]);
  useEffect(() => {
    void load();
  }, [load]);

  async function redrive(id: string) {
    if (!window.confirm(t('mfg2.ex.confirm_redrive'))) return;
    setBusy(id);
    setError(null);
    try {
      const r = await api.post<{ status: string }>(`/accounting/financial-events/${id}/redrive`, {});
      setResult({ id, status: r.status });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    } finally {
      setBusy(null);
    }
  }
  useEffect(() => {
    void preload(['mfg2.ex.confirm_redrive']); // read at click time inside window.confirm
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const orderOf = (id: string) => orders.find((o) => o.id === id);
  const held = orders.filter((o) => o.state === 'on_hold');

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.manufacturing_exceptions')}</h1>
      </div>
      <p className="mfg-note" style={{ marginBlockStart: 0, fontSize: '0.95rem' }}>
        {t('mfg2.ex.intro')}
      </p>
      {error && <BlockedReason danger>{error}</BlockedReason>}
      {result && (
        <div className="mfg-blocked" role="status" data-testid="ex-result" style={result.status === 'POSTED' ? { background: '#e7f6ec', borderColor: '#7bc596', color: '#1c7a3e', marginBlock: 8 } : { marginBlock: 8 }}>
          {t('mfg2.ex.redrive_result').split('{0}').join(t(`mfg2.rc.status.${result.status.toLowerCase()}`))}
        </div>
      )}

      {scrap && !scrap.ready && (
        <section style={{ marginBlockEnd: 16 }} data-testid="ex-scrap">
          <BlockedReason danger to="/accounting/policy" linkText={canFixPolicy ? t('mfg2.oo.scrap.fix_link') : undefined}>
            <strong>{t('mfg2.ex.scrap_blocked')}</strong> {scrap.reason}
          </BlockedReason>
        </section>
      )}

      <section className="card" aria-labelledby="ex-ev-title" style={{ marginBlockEnd: 20 }}>
        <h2 id="ex-ev-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
          {t('mfg2.ex.events.title')}
        </h2>
        <p className="mfg-note">{t('mfg2.ex.events.help')}</p>
        {!canEvents ? (
          <BlockedReason>{t('mfg2.ex.no_events_permission')}</BlockedReason>
        ) : events === null ? (
          <div className="mfg-note">{t('mfg2.common.loading')}</div>
        ) : (
          <DataTable
            caption={t('mfg2.ex.events.title')}
            rows={events}
            rowKey={(e) => e.id}
            warnRow={() => true}
            empty={<EmptyState title={t('mfg2.ex.events.empty_title')} description={t('mfg2.ex.events.empty_desc')} />}
            columns={[
              { key: 'o', header: t('field.work_order_number'), render: (e) => (orderOf(e.sourceEntityId) ? <Link to={`/manufacturing/work-orders/${e.sourceEntityId}`}>{orderOf(e.sourceEntityId)!.workOrderNumber}</Link> : e.sourceEntityId.slice(0, 8)) },
              { key: 't', header: t('mfg2.rc.col.movement'), render: (e) => t(`mfg2.rc.ev.${e.eventType.replace('manufacturing.work_order.', '')}`) },
              { key: 'd', header: t('field.business_date'), render: (e) => fmtDate(e.businessDate) },
              { key: 'v', header: t('mfg2.oo.col.value'), align: 'end', render: (e) => (e.payload.totalValueBase ? Number(e.payload.totalValueBase).toFixed(2) : '—') },
              { key: 's', header: t('field.status'), render: (e) => <StatusChip tone={TONE[e.status.toUpperCase()] ?? 'neutral'}>{t(`mfg2.rc.status.${e.status.toLowerCase()}`)}</StatusChip> },
              { key: 'r', header: t('field.rejection_reason'), render: (e) => e.rejectionReason ?? '—' },
              {
                key: 'a',
                header: t('field.actions'),
                render: (e) => (
                  <span className="mfg-row-actions">
                    {canRedrive && (
                      <button className="btn btn-secondary" type="button" disabled={busy !== null} onClick={() => redrive(e.id)} data-testid={`ex-redrive-${e.id}`}>
                        {busy === e.id ? t('mfg2.common.working') : t('mfg2.ex.redrive')}
                      </button>
                    )}
                    {canFixPolicy && /scrap-loss|account/i.test(e.rejectionReason ?? '') && <Link to="/accounting/policy">{t('mfg2.oo.scrap.fix_link')}</Link>}
                  </span>
                ),
              },
            ]}
          />
        )}
      </section>

      <section className="card" aria-labelledby="ex-hold-title">
        <h2 id="ex-hold-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
          {t('mfg2.ex.hold.title')}
        </h2>
        <DataTable
          caption={t('mfg2.ex.hold.title')}
          rows={held}
          rowKey={(o) => o.id}
          empty={<EmptyState title={t('mfg2.ex.hold.empty')} />}
          columns={[
            { key: 'n', header: t('field.work_order_number'), render: (o) => <Link to={`/manufacturing/work-orders/${o.id}`}>{o.workOrderNumber}</Link> },
            { key: 's', header: t('field.status'), render: (o) => <StatusBadge code={`work_order_lifecycle.state.${o.state}`} /> },
          ]}
        />
      </section>
    </div>
  );
}
