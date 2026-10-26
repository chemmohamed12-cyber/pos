import { randomUUID } from 'crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

/**
 * Org engine Stage 8 — legacy reconciliation. A DOCUMENT is given an organizational reference ONLY when a business relationship names it (its warehouse's owning
 * branch, or the parent document's branch). Everything else stays NULL and is reported as such — nothing is ever assigned to the Company root or to a default branch
 * to satisfy a constraint. Only rows whose reference is currently NULL are touched, so history that already carries a reference is never rewritten, every write is
 * logged (`org_migration_log`), a run can be a dry run, and re-running continues where it stopped (idempotent). Financial values are never read for writing; the
 * result carries before/after checksums of the amount columns to prove they did not move.
 */
export interface BackfillStep {
  /** Order matters: a child is derived from its already-backfilled parent. */
  table: string;
  column: string;
  source: string;
  /** SQL that selects `id` and the derived `branch` for rows whose reference is NULL and derivable. */
  derive: string;
  /** Amount columns whose sum must be identical before and after. */
  checksums: string[];
}

const BRANCH_OF_WAREHOUSE = `COALESCE(w."orgUnitId", pw."orgUnitId")`;
const WAREHOUSE_JOIN = `LEFT JOIN "warehouses" w ON w."id" = d."warehouseId" LEFT JOIN "warehouses" pw ON pw."id" = w."parentWarehouseId"`;

export const BACKFILL_STEPS: readonly BackfillStep[] = [
  { table: 'sales_orders', column: 'branchOrgUnitId', source: 'warehouse.owning_branch', checksums: ['totalAmount'],
    derive: `SELECT d."id", ${BRANCH_OF_WAREHOUSE} AS branch FROM "sales_orders" d ${WAREHOUSE_JOIN} WHERE d."branchOrgUnitId" IS NULL AND ${BRANCH_OF_WAREHOUSE} IS NOT NULL` },
  { table: 'sales_invoices', column: 'branchOrgUnitId', source: 'sales_order.branch', checksums: ['totalAmount'],
    derive: `SELECT d."id", o."branchOrgUnitId" AS branch FROM "sales_invoices" d JOIN "sales_orders" o ON o."id"::text = d."salesOrderId"::text WHERE d."branchOrgUnitId" IS NULL AND o."branchOrgUnitId" IS NOT NULL` },
  { table: 'fulfillment_orders', column: 'branchOrgUnitId', source: 'sales_order.branch', checksums: [],
    derive: `SELECT d."id", o."branchOrgUnitId" AS branch FROM "fulfillment_orders" d JOIN "sales_orders" o ON o."id"::text = d."salesOrderId"::text WHERE d."branchOrgUnitId" IS NULL AND o."branchOrgUnitId" IS NOT NULL` },
  { table: 'shipments', column: 'branchOrgUnitId', source: 'sales_order.branch', checksums: ['codAmount'],
    derive: `SELECT d."id", o."branchOrgUnitId" AS branch FROM "shipments" d JOIN "sales_orders" o ON o."id"::text = d."salesOrderId"::text WHERE d."branchOrgUnitId" IS NULL AND o."branchOrgUnitId" IS NOT NULL` },
  { table: 'purchase_orders', column: 'orgUnitId', source: 'warehouse.owning_branch', checksums: ['totalAmountBase'],
    derive: `SELECT d."id", ${BRANCH_OF_WAREHOUSE} AS branch FROM "purchase_orders" d ${WAREHOUSE_JOIN} WHERE d."orgUnitId" IS NULL AND ${BRANCH_OF_WAREHOUSE} IS NOT NULL` },
];

export interface LegacyInventoryRow {
  table: string;
  column: string;
  installed: boolean;
  total: number;
  stamped: number;
  unassigned: number;
  /** Unassigned rows a business relationship CAN name (what a backfill would assign). */
  derivable: number;
  /** Unassigned rows with no relationship to derive from — they stay NULL by design. */
  notDerivable: number;
}

@Injectable()
export class OrgLegacyService {
  constructor(private readonly dataSource: DataSource) {}

  private async installed(m: EntityManager, table: string, column?: string): Promise<boolean> {
    const rows = await m.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ${column ? 'AND column_name = $2' : ''} LIMIT 1`,
      column ? [table, column] : [table],
    );
    return rows.length > 0;
  }

  /** Read-only: how many records of each kind lack a reference, and how many of those a relationship can name. */
  async inventory(manager?: EntityManager) {
    const m = manager ?? this.dataSource.manager;
    const rows: LegacyInventoryRow[] = [];
    for (const step of BACKFILL_STEPS) {
      const installed = await this.installed(m, step.table, step.column);
      if (!installed) {
        rows.push({ table: step.table, column: step.column, installed: false, total: 0, stamped: 0, unassigned: 0, derivable: 0, notDerivable: 0 });
        continue;
      }
      const c = (await m.query(`SELECT count(*)::int AS total, count("${step.column}")::int AS stamped FROM "${step.table}"`))[0];
      const derivable = (await m.query(`SELECT count(*)::int AS n FROM (${step.derive}) x`))[0].n as number;
      rows.push({ table: step.table, column: step.column, installed: true, total: c.total, stamped: c.stamped, unassigned: c.total - c.stamped, derivable, notDerivable: c.total - c.stamped - derivable });
    }
    const units = (await m.query(`SELECT type, status, count(*)::int AS n FROM org_units GROUP BY type, status ORDER BY type, status`)) as Array<{ type: string; status: string; n: number }>;
    const roots = (await m.query(`SELECT id, name FROM org_units WHERE type = 'company' AND "parentId" IS NULL AND status = 'active'`)) as Array<{ id: string; name: string }>;
    const issues: string[] = [];
    if (roots.length > 1) issues.push(`MULTIPLE_COMPANY_ROOTS:${roots.length}`);
    if (units.some((u) => u.type === 'warehouse' && u.status === 'active')) issues.push('LEGACY_WAREHOUSE_UNIT_TYPE');
    return { units, activeRoots: roots, issues, documents: rows };
  }

  /**
   * Backfill the derivable references. `dryRun` reports exactly what WOULD change and writes nothing. Returns the run id, per-table counts and the amount checksums
   * before/after (they must be identical).
   */
  async backfill(opts: { dryRun?: boolean; tables?: string[]; actorUserId?: string | null }, manager?: EntityManager) {
    const run = async (m: EntityManager) => {
      const wanted = opts.tables?.length ? new Set(opts.tables) : null;
      if (wanted) for (const t of wanted) if (!BACKFILL_STEPS.some((s) => s.table === t)) throw new BadRequestException(`Unknown table "${t}" for the backfill.`);
      const runId = randomUUID();
      const out: Array<{ table: string; installed: boolean; assigned: number; byBranch: Array<{ branch: string; n: number }>; checksumBefore: Record<string, string>; checksumAfter: Record<string, string> }> = [];
      for (const step of BACKFILL_STEPS) {
        if (wanted && !wanted.has(step.table)) continue;
        if (!(await this.installed(m, step.table, step.column))) {
          out.push({ table: step.table, installed: false, assigned: 0, byBranch: [], checksumBefore: {}, checksumAfter: {} });
          continue;
        }
        const sum = async () => {
          const r: Record<string, string> = {};
          for (const c of step.checksums) r[c] = String((await m.query(`SELECT COALESCE(sum("${c}"::numeric),0)::text AS s FROM "${step.table}"`))[0].s);
          return r;
        };
        const before = await sum();
        const derived: Array<{ id: string; branch: string }> = await m.query(step.derive);
        const byBranch = new Map<string, number>();
        for (const d of derived) byBranch.set(d.branch, (byBranch.get(d.branch) ?? 0) + 1);
        if (!opts.dryRun && derived.length) {
          // only rows that are STILL null are written (a concurrent stamp wins); the log records exactly what changed
          const written: Array<{ id: string; branch: string }> = await m.query(
            `WITH d AS (${step.derive}), u AS (UPDATE "${step.table}" t SET "${step.column}" = d.branch FROM d WHERE t."id" = d."id" AND t."${step.column}" IS NULL RETURNING t."id", d.branch)
             SELECT id, branch FROM u`,
          );
          for (const w of written) {
            await m.query(
              `INSERT INTO "org_migration_log" ("runId","tableName","columnName","recordId","fromValue","toValue","source","actorUserId") VALUES ($1,$2,$3,$4,NULL,$5,$6,$7)`,
              [runId, step.table, step.column, w.id, w.branch, step.source, opts.actorUserId ?? null],
            );
          }
        }
        const after = await sum();
        for (const c of step.checksums) if (before[c] !== after[c]) throw new Error(`Backfill aborted: "${step.table}.${c}" changed (${before[c]} -> ${after[c]}).`);
        out.push({ table: step.table, installed: true, assigned: derived.length, byBranch: [...byBranch].map(([branch, n]) => ({ branch, n })), checksumBefore: before, checksumAfter: after });
      }
      return { runId: opts.dryRun ? null : runId, dryRun: Boolean(opts.dryRun), steps: out };
    };
    if (manager) return run(manager);
    return this.dataSource.transaction(run);
  }

  async log(runId: string, manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).query(`SELECT "tableName","columnName","recordId","fromValue","toValue","source","actorUserId","createdAt" FROM "org_migration_log" WHERE "runId" = $1 ORDER BY "createdAt"`, [runId]);
  }
}
