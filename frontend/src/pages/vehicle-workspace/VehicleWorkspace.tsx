import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { loadingLabel, nameOf, currentLang, EVENT_AND_ACTION_NAMES } from '../../lib/displayNames';
import { fmtDateTime } from '../../lib/formatDateTime';
import { money, useTr } from '../treasury/treasuryUi';
import {
  TABS,
  availableActions,
  currentTrip,
  collectionOf,
  custodyRowStatus,
  filterByTab,
  isCashOnDelivery,
  isKnownState,
  tabCounts,
  tripSummary,
  unknownStateCount,
  vehicleAvailability,
  type ActionKey,
  type CustodyRowStatus,
  type StockRow,
  type TabKey,
  type WsCollection,
  type WsShipment,
} from './workspaceModel';
import './vehicle-workspace.css';

interface Vehicle {
  id: string;
  code: string;
  plateNumber: string;
  driverUserId: string | null;
  driverName: string | null;
  branch: string | null;
  status: 'active' | 'retired';
  custodyAccountId: string | null;
  warehouseId: string | null;
}
interface WorkspacePayload {
  vehicle: Vehicle;
  overview: { custodyBalance: string | null; activeShipmentsCount: number; stock: StockRow[] };
  shipments: Array<WsShipment & { collectionVisible: boolean; collection: WsCollection | null }>;
  truncated: boolean;
  collectionsComplete: boolean;
}
interface Overview {
  warehouseId: string | null;
  custodyAccountId: string | null;
  stock: StockRow[];
  custodyBalance: string | null;
  activeShipmentsCount: number;
}
interface ShipmentDetail {
  customer: { id: string; name: string; phone: string | null; address: string | null; governorate: string | null } | null;
  orderTotalAmount: string | null;
  carrier: { type: 'company' | 'vehicle' | null; id: string | null; name: string | null };
  lines: Array<{ id: string; productId: string; quantity: number; unitPrice: string; lineTotal: string }>;
}
interface TrackingEvent {
  id: string;
  eventType: string;
  detail: string | null;
  occurredAt: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}
type Section = 'shipments' | 'custody' | 'expenses' | 'summary';
type CustodyFilter = 'all' | CustodyRowStatus;

const STATE_LABEL: Record<string, [string, string]> = {
  created: ['جديدة', 'New'],
  assigned: ['جاهزة للاستلام', 'Ready for pickup'],
  picked_up: ['تم الاستلام', 'Picked up'],
  in_transit: ['في الطريق', 'In transit'],
  out_for_delivery: ['خرجت للتسليم', 'Out for delivery'],
  delivered: ['تم التسليم', 'Delivered'],
  failed: ['تعذر التسليم', 'Delivery failed'],
  returned: ['مرتجع', 'Returned'],
};
const EVENT_LABEL: Record<string, [string, string]> = {
  assign_driver: ['تعيين السائق', 'Driver assigned'],
  pickup: ['تم الاستلام من المخزن', 'Picked up'],
  depart: ['بدء الرحلة', 'Trip started'],
  arrive_for_delivery: ['الوصول للتسليم', 'Arrived for delivery'],
  deliver: ['تم التسليم', 'Delivered'],
  fail_delivery: ['تعذر التسليم', 'Delivery failed'],
  retry: ['إعادة المحاولة', 'Retry'],
  return_to_sender: ['إرجاع للمرسل', 'Returned to sender'],
};
const ACTION_LABEL: Record<ActionKey, [string, string]> = {
  pickup: ['تأكيد الاستلام من المخزن', 'Confirm pickup'],
  depart: ['بدء الرحلة', 'Start trip'],
  arrive_for_delivery: ['الوصول للتسليم', 'Arrived for delivery'],
  deliver: ['تسجيل التسليم', 'Record delivery'],
  fail_delivery: ['تسجيل تعذر التسليم', 'Record failed delivery'],
};

function stateTone(state: string): string {
  if (state === 'delivered') return 'ok';
  if (state === 'failed') return 'bad';
  if (state === 'returned') return 'muted';
  if (state === 'out_for_delivery' || state === 'in_transit') return 'go';
  return 'warn';
}

/**
 * Vehicle Driver Workspace — STAGE B (read model + existing actions only). A mobile-first, RTL-aware operational screen for one vehicle: its shipments, the cash records
 * linked to them, an honest placeholder for expenses, and a trip summary. Everything shown is read from endpoints that already exist (`/shipments/vehicles`, the vehicle
 * overview, `/shipments`, `/shipments/:id/detail|tracking`, `/delivery/collections`, `/products/all`); the only writes are the existing shipment actions
 * (`/shipments/:id/transition`, `/delivery/outcomes`), validated again by the server. No money is computed here and an unreadable figure is shown as "not available",
 * never as zero. Stage C (custody records, partial collections, expenses, handovers) is NOT part of this screen.
 */
export function VehicleWorkspace() {
  const { vehicleId } = useParams<{ vehicleId: string }>();
  const tr = useTr();
  const { lang, setLang } = useLanguage();
  const { user, can } = useAuth();
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [shipments, setShipments] = useState<WsShipment[] | null>(null);
  const [collections, setCollections] = useState<Map<string, WsCollection | null> | null>(null);
  const [collectionsComplete, setCollectionsComplete] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [driverName, setDriverName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [section, setSection] = useState<Section>('shipments');
  const [tab, setTab] = useState<TabKey>('all');
  const [custodyFilter, setCustodyFilter] = useState<CustodyFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(
    async (initial: boolean) => {
      const seq = ++loadSeq.current;
      if (initial) setError(null);
      setRefreshing(true);
      try {
        // Stage C (F-1, F-3..F-5): ONE server-side, permission-checked read model - vehicle (with the driver's name), overview, the vehicle's shipments (filtered and scoped on the
        // server) and their collection records (batched; hidden ones are flagged, never zero). A vehicle the user may not read answers "not found".
        const w = await api.get<WorkspacePayload>(`/vehicle-workspace/${vehicleId}`);
        const map = new Map<string, WsCollection | null>();
        for (const r of w.shipments) if (r.collectionVisible) map.set(r.id, r.collection ?? null);
        if (seq !== loadSeq.current) return;
        setVehicle(w.vehicle);
        setOverview({ warehouseId: w.vehicle.warehouseId, custodyAccountId: w.vehicle.custodyAccountId, stock: w.overview.stock, custodyBalance: w.overview.custodyBalance, activeShipmentsCount: w.overview.activeShipmentsCount });
        setOverviewFailed(false);
        setShipments(w.shipments);
        setCollections(map);
        setCollectionsComplete(w.collectionsComplete);
        setTruncated(w.truncated);
        setDriverName(w.vehicle.driverName);
        setLoadedAt(new Date());
        setError(null);
      } catch (e) {
        if (seq === loadSeq.current) setError(e);
      } finally {
        if (seq === loadSeq.current) setRefreshing(false);
      }
    },
    [vehicleId],
  );
  useEffect(() => {
    void load(true);
  }, [load]);

  const counts = useMemo(() => (shipments ? tabCounts(shipments) : null), [shipments]);
  const trip = useMemo(() => (shipments ? currentTrip(shipments) : []), [shipments]);
  const summary = useMemo(() => (shipments ? tripSummary(shipments, collectionsComplete ? collections : null) : null), [shipments, collections, collectionsComplete]);

  if (error && !vehicle) {
    return (
      <div className="vw-root">
        <div className="vw-pad">
          <ErrorState error={error} onRetry={() => void load(true)} />
          <Link to="/" className="vw-link">
            ← {tr('الرئيسية', 'Home')}
          </Link>
        </div>
      </div>
    );
  }
  if (!vehicle || !shipments || !counts || !summary) {
    return (
      <div className="vw-root">
        <div className="vw-pad vw-center" role="status">
          {loadingLabel()}
        </div>
      </div>
    );
  }

  const open = shipments.find((s) => s.id === openId) ?? null;
  const goShipments = (key: TabKey) => {
    setTab(key);
    setSection('shipments');
  };
  const goCustody = (f: CustodyFilter) => {
    setCustodyFilter(f);
    setSection('custody');
  };
  const navItems: Array<{ key: Section; ar: string; en: string; badge: number | null; icon: string }> = [
    { key: 'shipments', ar: 'الشحنات', en: 'Shipments', badge: counts.all, icon: '📦' },
    { key: 'custody', ar: 'العهد', en: 'Custody', badge: summary.cashOnDelivery, icon: '💼' },
    { key: 'expenses', ar: 'المصروفات', en: 'Expenses', badge: null, icon: '🧾' },
    { key: 'summary', ar: 'ملخص الرحلة', en: 'Trip summary', badge: null, icon: '📊' },
  ];

  return (
    <div className="vw-root" data-testid="vehicle-workspace">
      <header className="vw-header">
        <div className="vw-header-top">
          <Link to="/" className="vw-link" aria-label={tr('الرئيسية', 'Home')}>
            ← {tr('الرئيسية', 'Home')}
          </Link>
          <div className="vw-header-tools">
            <button type="button" className="vw-btn vw-btn-ghost" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} aria-label={tr('تغيير اللغة', 'Change language')}>
              {lang === 'ar' ? 'English' : 'عربي'}
            </button>
            <button type="button" className="vw-btn vw-btn-ghost" onClick={() => void load(false)} disabled={refreshing} aria-label={tr('تحديث', 'Refresh')}>
              {refreshing ? '…' : '⟳'} {tr('تحديث', 'Refresh')}
            </button>
          </div>
        </div>
        <div className="vw-vehicle">
          <div className="vw-vehicle-main">
            <span className="vw-code">{vehicle.code}</span>
            <span className="vw-plate" dir="ltr">
              {vehicle.plateNumber}
            </span>
          </div>
          <span className={`vw-chip ${vehicle.status === 'active' ? 'ok' : 'muted'}`}>{vehicle.status === 'active' ? tr('نشطة', 'Active') : tr('خارج الخدمة', 'Retired')}</span>
        </div>
        <dl className="vw-facts">
          <div>
            <dt>{tr('السائق', 'Driver')}</dt>
            <dd>{vehicle.driverUserId ? driverName ?? tr('غير متاح الاسم', 'Name not available') : tr('غير معيّن', 'Not assigned')}</dd>
          </div>
          <div>
            <dt>{tr('الفرع', 'Branch')}</dt>
            <dd>{vehicle.branch ? vehicle.branch : '—'}</dd>
          </div>
          <div>
            <dt>{tr('الرحلة الحالية', 'Current trip')}</dt>
            <dd>
              {trip.length === 0 ? (
                tr('لا توجد شحنات مفتوحة', 'No open shipments')
              ) : (
                <button type="button" className="vw-inline-link" onClick={() => { setSection('shipments'); setOpenId(trip[0].id); }}>
                  {tr(`${trip.length} شحنة مفتوحة — متابعة`, `${trip.length} open — resume`)}
                </button>
              )}
            </dd>
          </div>
          <div>
            <dt>{tr('آخر تحديث', 'Last refreshed')}</dt>
            <dd>{loadedAt ? fmtDateTime(loadedAt) : '—'}</dd>
          </div>
        </dl>
        {error != null && (
          <div className="vw-banner bad" role="alert">
            {tr('تعذّر التحديث الأخير — البيانات المعروضة من آخر تحميل ناجح.', 'The last refresh failed — showing data from the last successful load.')}{' '}
            <button type="button" className="vw-inline-link" onClick={() => void load(false)}>
              {tr('إعادة المحاولة', 'Retry')}
            </button>
          </div>
        )}
        <div className="vw-header-links">
          <Link to={`/custodian/vehicle/${vehicle.id}`} className="vw-link">
            {tr('إدارة عهدة السيارة وإغلاقها', 'Manage / close vehicle custody')}
          </Link>
          <Link to="/shipments" className="vw-link">
            {tr('شاشة الشحنات الكاملة', 'Full shipping screen')}
          </Link>
        </div>
      </header>

      <div className="vw-body">
        <main className="vw-main" aria-live="polite">
          {section === 'shipments' && (
            <ShipmentsSection
              shipments={shipments}
              counts={counts}
              tab={tab}
              onTab={setTab}
              unknown={unknownStateCount(shipments)}
              collections={collections}
              truncated={truncated}
              onOpen={setOpenId}
              openId={openId}
            />
          )}
          {section === 'custody' && (
            <CustodySection
              vehicle={vehicle}
              overview={overview}
              overviewFailed={overviewFailed}
              shipments={shipments}
              collections={collections}
              collectionsComplete={collectionsComplete}
              filter={custodyFilter}
              onFilter={setCustodyFilter}
              onOpen={(id) => {
                setSection('shipments');
                setOpenId(id);
              }}
            />
          )}
          {section === 'expenses' && <ExpensesSection />}
          {section === 'summary' && <SummarySection summary={summary} overview={overview} unknown={unknownStateCount(shipments)} onShipments={goShipments} onCustody={goCustody} />}
        </main>
        {open && (
          <ShipmentSheet
            key={open.id}
            shipment={open}
            stock={overview ? overview.stock : null}
            isMine={open.driverUserId === user?.id}
            canActAny={can('wf.logistics.shipment.act_any', 'editable')}
            collection={collectionOf(collections, open.id)}
            onClose={() => setOpenId(null)}
            onChanged={() => void load(false)}
          />
        )}
      </div>

      <nav className="vw-nav" aria-label={tr('أقسام مساحة العمل', 'Workspace sections')}>
        {navItems.map((n) => (
          <button key={n.key} type="button" className={`vw-nav-item ${section === n.key ? 'active' : ''}`} onClick={() => setSection(n.key)} aria-current={section === n.key ? 'page' : undefined}>
            <span className="vw-nav-icon" aria-hidden="true">
              {n.icon}
            </span>
            <span className="vw-nav-label">{tr(n.ar, n.en)}</span>
            {n.badge !== null && n.badge > 0 && <span className="vw-badge">{n.badge}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  const tr = useTr();
  const label = STATE_LABEL[state];
  return <span className={`vw-chip ${stateTone(state)}`}>{label ? tr(label[0], label[1]) : tr(`حالة غير معروفة (${state})`, `Unknown state (${state})`)}</span>;
}

function ShipmentsSection(props: {
  shipments: WsShipment[];
  counts: Record<TabKey, number>;
  tab: TabKey;
  onTab: (k: TabKey) => void;
  unknown: number;
  collections: Map<string, WsCollection | null> | null;
  truncated: boolean;
  onOpen: (id: string) => void;
  openId: string | null;
}) {
  const tr = useTr();
  const rows = filterByTab(props.shipments, props.tab);
  return (
    <section>
      <div className="vw-chips" role="tablist" aria-label={tr('تصفية الشحنات حسب الحالة', 'Filter shipments by status')}>
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={props.tab === t.key} className={`vw-filter ${props.tab === t.key ? 'active' : ''}`} onClick={() => props.onTab(t.key)}>
            {tr(t.ar, t.en)} <span className="vw-count">{props.counts[t.key]}</span>
          </button>
        ))}
        <span className="vw-filter disabled" aria-disabled="true" title={tr('لا توجد بيانات تسليم جزئي مسجلة بعد', 'No partial-delivery data is recorded yet')}>
          {tr('تسليم جزئي', 'Partial delivery')} <span className="vw-count">{tr('غير متاح', 'n/a')}</span>
        </span>
      </div>
      {props.truncated && (
        <div className="vw-banner warn" role="status">
          {tr('عُرضت أحدث الشحنات فقط — القائمة مقطوعة وليست كاملة.', 'Only the latest shipments are shown - the list is cut off, not complete.')}
        </div>
      )}
      {props.unknown > 0 && (
        <div className="vw-banner warn" role="status">
          {tr(`${props.unknown} شحنة بحالة غير معروفة للنظام — تظهر ضمن «الكل» فقط.`, `${props.unknown} shipment(s) have a state this screen does not know — shown under “All” only.`)}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="vw-empty">{tr('لا توجد شحنات في هذه الحالة.', 'No shipments in this status.')}</div>
      ) : (
        <ul className="vw-list">
          {rows.map((s) => {
            const c = collectionOf(props.collections, s.id);
            return (
              <li key={s.id}>
                <button type="button" className={`vw-card ${props.openId === s.id ? 'selected' : ''}`} onClick={() => props.onOpen(s.id)}>
                  <div className="vw-card-row">
                    <span className="vw-waybill" dir="ltr">
                      {s.rshNumber ?? s.waybillNumber}
                    </span>
                    <StateChip state={s.state} />
                  </div>
                  <div className="vw-card-customer">{s.customerName ?? '—'}</div>
                  <div className="vw-card-meta">
                    {s.governorate && <span>{s.governorate}</span>}
                    {s.salesOrderNumber && (
                      <span dir="ltr">
                        {tr('أمر بيع', 'SO')} {s.salesOrderNumber}
                      </span>
                    )}
                    <span dir="ltr">{tr('بوليصة', 'WB')} {s.waybillNumber}</span>
                  </div>
                  {isCashOnDelivery(s) && (
                    <div className="vw-card-cod">
                      {tr('تحصيل عند التسليم', 'Cash on delivery')}: <strong>{money(s.codAmount as string)}</strong>
                      <span className={`vw-mini ${c === undefined ? 'muted' : c ? 'ok' : 'warn'}`}>
                        {c === undefined ? tr('سجل التحصيل غير متاح', 'collection record not available') : c ? (c.remittanceStatus === 'remitted' ? tr('تم التوريد', 'remitted') : tr('تحصيل مسجل — بانتظار التوريد', 'recorded — awaiting remittance')) : tr('لم يُسجل تحصيل', 'no collection recorded')}
                      </span>
                    </div>
                  )}
                  {!isKnownState(s.state) && <div className="vw-card-meta bad">{tr('حالة غير معروفة', 'Unknown state')}</div>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CustodySection(props: {
  vehicle: Vehicle;
  overview: Overview | null;
  overviewFailed: boolean;
  shipments: WsShipment[];
  collections: Map<string, WsCollection | null> | null;
  collectionsComplete: boolean;
  filter: CustodyFilter;
  onFilter: (f: CustodyFilter) => void;
  onOpen: (id: string) => void;
}) {
  const tr = useTr();
  const cod = props.shipments.filter(isCashOnDelivery);
  const rows = cod.map((s) => ({ s, c: collectionOf(props.collections, s.id) }));
  const statusOf = (c: WsCollection | null | undefined): CustodyRowStatus | null => (c === undefined ? null : custodyRowStatus(c));
  const countBy = (st: CustodyRowStatus) => rows.filter((r) => statusOf(r.c) === st).length;
  const filtered = props.filter === 'all' ? rows : rows.filter((r) => statusOf(r.c) === props.filter);
  const chips: Array<{ key: CustodyFilter; ar: string; en: string; n: number | null }> = [
    { key: 'all', ar: 'الكل', en: 'All', n: rows.length },
    { key: 'no_collection', ar: 'بدون تحصيل مسجل', en: 'No collection recorded', n: props.collectionsComplete ? countBy('no_collection') : null },
    { key: 'recorded_pending_remittance', ar: 'تحصيل بانتظار التوريد', en: 'Recorded — awaiting remittance', n: props.collectionsComplete ? countBy('recorded_pending_remittance') : null },
    { key: 'remitted', ar: 'تم التوريد', en: 'Remitted', n: props.collectionsComplete ? countBy('remitted') : null },
  ];
  const balance = props.overview?.custodyBalance ?? null;
  return (
    <section>
      <div className="vw-panel">
        <div className="vw-panel-title">{tr('رصيد حساب عهدة السيارة (الخزينة)', 'Vehicle custody account balance (Treasury)')}</div>
        {props.overviewFailed ? (
          <div className="vw-na">{tr('غير متاح لصلاحياتك أو تعذّر تحميله', 'Not available for your role or could not be loaded')}</div>
        ) : !props.vehicle.custodyAccountId || balance === null ? (
          <div className="vw-na">{tr('لا يوجد حساب عهدة مرتبط بهذه السيارة', 'No custody account is linked to this vehicle')}</div>
        ) : (
          <div className="vw-amount" dir="ltr">
            {money(balance)}
          </div>
        )}
        <p className="vw-note">{tr('الرصيد الدفتري من سجل الخزينة كما هو. تفصيل التحصيلات والمصروفات والتسويات على مستوى العهدة قادم في مرحلة لاحقة.', 'The book balance exactly as the Treasury ledger reports it. A per-custody breakdown of collections, expenses and settlements comes in a later stage.')}</p>
      </div>
      {!props.collectionsComplete && cod.length > 0 && (
        <div className="vw-banner warn" role="status">
          {tr('بعض سجلات التحصيل غير متاحة لصلاحياتك — تظهر «غير متاح» ولا تُحتسب في الأرقام.', 'Some collection records are not available for your role - they show "not available" and are not counted in the figures.')}
        </div>
      )}
      <div className="vw-chips" role="tablist" aria-label={tr('تصفية العهد', 'Filter custody')}>
        {chips.map((c) => (
          <button key={c.key} type="button" role="tab" aria-selected={props.filter === c.key} className={`vw-filter ${props.filter === c.key ? 'active' : ''}`} onClick={() => props.onFilter(c.key)}>
            {tr(c.ar, c.en)} <span className="vw-count">{c.n === null ? '—' : c.n}</span>
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div className="vw-empty">{cod.length === 0 ? tr('لا توجد شحنات بتحصيل عند التسليم على هذه السيارة.', 'No cash-on-delivery shipments on this vehicle.') : tr('لا توجد سجلات في هذه الحالة.', 'No records in this status.')}</div>
      ) : (
        <ul className="vw-list">
          {filtered.map(({ s, c }) => (
            <li key={s.id}>
              <button type="button" className="vw-card" onClick={() => props.onOpen(s.id)}>
                <div className="vw-card-row">
                  <span className="vw-waybill" dir="ltr">
                    {s.rshNumber ?? s.waybillNumber}
                  </span>
                  <StateChip state={s.state} />
                </div>
                <div className="vw-card-customer">{s.customerName ?? '—'}</div>
                <dl className="vw-kv">
                  <div>
                    <dt>{tr('المبلغ المطلوب عند التسليم', 'Expected on delivery')}</dt>
                    <dd dir="ltr">{money(s.codAmount as string)}</dd>
                  </div>
                  <div>
                    <dt>{tr('التحصيل المسجل', 'Recorded collection')}</dt>
                    <dd dir="ltr">{c === undefined ? tr('غير متاح', 'not available') : c ? money(c.amount) : tr('لا يوجد', 'none')}</dd>
                  </div>
                  {c && (
                    <>
                      <div>
                        <dt>{tr('طريقة الدفع', 'Method')}</dt>
                        <dd>{c.method}</dd>
                      </div>
                      <div>
                        <dt>{tr('تاريخ التسجيل', 'Recorded at')}</dt>
                        <dd>{fmtDateTime(c.occurredAt)}</dd>
                      </div>
                      <div>
                        <dt>{tr('التوريد', 'Remittance')}</dt>
                        <dd>{c.remittanceStatus === 'remitted' ? `${tr('تم', 'Remitted')} ${c.remittedAt ? fmtDateTime(c.remittedAt) : ''}` : tr('بانتظار التوريد', 'Awaiting remittance')}</dd>
                      </div>
                    </>
                  )}
                </dl>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExpensesSection() {
  const tr = useTr();
  return (
    <section>
      <div className="vw-panel vw-unsupported" role="status">
        <div className="vw-panel-title">{tr('مصروفات العهدة', 'Custody expenses')}</div>
        <p>{tr('تسجيل المصروفات غير متاح بعد في هذا الإصدار. لا توجد مصروفات مسجلة ولا يمكن إنشاؤها من هذه الشاشة.', 'Expense recording is not available yet in this release. No expenses are recorded and none can be created from this screen.')}</p>
        <p className="vw-note">{tr('عند إتاحته سيمر كل مصروف بسبب إلزامي ومراجعة معتمد آخر، ويستخدم تصنيفات وحسابات معتمدة من المالية فقط.', 'When it is available, every expense will carry a mandatory reason, a separate approver and only finance-approved categories and accounts.')}</p>
      </div>
    </section>
  );
}

function SummarySection(props: {
  summary: ReturnType<typeof tripSummary>;
  overview: Overview | null;
  unknown: number;
  onShipments: (k: TabKey) => void;
  onCustody: (f: CustodyFilter) => void;
}) {
  const tr = useTr();
  const s = props.summary;
  const tile = (label: string, value: number | null, onClick?: () => void, tone = '') => (
    <button type="button" className={`vw-tile ${tone}`} onClick={onClick} disabled={!onClick}>
      <span className="vw-tile-value">{value === null ? tr('غير متاح', 'n/a') : value}</span>
      <span className="vw-tile-label">{label}</span>
    </button>
  );
  const unsupported = (label: string) => (
    <div className="vw-tile unsupported" role="note">
      <span className="vw-tile-value">{tr('غير مدعوم بعد', 'Not supported yet')}</span>
      <span className="vw-tile-label">{label}</span>
    </div>
  );
  const balance = props.overview?.custodyBalance ?? null;
  return (
    <section>
      <h2 className="vw-h2">{tr('الشحنات', 'Shipments')}</h2>
      <div className="vw-tiles">
        {tile(tr('إجمالي الشحنات المسندة', 'Assigned shipments'), s.assigned, () => props.onShipments('all'))}
        {tile(tr('مفتوحة', 'Open'), s.open, () => props.onShipments('all'))}
        {tile(tr('تم التسليم', 'Delivered'), s.delivered, () => props.onShipments('delivered'), 'ok')}
        {tile(tr('تعذر التسليم', 'Delivery failed'), s.failed, () => props.onShipments('failed'), s.failed > 0 ? 'bad' : '')}
        {tile(tr('مرتجعات', 'Returned'), s.returned, () => props.onShipments('returned'))}
        {unsupported(tr('تسليم جزئي', 'Partial deliveries'))}
      </div>
      <h2 className="vw-h2">{tr('التحصيلات والعهدة', 'Collections and custody')}</h2>
      <div className="vw-tiles">
        {tile(tr('شحنات بتحصيل عند التسليم', 'Cash-on-delivery shipments'), s.cashOnDelivery, () => props.onCustody('all'))}
        {tile(tr('تحصيلات مسجلة', 'Collections recorded'), s.collectionsRecorded, () => props.onCustody('all'))}
        {tile(tr('تحصيلات بانتظار التوريد', 'Awaiting remittance'), s.collectionsPendingRemittance, () => props.onCustody('recorded_pending_remittance'), s.collectionsPendingRemittance ? 'warn' : '')}
        {tile(tr('تحصيلات تم توريدها', 'Remitted'), s.collectionsRemitted, () => props.onCustody('remitted'))}
        {unsupported(tr('تحصيلات بانتظار التأكيد', 'Collections awaiting confirmation'))}
        {unsupported(tr('مصروفات بانتظار المراجعة', 'Expenses awaiting review'))}
        {unsupported(tr('نقدية تم تسليمها (إقرار السائق)', 'Cash handed over (driver declaration)'))}
      </div>
      <div className="vw-panel">
        <div className="vw-panel-title">{tr('رصيد حساب عهدة السيارة (الخزينة)', 'Vehicle custody account balance (Treasury)')}</div>
        {balance === null ? <div className="vw-na">{tr('غير متاح', 'Not available')}</div> : <div className="vw-amount" dir="ltr">{money(balance)}</div>}
        <button type="button" className="vw-inline-link" onClick={() => props.onCustody('all')}>
          {tr('عرض سجلات التحصيل', 'View collection records')}
        </button>
      </div>
      <h2 className="vw-h2">{tr('الاستثناءات', 'Exceptions')}</h2>
      <div className="vw-tiles">
        {tile(tr('شحنات تعذر تسليمها', 'Failed deliveries'), s.failed, () => props.onShipments('failed'), s.failed > 0 ? 'bad' : '')}
        {tile(tr('شحنات بحالة غير معروفة', 'Shipments in an unknown state'), props.unknown, () => props.onShipments('all'), props.unknown > 0 ? 'warn' : '')}
      </div>
    </section>
  );
}

function ShipmentSheet(props: {
  shipment: WsShipment;
  stock: StockRow[] | null;
  isMine: boolean;
  canActAny: boolean;
  /** undefined = collection records not available; null = none recorded. */
  collection: WsCollection | null | undefined;
  onClose: () => void;
  onChanged: () => void;
}) {
  const tr = useTr();
  const s = props.shipment;
  const [detail, setDetail] = useState<ShipmentDetail | null>(null);
  const [tracking, setTracking] = useState<TrackingEvent[] | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ActionKey | null>(null);
  const [reason, setReason] = useState('');
  const busyRef = useRef(false);

  const loadDetail = useCallback(() => {
    setDetailError(null);
    api.get<ShipmentDetail>(`/shipments/${s.id}/detail`).then(setDetail).catch(setDetailError);
    api.get<TrackingEvent[]>(`/shipments/${s.id}/tracking`).then(setTracking).catch(() => setTracking([]));
    api.get<Product[]>('/products/all').then(setProducts).catch(() => setProducts(null));
  }, [s.id]);
  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const actions = availableActions({ state: s.state, isMine: props.isMine, canActAny: props.canActAny, codAmount: s.codAmount });

  async function run(key: ActionKey) {
    if (busyRef.current) return; // duplicate-submit guard (a second tap while the first request is in flight is ignored)
    busyRef.current = true;
    setBusy(key);
    setActionError(null);
    try {
      if (key === 'deliver') await api.post('/delivery/outcomes', { shipmentId: s.id, outcome: 'delivered' });
      else if (key === 'fail_delivery') await api.post('/delivery/outcomes', { shipmentId: s.id, outcome: 'failed', failureReason: reason.trim() || undefined });
      else await api.post(`/shipments/${s.id}/transition`, { action: key });
      setConfirm(null);
      setReason('');
      props.onChanged();
      loadDetail();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : tr('تعذّر تنفيذ الإجراء. حاول مرة أخرى.', 'The action failed. Please try again.'));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  const productLabel = (id: string) => {
    const p = products?.find((x) => x.id === id);
    return p ? `${p.name}` : `${tr('صنف', 'Item')} …${id.slice(-6)}`;
  };
  const productSku = (id: string) => products?.find((x) => x.id === id)?.sku ?? null;

  return (
    <aside className="vw-sheet" role="dialog" aria-modal="false" aria-label={tr('تفاصيل الشحنة', 'Shipment details')}>
      <div className="vw-sheet-head">
        <div>
          <div className="vw-waybill" dir="ltr">
            {s.rshNumber ?? s.waybillNumber}
          </div>
          <StateChip state={s.state} />
        </div>
        <button type="button" className="vw-btn vw-btn-ghost" onClick={props.onClose} aria-label={tr('إغلاق', 'Close')}>
          ✕ {tr('إغلاق', 'Close')}
        </button>
      </div>
      <div className="vw-sheet-body">
        {detailError ? <ErrorState error={detailError} onRetry={loadDetail} /> : null}
        <h3 className="vw-h3">{tr('بيانات الشحنة', 'Shipment')}</h3>
        <dl className="vw-kv">
          <div>
            <dt>{tr('رقم البوليصة', 'Waybill')}</dt>
            <dd dir="ltr">{s.waybillNumber}</dd>
          </div>
          {s.salesOrderNumber && (
            <div>
              <dt>{tr('أمر البيع', 'Sales order')}</dt>
              <dd dir="ltr">{s.salesOrderNumber}</dd>
            </div>
          )}
          <div>
            <dt>{tr('العميل', 'Customer')}</dt>
            <dd>{detail?.customer?.name ?? s.customerName ?? '—'}</dd>
          </div>
          {detail?.customer?.address && (
            <div>
              <dt>{tr('العنوان', 'Address')}</dt>
              <dd>{detail.customer.address}</dd>
            </div>
          )}
          {(detail?.customer?.governorate ?? s.governorate) && (
            <div>
              <dt>{tr('المحافظة', 'Governorate')}</dt>
              <dd>{detail?.customer?.governorate ?? s.governorate}</dd>
            </div>
          )}
          {detail?.customer?.phone && (
            <div>
              <dt>{tr('الهاتف', 'Phone')}</dt>
              <dd dir="ltr">
                <a className="vw-tel" href={`tel:${detail.customer.phone}`}>
                  {detail.customer.phone}
                </a>
              </dd>
            </div>
          )}
          <div>
            <dt>{tr('تاريخ الإنشاء', 'Created')}</dt>
            <dd>{fmtDateTime(s.createdAt)}</dd>
          </div>
          {isCashOnDelivery(s) && (
            <div>
              <dt>{tr('تحصيل عند التسليم', 'Cash on delivery')}</dt>
              <dd dir="ltr">{money(s.codAmount as string)}</dd>
            </div>
          )}
        </dl>

        <h3 className="vw-h3">{tr('الأصناف', 'Items')}</h3>
        {!detail ? (
          detailError ? null : <div className="vw-na">{loadingLabel()}</div>
        ) : detail.lines.length === 0 ? (
          <div className="vw-empty">{tr('لا توجد أصناف مسجلة لهذه الشحنة.', 'No item lines are recorded for this shipment.')}</div>
        ) : (
          <ul className="vw-lines">
            {detail.lines.map((l) => {
              const row = vehicleAvailability(props.stock, l.productId);
              const sku = productSku(l.productId);
              return (
                <li key={l.id} className="vw-line">
                  <div className="vw-line-name">{productLabel(l.productId)}</div>
                  {sku && (
                    <div className="vw-line-sku" dir="ltr">
                      {sku}
                    </div>
                  )}
                  <dl className="vw-kv">
                    <div>
                      <dt>{tr('الكمية المشحونة', 'Shipped quantity')}</dt>
                      <dd dir="ltr">{l.quantity}</dd>
                    </div>
                    <div>
                      <dt>{tr('المتاح الآن بمخزون السيارة', 'Available now in the vehicle')}</dt>
                      <dd dir="ltr">{props.stock === null ? tr('غير متاح', 'n/a') : row ? row.available : tr('لا يوجد رصيد مسجل', 'no stock recorded')}</dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
        <p className="vw-note">{tr('الكمية المسلّمة والمتبقية لكل صنف غير مسجلة بعد في النظام — لا تُعرض.', 'Delivered and remaining quantities per item are not recorded in the system yet — not shown.')}</p>

        <h3 className="vw-h3">{tr('النقد المسجل', 'Recorded cash')}</h3>
        {props.collection === undefined ? (
          <div className="vw-na">{tr('سجل التحصيل غير متاح لصلاحياتك', 'The collection record is not available for your role')}</div>
        ) : props.collection ? (
          <dl className="vw-kv">
            <div>
              <dt>{tr('المبلغ المسجل', 'Recorded amount')}</dt>
              <dd dir="ltr">{money(props.collection.amount)}</dd>
            </div>
            <div>
              <dt>{tr('طريقة الدفع', 'Method')}</dt>
              <dd>{props.collection.method}</dd>
            </div>
            <div>
              <dt>{tr('التوريد', 'Remittance')}</dt>
              <dd>{props.collection.remittanceStatus === 'remitted' ? tr('تم التوريد', 'Remitted') : tr('بانتظار التوريد', 'Awaiting remittance')}</dd>
            </div>
          </dl>
        ) : isCashOnDelivery(s) ? (
          <div className="vw-empty">{tr('لم يُسجل تحصيل لهذه الشحنة بعد.', 'No collection has been recorded for this shipment yet.')}</div>
        ) : (
          <div className="vw-empty">{tr('لا يوجد تحصيل عند التسليم لهذه الشحنة.', 'This shipment has no cash on delivery.')}</div>
        )}

        <h3 className="vw-h3">{tr('سجل الحالة', 'Status history')}</h3>
        {tracking === null ? (
          <div className="vw-na">{loadingLabel()}</div>
        ) : tracking.length === 0 ? (
          <div className="vw-empty">{tr('لا توجد أحداث مسجلة.', 'No events recorded.')}</div>
        ) : (
          <ol className="vw-history">
            {tracking.map((ev) => (
              <li key={ev.id}>
                <span className="vw-hist-what">{EVENT_LABEL[ev.eventType] ? tr(EVENT_LABEL[ev.eventType][0], EVENT_LABEL[ev.eventType][1]) : nameOf(EVENT_AND_ACTION_NAMES, ev.eventType, currentLang())}</span>
                <span className="vw-hist-when">{fmtDateTime(ev.occurredAt)}</span>
                {ev.detail && <span className="vw-hist-detail">{ev.detail}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="vw-actions">
        {actionError && (
          <div className="vw-banner bad" role="alert">
            {actionError}
          </div>
        )}
        {confirm ? (
          <div className="vw-confirm" role="alertdialog" aria-label={tr('تأكيد الإجراء', 'Confirm action')}>
            <div className="vw-confirm-text">
              {confirm === 'deliver'
                ? tr('تأكيد تسجيل التسليم النهائي لهذه الشحنة؟ لا يمكن التراجع عنه من هذه الشاشة.', 'Record the final delivery of this shipment? It cannot be undone from this screen.')
                : tr('تأكيد تسجيل تعذر التسليم؟ يُنصح بذكر السبب.', 'Record a failed delivery? Giving the reason is recommended.')}
            </div>
            {confirm === 'fail_delivery' && <input className="vw-input" value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} placeholder={tr('سبب تعذر التسليم', 'Reason for the failed delivery')} aria-label={tr('سبب تعذر التسليم', 'Reason for the failed delivery')} />}
            <div className="vw-confirm-buttons">
              <button type="button" className="vw-btn vw-btn-primary" disabled={busy !== null} onClick={() => void run(confirm)}>
                {busy ? '…' : tr('تأكيد', 'Confirm')}
              </button>
              <button type="button" className="vw-btn vw-btn-ghost" disabled={busy !== null} onClick={() => setConfirm(null)}>
                {tr('إلغاء', 'Cancel')}
              </button>
            </div>
          </div>
        ) : actions.length === 0 ? (
          <div className="vw-note">{s.state === 'created' ? tr('لا توجد إجراءات للسائق قبل تعيين الشحنة.', 'No driver actions until the shipment is assigned.') : tr('لا توجد إجراءات متاحة في هذه الحالة.', 'No actions are available in this status.')}</div>
        ) : (
          <div className="vw-action-buttons">
            {actions.map((a) => (
              <div key={a.key} className="vw-action">
                <button
                  type="button"
                  className={`vw-btn ${a.key === 'fail_delivery' ? 'vw-btn-danger' : 'vw-btn-primary'}`}
                  disabled={!a.enabled || busy !== null}
                  onClick={() => (a.key === 'deliver' || a.key === 'fail_delivery' ? setConfirm(a.key) : void run(a.key))}
                >
                  {busy === a.key ? '…' : tr(ACTION_LABEL[a.key][0], ACTION_LABEL[a.key][1])}
                </button>
                {a.disabledReason === 'cash_on_delivery' && (
                  <div className="vw-note">
                    {tr('هذه الشحنة بتحصيل عند التسليم: يُسجَّل التسليم مع التحصيل من ', 'This shipment has cash on delivery: delivery is recorded together with the collection in the ')}
                    <Link to="/shipments" className="vw-inline-link">
                      {tr('شاشة الشحنات', 'shipping screen')}
                    </Link>
                    {tr(' حتى تتوفر مرحلة التحصيل في هذه الشاشة.', ' until collections are available in this screen.')}
                  </div>
                )}
                {a.disabledReason === 'not_permitted' && <div className="vw-note">{tr('ليست شحنتك ولا تملك صلاحية التنفيذ نيابة عن السائق.', 'This is not your shipment and you cannot act for the driver.')}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
