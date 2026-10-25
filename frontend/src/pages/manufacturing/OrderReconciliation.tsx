import { useMemo } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { DataTable, EmptyState, StatusChip, type Tone } from '../../components/mfg';
import { fmtDate } from '../../lib/formatDateTime';

export interface TrailEvent {
  id: string;
  eventType: string;
  status: string;
  businessDate: string;
  rejectionReason: string | null;
  lines: Array<{ debitBase: string; creditBase: string }>;
}

/** How each manufacturing event moves the order's WIP: +1 = value enters (Dr WIP), -1 = value leaves (Cr WIP), 0 = does not touch WIP. */
const WIP_EFFECT: Record<string, { sign: 1 | -1 | 0; side: 'debit' | 'credit' }> = {
  'manufacturing.work_order.material_issued': { sign: 1, side: 'debit' },
  'manufacturing.work_order.material_returned': { sign: -1, side: 'credit' },
  'manufacturing.work_order.finished_goods_received': { sign: -1, side: 'credit' },
  'manufacturing.work_order.process_outputs_received': { sign: -1, side: 'credit' },
  'manufacturing.work_order.scrap_recognized': { sign: -1, side: 'credit' },
  'manufacturing.work_order.recovery_received': { sign: 0, side: 'debit' },
};
const TONE: Record<string, Tone> = { POSTED: 'success', REJECTED: 'danger', RECEIVED: 'warning', PENDING: 'warning', FAILED: 'danger' };

/**
 * Cost / WIP reconciliation of ONE order, built only from authoritative records (UX redesign stage 5): the physical WIP balance the order reports, against what the financial events say.
 * "Posted" counts only events whose journal really exists; a rejected or pending event is shown as such and explains - never hides - a difference. Nothing here implies a posting succeeded.
 */
export function OrderReconciliation({ events, wipValue, planned, produced, scrapped }: { events: TrailEvent[]; wipValue: number; planned: number; produced: number; scrapped: number }) {
  const { t } = useLanguage();
  const calc = useMemo(() => {
    const rows = events
      .filter((e) => WIP_EFFECT[e.eventType] !== undefined)
      .map((e) => {
        const eff = WIP_EFFECT[e.eventType];
        const value = e.lines.reduce((s, l) => s + Number(eff.side === 'debit' ? l.debitBase : l.creditBase), 0);
        return { id: e.id, type: e.eventType, status: e.status.toUpperCase(), date: e.businessDate, value, wip: eff.sign * value, reason: e.rejectionReason };
      });
    const posted = rows.filter((r) => r.status === 'POSTED').reduce((s, r) => s + r.wip, 0);
    const all = rows.reduce((s, r) => s + r.wip, 0);
    return { rows, posted, all, unposted: all - posted };
  }, [events]);
  const diff = wipValue - calc.posted;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  const verdict = near(diff, 0) ? 'ok' : near(diff, calc.unposted) ? 'unposted' : 'unexplained';
  const fmt = (n: number) => n.toFixed(2);
  const suffix = (type: string) => type.replace('manufacturing.work_order.', '');

  return (
    <section className="card" style={{ marginBlockStart: 20 }} aria-labelledby="rc-title" data-testid="order-reconciliation">
      <h2 id="rc-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
        {t('mfg2.rc.title')}
      </h2>
      <p className="mfg-note">{t('mfg2.rc.help')}</p>
      <div className="mfg-grid cols-4" style={{ marginBlockEnd: 12 }}>
        <div className="mfg-kpi">
          <strong data-testid="rc-physical">{fmt(wipValue)}</strong>
          <span>{t('mfg2.rc.physical')}</span>
        </div>
        <div className="mfg-kpi">
          <strong data-testid="rc-posted">{fmt(calc.posted)}</strong>
          <span>{t('mfg2.rc.posted')}</span>
        </div>
        <div className={`mfg-kpi${calc.unposted !== 0 ? ' alert' : ''}`}>
          <strong data-testid="rc-unposted">{fmt(calc.unposted)}</strong>
          <span>{t('mfg2.rc.unposted')}</span>
        </div>
        <div className={`mfg-kpi${verdict !== 'ok' ? ' alert' : ''}`}>
          <strong data-testid="rc-diff">{fmt(diff)}</strong>
          <span>{t('mfg2.rc.diff')}</span>
        </div>
      </div>
      <div role="status" data-testid="rc-verdict" className={`mfg-blocked${verdict === 'ok' ? '' : verdict === 'unexplained' ? ' mfg-danger' : ''}`} style={verdict === 'ok' ? { background: '#e7f6ec', borderColor: '#7bc596', color: '#1c7a3e' } : undefined}>
        {t(`mfg2.rc.verdict.${verdict}`)}
      </div>
      <p className="mfg-note" data-testid="rc-quantities">
        {t('mfg2.rc.quantities').split('{0}').join(String(planned)).split('{1}').join(String(produced)).split('{2}').join(String(scrapped)).split('{3}').join(String(planned - produced - scrapped))}
      </p>
      <DataTable
        caption={t('mfg2.rc.movements')}
        rows={calc.rows}
        rowKey={(r) => r.id}
        warnRow={(r) => r.status !== 'POSTED'}
        empty={<EmptyState title={t('mfg2.rc.empty')} />}
        columns={[
          { key: 'd', header: t('field.business_date'), render: (r) => fmtDate(r.date) },
          { key: 't', header: t('mfg2.rc.col.movement'), render: (r) => t(`mfg2.rc.ev.${suffix(r.type)}`) },
          { key: 'v', header: t('mfg2.oo.col.value'), align: 'end', render: (r) => fmt(r.value) },
          { key: 'w', header: t('mfg2.rc.col.wip'), align: 'end', render: (r) => (r.status === 'POSTED' ? (r.wip > 0 ? `+${fmt(r.wip)}` : fmt(r.wip)) : '—') },
          { key: 's', header: t('field.status'), render: (r) => <StatusChip tone={TONE[r.status] ?? 'neutral'}>{t(`mfg2.rc.status.${r.status.toLowerCase()}`)}</StatusChip> },
          { key: 'r', header: t('field.rejection_reason'), render: (r) => r.reason ?? '—' },
        ]}
      />
    </section>
  );
}
