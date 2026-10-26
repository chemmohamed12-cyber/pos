import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { CompanyScopedRequest } from '../../../foundation/company/company-context.guard';

export interface OrgReportQuery {
  from?: string;
  to?: string;
  /** Limit the report to one organization unit (and, by default, its descendants). */
  unitId?: string;
  includeDescendants?: boolean;
}

export interface OrgMetricDefinition {
  key: string;
  labelEn: string;
  labelAr: string;
  /** How the number is calculated — shown with the report so every figure is explainable. */
  definition: string;
  /** Where the number comes from (table.column) — traceable to the source rows. */
  source: string;
  kind: 'count' | 'amount' | 'snapshot';
}

export interface OrgReportRow {
  /** `branch` row, or one of the two explicit non-branch buckets. */
  bucket: 'branch' | 'unit' | 'company_level' | 'unassigned';
  unitId: string | null;
  name: string;
  /** `null` = the metric's module is not installed in this Company (NOT zero); `0` = installed and nothing happened. */
  metrics: Record<string, number | null>;
  hasActivity: boolean;
}

const UNASSIGNED = '__unassigned__';
const COMPANY_LEVEL = '__company_level__';

const DEFINITIONS: OrgMetricDefinition[] = [
  { key: 'sales_orders_count', labelEn: 'Sales orders created', labelAr: 'أوامر بيع منشأة', kind: 'count', definition: 'Count of sales orders created in the period, by the branch stamped on the order (the warehouse’s owning branch at creation).', source: 'sales_orders.branchOrgUnitId · createdAt' },
  { key: 'sales_orders_value', labelEn: 'Sales orders value', labelAr: 'قيمة أوامر البيع', kind: 'amount', definition: 'Sum of sales_orders.totalAmount for those orders (order value at creation, any state; not revenue).', source: 'sales_orders.totalAmount' },
  { key: 'shipments_count', labelEn: 'Shipments created', labelAr: 'شحنات منشأة', kind: 'count', definition: 'Count of shipments created in the period, by the branch inherited from the sales order.', source: 'shipments.branchOrgUnitId · createdAt' },
  { key: 'purchase_orders_count', labelEn: 'Purchase orders created', labelAr: 'أوامر شراء منشأة', kind: 'count', definition: 'Count of purchase orders created in the period, by the branch of the ordering warehouse.', source: 'purchase_orders.orgUnitId · createdAt' },
  { key: 'purchase_orders_value', labelEn: 'Purchase orders value', labelAr: 'قيمة أوامر الشراء', kind: 'amount', definition: 'Sum of purchase_orders.totalAmountBase for those orders (committed value, any state; not payables).', source: 'purchase_orders.totalAmountBase' },
  { key: 'warehouses_count', labelEn: 'Warehouses (current)', labelAr: 'المخازن (الحالي)', kind: 'snapshot', definition: 'Warehouses as of now, by owning branch (own link, else the parent warehouse’s). Not period-dependent.', source: 'warehouses.orgUnitId' },
  { key: 'gl_debit_base', labelEn: 'Posted debits (base)', labelAr: 'مدين مرحّل (أساسي)', kind: 'amount', definition: 'Sum of debitBase of POSTED journal lines whose business date is in the period, by the line’s org unit (else the entry’s), rolled up to the branch.', source: 'accounting_journal_lines.debitBase · orgUnitId' },
  { key: 'gl_credit_base', labelEn: 'Posted credits (base)', labelAr: 'دائن مرحّل (أساسي)', kind: 'amount', definition: 'Sum of creditBase of POSTED journal lines whose business date is in the period, by the line’s org unit (else the entry’s), rolled up to the branch.', source: 'accounting_journal_lines.creditBase · orgUnitId' },
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Org engine Stage 7 — organizational roll-up report. Every figure has a stated calculation and a traceable source column; a metric whose module is not installed is
 * `null` (never a fake 0); legacy records without a branch appear in an explicit Unassigned bucket (never silently attributed anywhere); the caller only sees the
 * branches inside their scope. For an unrestricted caller each metric is cross-checked against an independent unfiltered total (`control`).
 * Dates are UTC calendar days (`createdAt` / the journal's business date).
 */
@Injectable()
export class OrgReportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly scopes: AccessScopeService,
  ) {}

  private async tableHas(m: EntityManager, table: string, column?: string): Promise<boolean> {
    const rows = await m.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ${column ? 'AND column_name = $2' : ''} LIMIT 1`,
      column ? [table, column] : [table],
    );
    return rows.length > 0;
  }

  async overview(req: CompanyScopedRequest, q: OrgReportQuery) {
    if (!req.user || !req.companyContext) throw new BadRequestException('A Company request is required.');
    const m = req.companyContext.dataSource.manager;
    for (const d of [q.from, q.to]) if (d && !DATE.test(d)) throw new BadRequestException('Dates must be YYYY-MM-DD. / يجب أن يكون التاريخ بصيغة YYYY-MM-DD.');
    if (q.from && q.to && q.from > q.to) throw new BadRequestException('"from" must not be after "to". / تاريخ البداية بعد النهاية.');
    const scope = await this.scopes.forRequest(req);

    const units: Array<{ id: string; type: string; name: string; parentId: string | null; status: string }> = await m.query(`SELECT "id","type","name","parentId","status" FROM "org_units"`);
    const byId = new Map(units.map((u) => [u.id, u]));
    // every stamped unit rolls up to its nearest branch (itself, or an ancestor); units outside any branch are "company level"
    const branchOf = (id: string | null): string => {
      if (!id) return UNASSIGNED;
      const seen = new Set<string>();
      let cur = byId.get(id);
      while (cur && !seen.has(cur.id)) {
        if (cur.type === 'branch') return cur.id;
        seen.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return byId.has(id) ? COMPANY_LEVEL : UNASSIGNED; // a dangling id is data-integrity noise: shown as unassigned
    };

    // the units the report is about
    let selected: Set<string> | null = null;
    let detailMode = false; // a non-company unit was asked for: show that unit and its descendants one by one instead of rolling up to branches
    let scopeName: string | null = null;
    if (q.unitId) {
      const root = byId.get(q.unitId);
      if (!root) throw new BadRequestException('Unknown organization unit. / وحدة تنظيمية غير معروفة.');
      this.scopes.assertUnit(scope, root.id);
      scopeName = root.name;
      detailMode = root.type !== 'company';
      selected = new Set([root.id]);
      if (q.includeDescendants !== false) {
        const grow = (p: string) => units.filter((u) => u.parentId === p).forEach((c) => !selected!.has(c.id) && (selected!.add(c.id), grow(c.id)));
        grow(root.id);
      }
    }

    const period = (col: string, from: string | undefined, to: string | undefined, params: unknown[], isDate = false): string => {
      const parts: string[] = [];
      if (from) { params.push(from); parts.push(`${col} >= $${params.length}::date`); }
      if (to) { params.push(to); parts.push(isDate ? `${col} <= $${params.length}::date` : `${col} < ($${params.length}::date + 1)`); }
      return parts.length ? `AND ${parts.join(' AND ')}` : '';
    };

    const SKIP = '__skip__';
    const keyOf = (id: string | null): string => (detailMode ? (id && selected!.has(id) ? id : SKIP) : branchOf(id));

    type Agg = Map<string, number>;
    const emptyAgg = (): Agg => new Map();
    const add = (agg: Agg, key: string, v: number) => agg.set(key, (agg.get(key) ?? 0) + v);
    const available: Record<string, boolean> = {};
    const values: Record<string, Agg> = {};
    const control: Record<string, number | null> = {};
    const unrestricted = scope.unrestricted;

    // generic grouped query -> metric aggregates (+ an independent unfiltered control total for an unrestricted caller)
    const grouped = async (opts: { metrics: string[]; table: string; unitCol: string; select: string[]; where?: string; dateCol?: string; isDate?: boolean; sqlFrom?: string; probe: string }) => {
      const ok = await this.tableHas(m, opts.table, opts.probe);
      for (const k of opts.metrics) available[k] = ok;
      if (!ok) return;
      const params: unknown[] = [];
      const range = opts.dateCol ? period(opts.dateCol, q.from, q.to, params, opts.isDate) : '';
      const from = opts.sqlFrom ?? `"${opts.table}"`;
      const rows: Array<Record<string, string | null>> = await m.query(
        `SELECT ${opts.unitCol} AS unit, ${opts.select.map((s, i) => `${s} AS v${i}`).join(', ')} FROM ${from} WHERE true ${opts.where ? `AND ${opts.where}` : ''} ${range} GROUP BY 1`,
        params,
      );
      opts.metrics.forEach((k, i) => {
        values[k] = emptyAgg();
        let total = 0;
        for (const r of rows) {
          const v = Number(r[`v${i}`] ?? 0);
          total += v;
          const key = keyOf(r.unit);
          if (key !== SKIP) add(values[k], key, v);
        }
        control[k] = unrestricted ? total : null;
      });
    };

    await grouped({ metrics: ['sales_orders_count', 'sales_orders_value'], table: 'sales_orders', unitCol: '"branchOrgUnitId"', probe: 'branchOrgUnitId', select: ['count(*)', 'COALESCE(sum("totalAmount"),0)'], dateCol: '"createdAt"' });
    await grouped({ metrics: ['shipments_count'], table: 'shipments', unitCol: '"branchOrgUnitId"', probe: 'branchOrgUnitId', select: ['count(*)'], dateCol: '"createdAt"' });
    await grouped({ metrics: ['purchase_orders_count', 'purchase_orders_value'], table: 'purchase_orders', unitCol: '"orgUnitId"', probe: 'orgUnitId', select: ['count(*)', 'COALESCE(sum("totalAmountBase"),0)'], dateCol: '"createdAt"' });
    await grouped({
      metrics: ['warehouses_count'], table: 'warehouses', unitCol: 'COALESCE(w."orgUnitId", p."orgUnitId")', probe: 'orgUnitId', select: ['count(*)'],
      sqlFrom: `"warehouses" w LEFT JOIN "warehouses" p ON p."id" = w."parentWarehouseId"`,
    });
    await grouped({
      metrics: ['gl_debit_base', 'gl_credit_base'], table: 'accounting_journal_lines', unitCol: 'COALESCE(l."orgUnitId", e."orgUnitId")', probe: 'orgUnitId',
      select: ['COALESCE(sum(l."debitBase"),0)', 'COALESCE(sum(l."creditBase"),0)'], where: 'e."postedAt" IS NOT NULL', dateCol: 'e."businessDate"', isDate: true,
      sqlFrom: `"accounting_journal_lines" l JOIN "accounting_journal_entries" e ON e."id" = l."journalEntryId"`,
    });

    // rows: branch roll-up = every active branch (zeros are real zeros when the module is installed) + company-level + explicit Unassigned;
    //       unit detail = the selected unit and its descendants, one row each
    const inScope = (id: string) => scope.unrestricted || scope.unitIds.has(id);
    let keys: string[];
    if (detailMode) keys = [...selected!].filter((id) => byId.get(id)?.status === 'active');
    else keys = [...units.filter((u) => u.type === 'branch' && u.status === 'active').map((u) => u.id), COMPANY_LEVEL, UNASSIGNED].filter((k) => !selected || (k !== UNASSIGNED && k !== COMPANY_LEVEL));
    const extra = new Set<string>();
    for (const agg of Object.values(values)) for (const k of agg.keys()) if (!keys.includes(k)) extra.add(k); // e.g. an archived branch that still carries history
    const rows: OrgReportRow[] = [...keys, ...extra]
      .filter((k) => k === UNASSIGNED || k === COMPANY_LEVEL || inScope(k))
      .filter((k) => !selected || k === UNASSIGNED || k === COMPANY_LEVEL || detailMode || selected.has(k) || [...selected].some((s) => this.isAncestor(s, k, byId)))
      .map((k) => {
        const metrics: Record<string, number | null> = {};
        for (const d of DEFINITIONS) metrics[d.key] = available[d.key] ? (values[d.key]?.get(k) ?? 0) : null;
        const bucket: OrgReportRow['bucket'] = k === UNASSIGNED ? 'unassigned' : k === COMPANY_LEVEL ? 'company_level' : detailMode ? 'unit' : 'branch';
        const unit = byId.get(k);
        return { bucket, unitId: bucket === 'branch' || bucket === 'unit' ? k : null, name: bucket === 'branch' || bucket === 'unit' ? (unit?.name ?? k) : bucket, metrics, hasActivity: Object.values(metrics).some((v) => (v ?? 0) !== 0) };
      });

    const totals: Record<string, number | null> = {};
    for (const d of DEFINITIONS) totals[d.key] = available[d.key] ? rows.reduce((s, r) => s + (r.metrics[d.key] ?? 0), 0) : null;
    // a restricted or unit-limited view is a SUBSET of the Company: its totals cannot be compared with the Company-wide control
    const comparable = unrestricted && !selected;
    const reconciliation = DEFINITIONS.filter((d) => available[d.key] && d.kind !== 'snapshot').map((d) => ({
      metric: d.key,
      reportTotal: totals[d.key],
      sourceTotal: comparable ? control[d.key] : null,
      reconciles: comparable ? Math.abs((totals[d.key] ?? 0) - (control[d.key] ?? 0)) < 0.005 : null,
    }));

    // cost-centre view (financial dimension): posted debits/credits per value in the period
    let costCenters: Array<{ valueId: string; code: string; name: string; unitId: string | null; debitBase: number; creditBase: number }> | null = null;
    if ((await this.tableHas(m, 'accounting_journal_line_dimensions')) && (await this.tableHas(m, 'accounting_financial_dimension_types'))) {
      const params: unknown[] = [];
      const range = period('e."businessDate"', q.from, q.to, params, true);
      const cc: Array<{ id: string; code: string; name: string; orgUnitId: string | null; d: string; c: string }> = await m.query(
        `SELECT v."id", v."code", v."name", v."orgUnitId", COALESCE(sum(l."debitBase"),0) AS d, COALESCE(sum(l."creditBase"),0) AS c
           FROM "accounting_journal_line_dimensions" x
           JOIN "accounting_financial_dimension_types" t ON t."id" = x."dimensionTypeId" AND t."code" = 'cost_center'
           JOIN "accounting_financial_dimension_values" v ON v."id" = x."dimensionValueId"
           JOIN "accounting_journal_lines" l ON l."id" = x."journalLineId"
           JOIN "accounting_journal_entries" e ON e."id" = l."journalEntryId"
          WHERE e."postedAt" IS NOT NULL ${range} GROUP BY v."id", v."code", v."name", v."orgUnitId" ORDER BY v."code"`,
        params,
      );
      costCenters = cc.filter((v) => (!v.orgUnitId || inScope(v.orgUnitId) || inScope(branchOf(v.orgUnitId))) && (!selected || (v.orgUnitId ? selected.has(v.orgUnitId) : !detailMode))).map((v) => ({ valueId: v.id, code: v.code, name: v.name, unitId: v.orgUnitId, debitBase: Number(v.d), creditBase: Number(v.c) }));
    }

    return {
      generatedAt: new Date().toISOString(),
      period: { from: q.from ?? null, to: q.to ?? null, basis: 'UTC calendar days' },
      scope: { unitId: q.unitId ?? null, name: scopeName, includeDescendants: q.unitId ? q.includeDescendants !== false : null, restrictedToCallerScope: !scope.unrestricted },
      definitions: DEFINITIONS,
      moduleAvailability: available,
      rows,
      totals,
      reconciliation,
      costCenters,
    };
  }

  private isAncestor(ancestor: string, id: string, byId: Map<string, { id: string; parentId: string | null }>): boolean {
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur?.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.parentId === ancestor) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  }
}
