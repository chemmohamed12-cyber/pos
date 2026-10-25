import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { BlockedReason, DataTable, EmptyState, FormField, StatusChip } from '../../components/mfg';

interface Product {
  id: string;
  sku: string;
  name: string;
  unit?: string | null;
}
interface BomRow {
  finishedProductId: string;
  status: 'active' | 'inactive';
  componentCount: number;
}
interface ProcRow {
  productId: string;
  status: 'draft' | 'active' | 'retired';
  versionNo: number;
}

interface SetupCheck {
  code: string;
  ready: boolean;
  reason: string | null;
}
/** Where each prerequisite is fixed (the link is shown only to users who may edit accounting). */
const FIX_TO: Record<string, string> = { wip_account: '/accounting/chart-of-accounts', inventory_account: '/accounting/chart-of-accounts', scrap_loss_account: '/accounting/policy', receipt_reasons: '/accounting/policy' };

type Path = 'qa' | 'ms';
interface Row {
  p: Product;
  bom: BomRow | null;
  procs: ProcRow[];
  qa: 'ready' | 'inactive' | 'missing';
  ms: 'ready' | 'draft' | 'missing';
}

/**
 * Product manufacturing readiness (UX redesign stage 3): for every product, is it ready for Quick Assembly (an ACTIVE bill of materials) and/or for Multi-Stage manufacturing (an ACTIVE process version),
 * and if not, exactly what is missing and where to fix it. Everything is derived from the existing BOM and process endpoints - nothing new is stored.
 */
export function ManufacturingReadiness() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const canBom = can('manufacturing.bom.view', 'read-only');
  const canProc = can('manufacturing.routing.view', 'read-only');
  const [products, setProducts] = useState<Product[] | null>(null);
  const [boms, setBoms] = useState<BomRow[]>([]);
  const [procs, setProcs] = useState<ProcRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupCheck[] | null>(null);
  const [search, setSearch] = useState('');
  const [only, setOnly] = useState<'configured' | 'all'>('configured');

  useEffect(() => {
    void (async () => {
      try {
        const [prods, b, pr] = await Promise.all([api.get<Product[]>('/products/all'), canBom ? api.get<BomRow[]>('/manufacturing/boms') : Promise.resolve([]), canProc ? api.get<ProcRow[]>('/manufacturing/processes') : Promise.resolve([])]);
        setProducts(prods);
        setBoms(b);
        setProcs(pr);
        try {
          setSetup(await api.get<SetupCheck[]>('/manufacturing/work-orders/setup-status'));
        } catch {
          setSetup(null); // the user may not read orders: the section simply is not shown
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
      }
    })();
  }, [canBom, canProc, t]);

  const rows: Row[] = useMemo(() => {
    const byBom = new Map(boms.map((b) => [b.finishedProductId, b]));
    const byProc = new Map<string, ProcRow[]>();
    for (const x of procs) byProc.set(x.productId, [...(byProc.get(x.productId) ?? []), x]);
    return (products ?? []).map((p) => {
      const bom = byBom.get(p.id) ?? null;
      const pl = byProc.get(p.id) ?? [];
      return {
        p,
        bom,
        procs: pl,
        qa: !bom ? 'missing' : bom.status === 'active' ? 'ready' : 'inactive',
        ms: pl.some((x) => x.status === 'active') ? 'ready' : pl.some((x) => x.status === 'draft') ? 'draft' : 'missing',
      } as Row;
    });
  }, [products, boms, procs]);

  const q = search.trim().toLowerCase();
  const shown = rows
    .filter((r) => (only === 'all' ? true : r.bom || r.procs.length > 0))
    .filter((r) => !q || `${r.p.sku} ${r.p.name}`.toLowerCase().includes(q))
    .sort((a, b) => Number(a.qa === 'ready' || a.ms === 'ready') - Number(b.qa === 'ready' || b.ms === 'ready') || a.p.sku.localeCompare(b.p.sku));
  const count = (path: Path) => rows.filter((r) => (path === 'qa' ? r.qa : r.ms) === 'ready').length;

  const cell = (path: Path, r: Row) => {
    const state = path === 'qa' ? r.qa : r.ms;
    if (state === 'ready') return <StatusChip tone="success">{t('mfg2.rd.ready')}</StatusChip>;
    const why = path === 'qa' ? (state === 'inactive' ? t('mfg2.rd.qa.inactive') : t('mfg2.rd.qa.missing')) : state === 'draft' ? t('mfg2.rd.ms.draft') : t('mfg2.rd.ms.missing');
    const to = path === 'qa' ? '/manufacturing/boms' : '/manufacturing/processes';
    const allowed = path === 'qa' ? canBom : canProc;
    return (
      <span>
        <StatusChip tone="warning">{t('mfg2.rd.not_ready')}</StatusChip> <small>{why}</small> {allowed && <Link to={to}>{t('mfg2.rd.fix')}</Link>}
      </span>
    );
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.manufacturing_readiness')}</h1>
      </div>
      <p className="mfg-note" style={{ marginBlockStart: 0, fontSize: '0.95rem' }}>
        {t('mfg2.rd.intro')}
      </p>
      {error && <BlockedReason danger>{error}</BlockedReason>}
      {setup && setup.length > 0 && (
        <section className="card" style={{ marginBlockEnd: 16 }} aria-labelledby="su-title" data-testid="setup-health">
          <h2 id="su-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
            {t('mfg2.su.title')}
          </h2>
          <p className="mfg-note">{t('mfg2.su.help')}</p>
          <DataTable
            caption={t('mfg2.su.title')}
            rows={setup}
            rowKey={(c) => c.code}
            warnRow={(c) => !c.ready}
            columns={[
              { key: 'n', header: t('mfg2.su.col.setting'), render: (c) => t(`mfg2.su.${c.code}`) },
              { key: 's', header: t('mfg2.col.status'), render: (c) => <StatusChip tone={c.ready ? 'success' : 'danger'}>{c.ready ? t('mfg2.su.ok') : t('mfg2.su.missing')}</StatusChip> },
              {
                key: 'r',
                header: t('mfg2.su.col.detail'),
                render: (c) => (
                  <span>
                    {c.ready ? t('mfg2.su.ok_detail') : c.reason}{' '}
                    {!c.ready && can('accounting.account.edit', 'editable') && <Link to={FIX_TO[c.code] ?? '/accounting/policy'}>{t('mfg2.oo.scrap.fix_link')}</Link>}
                  </span>
                ),
              },
            ]}
          />
        </section>
      )}
      {products && (
        <div className="mfg-grid cols-2" style={{ marginBlockEnd: 16 }}>
          <div className="mfg-kpi">
            <strong>{count('qa')}</strong>
            <span>{t('mfg2.rd.kpi.qa')}</span>
          </div>
          <div className="mfg-kpi">
            <strong>{count('ms')}</strong>
            <span>{t('mfg2.rd.kpi.ms')}</span>
          </div>
        </div>
      )}
      <div className="card" style={{ marginBlockEnd: 16 }}>
        <div className="mfg-grid cols-2">
          <FormField label={t('mfg2.rd.search')}>{(p) => <input {...p} type="search" value={search} onChange={(e) => setSearch(e.target.value)} />}</FormField>
          <FormField label={t('mfg2.rd.scope')} hint={t('mfg2.rd.scope_hint')}>
            {(p) => (
              <select {...p} value={only} onChange={(e) => setOnly(e.target.value as 'configured' | 'all')}>
                <option value="configured">{t('mfg2.rd.scope.configured')}</option>
                <option value="all">{t('mfg2.rd.scope.all')}</option>
              </select>
            )}
          </FormField>
        </div>
      </div>
      {products === null ? (
        <div className="mfg-note">{t('mfg2.common.loading')}</div>
      ) : (
        <DataTable
          caption={t('mfg2.rd.table')}
          rows={shown}
          rowKey={(r) => r.p.id}
          empty={<EmptyState title={t('mfg2.rd.empty_title')} description={t('mfg2.rd.empty_desc')} />}
          columns={[
            { key: 'p', header: t('mfg2.col.product'), render: (r) => `${r.p.sku} — ${r.p.name}` },
            { key: 'qa', header: t('mfg2.rd.col.qa'), render: (r) => cell('qa', r) },
            { key: 'ms', header: t('mfg2.rd.col.ms'), render: (r) => cell('ms', r) },
          ]}
        />
      )}
    </div>
  );
}
