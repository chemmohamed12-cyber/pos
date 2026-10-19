import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CostEngine } from '../domain/cost-engine';
import type { HistoryInconsistency, ValuedPosition, ValuedPositionFilter } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { InventoryValuationState } from '../infrastructure/inventory-valuation-state.entity';
import { InventoryValuationMovement } from '../infrastructure/inventory-valuation-movement.entity';

// ADR-041 D17 — reserved shape, no FX yet. `currencyCode` is VARCHAR(3) (ISO 4217 width, same
// convention as `accounting_currencies.code`) — 'XXX' is the same "no real currency resolved"
// placeholder `FinancialEventService` already falls back to, not an invented ISO code.
const BASE_CURRENCY_PLACEHOLDER = 'XXX';

/**
 * F08 — Inventory Valuation (ADR-041 D2). Moving Average (Weighted
 * Average Cost). Every write:
 *   1. takes `pg_advisory_xact_lock(hashtext('valuation:<warehouseId>:<productId>'))` for the
 *      duration — the IDENTICAL pattern `InventoryService.reserveStockInTransaction` already uses
 *      (ADR-041 D15), reused unchanged;
 *   2. reads the current `InventoryValuationState` row (or treats it as `{0, 0, null}` if none
 *      exists yet);
 *   3. computes the new quantity/value/average ENTIRELY in SQL `NUMERIC` (ADR-041 D16) — no
 *      JavaScript float arithmetic ever touches a stored monetary value;
 *   4. writes the new state AND appends an append-only `InventoryValuationMovement` history row,
 *      via the SAME `manager` (so both writes are atomic with whatever transaction the caller —
 *      typically F07's ingest-time handler bridge — is already running, per ADR-041 D18a).
 *
 * F03's own `FinancialEvent.idempotencyKey` UNIQUE constraint is what actually prevents this
 * engine from ever being invoked twice for the same real occurrence (`ingest()`/`redrive()` both
 * short-circuit BEFORE calling a handler for an already-processed event — confirmed by direct
 * code read). `InventoryValuationMovement.idempotencyKey`'s own UNIQUE constraint is a
 * defense-in-depth backstop (ADR-041 D15) — if it is ever hit, the resulting DB error correctly
 * rolls back the whole shared transaction (fail loudly, never silently double-count) rather than
 * being caught and treated as a normal "already applied" case, since normal operation never
 * exercises this path at all.
 */
@Injectable()
export class MovingAverageCostEngine implements CostEngine {
  constructor(private readonly dataSource: DataSource) {}

  private run<T>(manager: EntityManager | undefined, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return manager ? fn(manager) : this.dataSource.transaction(fn);
  }

  private lockKey(warehouseId: string, productId: string): string {
    return `valuation:${warehouseId}:${productId}`;
  }

  async resolveIssueCost(productId: string, warehouseId: string, manager?: EntityManager): Promise<{ unitCostBase: string } | null> {
    const source = manager ?? this.dataSource;
    const state = await source.getRepository(InventoryValuationState).findOne({ where: { productId, warehouseId } });
    if (!state || state.averageCostBase == null || state.onHandQuantity <= 0) return null;
    return { unitCostBase: state.averageCostBase };
  }

  /** D4 — pure read of the history rows of `issue` kind for the given idempotency keys (positive quantity / value). */
  async getIssueCostsByKeys(idempotencyKeys: string[], manager?: EntityManager): Promise<Array<{ idempotencyKey: string; quantity: number; valueBase: string }>> {
    if (idempotencyKeys.length === 0) return [];
    const runner = manager ?? this.dataSource;
    const rows: Array<{ idempotencyKey: string; quantity: number; value: string }> = await runner.query(
      `SELECT "idempotencyKey", ABS("quantity")::int AS quantity, ABS("valueDeltaBase")::text AS value
         FROM "inventory_valuation_movements"
        WHERE kind = 'issue' AND "idempotencyKey" = ANY($1::text[])`,
      [idempotencyKeys],
    );
    return rows.map((r) => ({ idempotencyKey: r.idempotencyKey, quantity: Number(r.quantity), valueBase: r.value }));
  }

  async applyIssue(
    productId: string,
    warehouseId: string,
    quantity: number,
    idempotencyKey: string,
    manager?: EntityManager,
    businessDate?: string,
  ): Promise<{ unitCostBase: string; totalCostBase: string } | { rejected: 'negative_on_hand' } | null> {
    return this.run(manager, async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.lockKey(warehouseId, productId)]);

      const stateRepo = m.getRepository(InventoryValuationState);
      const state = await stateRepo.findOne({ where: { productId, warehouseId } });
      if (!state || state.averageCostBase == null || state.onHandQuantity <= 0) return null; // no_valuation_source

      if (quantity > state.onHandQuantity) return { rejected: 'negative_on_hand' as const }; // NO mutation

      // Captured BEFORE mutation — this is the rate actually charged for THIS
      // dispatch. Reading `state.averageCostBase` again after the mutation
      // below is wrong: it becomes `null` whenever this issue exactly zeroes
      // out on-hand quantity (a real, common case — e.g. using up the last
      // units of a lot), which previously made this method incorrectly
      // report `unitCostBase: null` for an otherwise perfectly valid issue.
      const costCharged = state.averageCostBase;

      const beforeValue = state.totalValueBase;
      const [row]: Array<{ issue_value: string; after_value: string }> = await m.query(
        `SELECT
           ($1::numeric(20,4) * $2::int)::numeric(20,4) AS issue_value,
           ($3::numeric(20,4) - $1::numeric(20,4) * $2::int)::numeric(20,4) AS after_value`,
        [costCharged, quantity, beforeValue],
      );
      const afterQty = state.onHandQuantity - quantity;
      const afterAvg = afterQty > 0 ? costCharged : null; // weighted average is UNCHANGED by an issue, but undefined once on-hand hits zero

      state.onHandQuantity = afterQty;
      state.totalValueBase = row.after_value;
      state.averageCostBase = afterAvg;
      await stateRepo.save(state);

      await m.getRepository(InventoryValuationMovement).save(
        m.getRepository(InventoryValuationMovement).create({
          productId,
          warehouseId,
          kind: 'issue',
          stockMovementId: null,
          quantity: -quantity,
          quantityBeforeValueBase: beforeValue,
          valueDeltaBase: `-${row.issue_value}`,
          quantityAfterValueBase: row.after_value,
          averageCostAfterBase: afterAvg,
          idempotencyKey,
          ...(businessDate ? { businessDate } : {}), // C2: the document's business date; otherwise the column default (processing date, UTC)
        }),
      );

      return { unitCostBase: costCharged, totalCostBase: row.issue_value };
    });
  }

  /**
   * ADR-061 (Manufacturing) — see `CostEngine.applyPolicyValuedIssue`'s
   * doc comment for the full scoping rationale. Mirrors `applyIssue`
   * above exactly (same lock, same on-hand guard, same history-row
   * shape) except the value removed is `appliedValueBase` (caller-
   * supplied, ADR-061 §7-derived) instead of `quantity × averageCostBase`
   * — and the remaining average is recomputed from the REMAINING value,
   * not left at the old (now policy-overridden) rate.
   */
  async applyPolicyValuedIssue(
    productId: string,
    warehouseId: string,
    quantity: number,
    appliedValueBase: string,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<{ appliedValueBase: string } | { rejected: 'negative_on_hand' | 'value_exceeds_on_hand' } | null> {
    return this.run(manager, async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.lockKey(warehouseId, productId)]);

      const stateRepo = m.getRepository(InventoryValuationState);
      const state = await stateRepo.findOne({ where: { productId, warehouseId } });
      if (!state || state.averageCostBase == null || state.onHandQuantity <= 0) return null; // no_valuation_source

      if (quantity > state.onHandQuantity) return { rejected: 'negative_on_hand' as const }; // NO mutation

      const beforeValue = state.totalValueBase;
      const [check]: Array<{ exceeds: boolean }> = await m.query(
        `SELECT ($1::numeric(20,4) > $2::numeric(20,4)) AS exceeds`,
        [appliedValueBase, beforeValue],
      );
      if (check.exceeds) return { rejected: 'value_exceeds_on_hand' as const }; // NO mutation

      const afterQty = state.onHandQuantity - quantity;
      const [row]: Array<{ after_value: string; after_avg: string | null }> = await m.query(
        `SELECT
           ($1::numeric(20,4) - $2::numeric(20,4))::numeric(20,4) AS after_value,
           CASE WHEN $3::int > 0
             THEN (($1::numeric(20,4) - $2::numeric(20,4)) / $3::int)::numeric(20,4)
             ELSE NULL
           END AS after_avg`,
        [beforeValue, appliedValueBase, afterQty],
      );

      state.onHandQuantity = afterQty;
      state.totalValueBase = row.after_value;
      state.averageCostBase = row.after_avg;
      await stateRepo.save(state);

      await m.getRepository(InventoryValuationMovement).save(
        m.getRepository(InventoryValuationMovement).create({
          productId,
          warehouseId,
          kind: 'issue',
          stockMovementId: null,
          quantity: -quantity,
          quantityBeforeValueBase: beforeValue,
          valueDeltaBase: `-${appliedValueBase}`,
          quantityAfterValueBase: row.after_value,
          averageCostAfterBase: row.after_avg,
          idempotencyKey,
        }),
      );

      return { appliedValueBase };
    });
  }

  async applyReceipt(
    productId: string,
    warehouseId: string,
    quantity: number,
    unitCostBase: string,
    idempotencyKey: string,
    manager?: EntityManager,
    businessDate?: string,
  ): Promise<void> {
    await this.run(manager, async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.lockKey(warehouseId, productId)]);

      const stateRepo = m.getRepository(InventoryValuationState);
      const state = await stateRepo.findOne({ where: { productId, warehouseId } });
      const beforeQty = state?.onHandQuantity ?? 0;
      const beforeValue = state?.totalValueBase ?? '0.0000';

      const [row]: Array<{ incoming_value: string; after_value: string; after_avg: string | null }> = await m.query(
        `SELECT
           ($1::numeric(20,4) * $2::int)::numeric(20,4) AS incoming_value,
           ($3::numeric(20,4) + $1::numeric(20,4) * $2::int)::numeric(20,4) AS after_value,
           CASE WHEN ($4::int + $2::int) > 0
             THEN (($3::numeric(20,4) + $1::numeric(20,4) * $2::int) / ($4::int + $2::int))::numeric(20,4)
             ELSE NULL
           END AS after_avg`,
        [unitCostBase, quantity, beforeValue, beforeQty],
      );
      const afterQty = beforeQty + quantity;

      if (state) {
        state.onHandQuantity = afterQty;
        state.totalValueBase = row.after_value;
        state.averageCostBase = row.after_avg;
        await stateRepo.save(state);
      } else {
        await stateRepo.save(
          stateRepo.create({
            productId,
            warehouseId,
            onHandQuantity: afterQty,
            totalValueBase: row.after_value,
            averageCostBase: row.after_avg,
            currencyCode: BASE_CURRENCY_PLACEHOLDER,
          }),
        );
      }

      await m.getRepository(InventoryValuationMovement).save(
        m.getRepository(InventoryValuationMovement).create({
          productId,
          warehouseId,
          kind: 'receipt',
          stockMovementId: null,
          quantity,
          quantityBeforeValueBase: beforeValue,
          valueDeltaBase: row.incoming_value,
          quantityAfterValueBase: row.after_value,
          averageCostAfterBase: row.after_avg,
          idempotencyKey,
          ...(businessDate ? { businessDate } : {}), // C2: the document's business date; otherwise the column default (processing date, UTC)
        }),
      );
    });
  }

  async applyTransfer(
    productId: string,
    fromWarehouseId: string,
    toWarehouseId: string,
    quantity: number,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<void | { rejected: 'negative_on_hand' }> {
    return this.run(manager, async (m) => {
      // sorted lock order — mirrors relocateReservedStock's own deadlock-avoidance pattern
      const keys = [this.lockKey(fromWarehouseId, productId), this.lockKey(toWarehouseId, productId)].sort();
      for (const key of keys) await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

      const stateRepo = m.getRepository(InventoryValuationState);
      const fromState = await stateRepo.findOne({ where: { productId, warehouseId: fromWarehouseId } });
      if (!fromState || fromState.averageCostBase == null || fromState.onHandQuantity < quantity) {
        return { rejected: 'negative_on_hand' as const }; // no mutation
      }

      const unitCost = fromState.averageCostBase;
      const [row]: Array<{ move_value: string; from_after_value: string }> = await m.query(
        `SELECT
           ($1::numeric(20,4) * $2::int)::numeric(20,4) AS move_value,
           ($3::numeric(20,4) - $1::numeric(20,4) * $2::int)::numeric(20,4) AS from_after_value`,
        [unitCost, quantity, fromState.totalValueBase],
      );
      const fromAfterQty = fromState.onHandQuantity - quantity;
      fromState.onHandQuantity = fromAfterQty;
      fromState.totalValueBase = row.from_after_value;
      fromState.averageCostBase = fromAfterQty > 0 ? unitCost : null;
      await stateRepo.save(fromState);

      const toState = await stateRepo.findOne({ where: { productId, warehouseId: toWarehouseId } });
      const toBeforeQty = toState?.onHandQuantity ?? 0;
      const toBeforeValue = toState?.totalValueBase ?? '0.0000';
      const [toRow]: Array<{ to_after_value: string; to_after_avg: string | null }> = await m.query(
        `SELECT
           ($1::numeric(20,4) + $2::numeric(20,4))::numeric(20,4) AS to_after_value,
           (($1::numeric(20,4) + $2::numeric(20,4)) / ($3::int + $4::int))::numeric(20,4) AS to_after_avg`,
        [toBeforeValue, row.move_value, toBeforeQty, quantity],
      );
      const toAfterQty = toBeforeQty + quantity;
      if (toState) {
        toState.onHandQuantity = toAfterQty;
        toState.totalValueBase = toRow.to_after_value;
        toState.averageCostBase = toRow.to_after_avg;
        await stateRepo.save(toState);
      } else {
        await stateRepo.save(
          stateRepo.create({
            productId,
            warehouseId: toWarehouseId,
            onHandQuantity: toAfterQty,
            totalValueBase: toRow.to_after_value,
            averageCostBase: toRow.to_after_avg,
            currencyCode: BASE_CURRENCY_PLACEHOLDER,
          }),
        );
      }

      const histRepo = m.getRepository(InventoryValuationMovement);
      await histRepo.save(
        histRepo.create({
          productId,
          warehouseId: fromWarehouseId,
          kind: 'transfer_out',
          stockMovementId: null,
          quantity: -quantity,
          quantityBeforeValueBase: fromState.totalValueBase,
          valueDeltaBase: `-${row.move_value}`,
          quantityAfterValueBase: row.from_after_value,
          averageCostAfterBase: fromState.averageCostBase,
          idempotencyKey: `${idempotencyKey}:out`,
        }),
      );
      await histRepo.save(
        histRepo.create({
          productId,
          warehouseId: toWarehouseId,
          kind: 'transfer_in',
          stockMovementId: null,
          quantity,
          quantityBeforeValueBase: toBeforeValue,
          valueDeltaBase: row.move_value,
          quantityAfterValueBase: toRow.to_after_value,
          averageCostAfterBase: toRow.to_after_avg,
          idempotencyKey: `${idempotencyKey}:in`,
        }),
      );
    });
  }

  async applyReversal(originalIdempotencyKey: string, reversalIdempotencyKey: string, manager?: EntityManager): Promise<void> {
    await this.run(manager, async (m) => {
      const histRepo = m.getRepository(InventoryValuationMovement);
      const original = await histRepo.findOne({ where: { idempotencyKey: originalIdempotencyKey } });
      if (!original) return; // nothing to reverse — disclosed, not invented

      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.lockKey(original.warehouseId, original.productId)]);

      const stateRepo = m.getRepository(InventoryValuationState);
      const state = await stateRepo.findOne({ where: { productId: original.productId, warehouseId: original.warehouseId } });
      const beforeQty = state?.onHandQuantity ?? 0;
      const beforeValue = state?.totalValueBase ?? '0.0000';

      // D14 — reapply the ORIGINAL recorded cost, inverted; never recalculate. Both the negation
      // and the resulting balance are computed in SQL NUMERIC (D16) — never JS string concatenation
      // of a signed numeric literal, which would produce invalid Postgres NUMERIC input syntax.
      const reverseQuantity = -original.quantity;
      const [row]: Array<{ reverse_value_delta: string; after_value: string }> = await m.query(
        `SELECT
           (-1 * $1::numeric(20,4))::numeric(20,4) AS reverse_value_delta,
           ($2::numeric(20,4) - $1::numeric(20,4))::numeric(20,4) AS after_value`,
        [original.valueDeltaBase, beforeValue],
      );
      const afterQty = beforeQty + reverseQuantity;
      const afterAvg = afterQty > 0 ? (state?.averageCostBase ?? null) : null;

      if (state) {
        state.onHandQuantity = afterQty;
        state.totalValueBase = row.after_value;
        state.averageCostBase = afterAvg;
        await stateRepo.save(state);
      } else {
        await stateRepo.save(
          stateRepo.create({
            productId: original.productId,
            warehouseId: original.warehouseId,
            onHandQuantity: afterQty,
            totalValueBase: row.after_value,
            averageCostBase: null,
            currencyCode: BASE_CURRENCY_PLACEHOLDER,
          }),
        );
      }

      await histRepo.save(
        histRepo.create({
          productId: original.productId,
          warehouseId: original.warehouseId,
          kind: 'reversal',
          stockMovementId: null,
          quantity: reverseQuantity,
          quantityBeforeValueBase: beforeValue,
          valueDeltaBase: row.reverse_value_delta,
          quantityAfterValueBase: row.after_value,
          averageCostAfterBase: afterAvg,
          idempotencyKey: reversalIdempotencyKey,
        }),
      );
    });
  }

  /** Read-only. `asOfDate` is accepted for `InventoryValuationContract` shape compatibility — the
   * running state IS always "as of now" (ADR-041 D23: no historical reconstruction in F08 V1). */
  /**
   * C1 (ADR-INV-08): a date that is today (UTC) or later - or no date - reads the running state exactly as before. A PAST date is rebuilt from the dated
   * history (`inventory_valuation_movements.businessDate <= asOf`), so a historical reconciliation no longer compares "now" with "then".
   */
  private isCurrentBasis(asOfDate?: string): boolean {
    if (!asOfDate) return true;
    return asOfDate >= new Date().toISOString().slice(0, 10);
  }

  async getValuedOnHandTotal(asOfDate?: string, manager?: EntityManager): Promise<Array<{ warehouseId: string; totalValueBase: string }>> {
    const source = manager ?? this.dataSource;
    if (this.isCurrentBasis(asOfDate)) {
      const rows: Array<{ warehouseId: string; totalValueBase: string }> = await source.query(
        `SELECT "warehouseId", COALESCE(SUM("totalValueBase"), 0)::numeric(20,4) AS "totalValueBase"
         FROM inventory_valuation_state GROUP BY "warehouseId"`,
      );
      return rows;
    }
    return source.query(
      `SELECT "warehouseId", COALESCE(SUM("valueDeltaBase"), 0)::numeric(20,4) AS "totalValueBase"
       FROM inventory_valuation_movements WHERE "businessDate" <= $1::date GROUP BY "warehouseId"`,
      [asOfDate],
    );
  }

  async getValuedPositions(asOfDate?: string, filter: ValuedPositionFilter = {}, manager?: EntityManager): Promise<ValuedPosition[]> {
    const source = manager ?? this.dataSource;
    const params: unknown[] = [];
    const conds: string[] = [];
    if (filter.warehouseIds) {
      params.push(filter.warehouseIds);
      conds.push(`"warehouseId" = ANY($${params.length}::uuid[])`);
    }
    if (filter.productId) {
      params.push(filter.productId);
      conds.push(`"productId" = $${params.length}::uuid`);
    }
    const extra = conds.length ? 'AND ' + conds.join(' AND ') : '';
    type Row = { warehouseId: string; productId: string; quantity: number | string; totalValueBase: string; averageCostBase: string | null };
    let rows: Row[];
    if (this.isCurrentBasis(asOfDate)) {
      rows = await source.query(
        `SELECT "warehouseId", "productId", "onHandQuantity" AS quantity, "totalValueBase"::numeric(20,4) AS "totalValueBase",
                CASE WHEN "onHandQuantity" > 0 THEN ("totalValueBase" / "onHandQuantity")::numeric(20,4) ELSE NULL END AS "averageCostBase"
         FROM inventory_valuation_state
         WHERE ("onHandQuantity" <> 0 OR "totalValueBase" <> 0) ${extra}
         ORDER BY "warehouseId", "productId"`,
        params,
      );
    } else {
      params.push(asOfDate);
      rows = await source.query(
        `SELECT "warehouseId", "productId", SUM(quantity)::int AS quantity, SUM("valueDeltaBase")::numeric(20,4) AS "totalValueBase",
                CASE WHEN SUM(quantity) > 0 THEN (SUM("valueDeltaBase") / SUM(quantity))::numeric(20,4) ELSE NULL END AS "averageCostBase"
         FROM inventory_valuation_movements
         WHERE "businessDate" <= $${params.length}::date ${extra}
         GROUP BY "warehouseId", "productId"
         HAVING SUM(quantity) <> 0 OR SUM("valueDeltaBase") <> 0
         ORDER BY "warehouseId", "productId"`,
        params,
      );
    }
    return rows.map((r) => ({ warehouseId: r.warehouseId, productId: r.productId, quantity: Number(r.quantity), totalValueBase: r.totalValueBase, averageCostBase: r.averageCostBase }));
  }

  async checkHistoryConsistency(manager?: EntityManager): Promise<HistoryInconsistency[]> {
    const source = manager ?? this.dataSource;
    type Row = { warehouseId: string; productId: string; stateQuantity: number | string; historyQuantity: number | string; stateValueBase: string; historyValueBase: string };
    const rows: Row[] = await source.query(
      `WITH h AS (
         SELECT "warehouseId", "productId", SUM(quantity)::int AS qty, SUM("valueDeltaBase")::numeric(20,4) AS val
         FROM inventory_valuation_movements GROUP BY 1, 2
       ), s AS (
         SELECT "warehouseId", "productId", "onHandQuantity" AS qty, "totalValueBase"::numeric(20,4) AS val FROM inventory_valuation_state
       )
       SELECT COALESCE(s."warehouseId", h."warehouseId") AS "warehouseId", COALESCE(s."productId", h."productId") AS "productId",
              COALESCE(s.qty, 0) AS "stateQuantity", COALESCE(h.qty, 0) AS "historyQuantity",
              COALESCE(s.val, 0)::numeric(20,4) AS "stateValueBase", COALESCE(h.val, 0)::numeric(20,4) AS "historyValueBase"
       FROM s FULL OUTER JOIN h ON h."warehouseId" = s."warehouseId" AND h."productId" = s."productId"
       WHERE COALESCE(s.qty, 0) <> COALESCE(h.qty, 0) OR COALESCE(s.val, 0) <> COALESCE(h.val, 0)
       ORDER BY 1, 2`,
    );
    return rows.map((r) => ({ ...r, stateQuantity: Number(r.stateQuantity), historyQuantity: Number(r.historyQuantity) }));
  }
}
