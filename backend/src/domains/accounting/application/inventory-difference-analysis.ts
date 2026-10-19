import { EntityManager } from 'typeorm';

/**
 * Slice C1 (ADR-INV-09, CTO decisions 2026-10-17) - READ-ONLY attribution of the difference between the valued inventory and the posted balance of the
 * `inventory` control account. Every figure is a PostgreSQL NUMERIC aggregation over accounting-owned tables (journal lines/entries, financial events) and
 * the shared event outbox - never over another module's tables and never a write.
 *
 * Identity used (D = valuation - GL, as of a business date):
 *   D = rounding + unposted_value - f07_gl - manual_gl + unexplained
 * where
 *  - rounding       the part of each posted event line that the base-currency scale rounded away: the valuation carries the 4-decimal transaction amount,
 *                   the journal the rounded base amount (Gate A measurement: 9.7778 -> 9.78). Computed EXACTLY from the line itself (transaction minus base,
 *                   debit side positive); only lines whose transaction currency is the functional currency take part (a foreign-currency line stays
 *                   unexplained rather than being guessed). NO TOLERANCE is applied anywhere;
 *  - unposted_value valuation that was applied when the movement happened but whose journal does not exist yet: events REJECTED / RECEIVED / MAPPED and
 *                   outbox rows not yet dispatched, for the kinds whose valuation is bootstrapped at movement time (opening stock, manual receipt, return-in,
 *                   goods receipt). Dispatch/adjustment events apply valuation and journal in one transaction, so they never create this difference;
 *  - f07_gl         the inventory-account effect of approved F07 entries (which post to the GL only - no valuation effect until slice C6);
 *  - manual_gl      the inventory-account effect of manual / opening journals (blocked by policy on a control account, reported if one exists);
 *  - unexplained    whatever remains. Only a non-zero remainder is an alarm.
 */
export interface DifferenceCategory {
  code: 'rounding' | 'unposted_value' | 'f07_without_valuation_effect' | 'manual_or_opening_journals';
  /** Contribution to (valuation - GL), signed. */
  amountBase: string;
  count: number;
  note: string;
}

export interface UnpostedItem {
  source: 'financial_event' | 'outbox';
  id: string;
  status: string;
  kind: string | null;
  reason: string | null;
  warehouseId: string | null;
  productId: string | null;
  referenceType: string | null;
  referenceId: string | null;
  businessDate: string | null;
  amountBase: string | null;
}

export interface DifferenceAnalysis {
  categories: DifferenceCategory[];
  explainedBase: string;
  roundingByWarehouse: Array<{ warehouseId: string | null; amountBase: string; postings: number }>;
  unpostedItems: UnpostedItem[];
  f07Entries: Array<{ journalEntryId: string; businessDate: string; inventoryEffectBase: string; financialEventId: string | null }>;
  /** Dispatch/adjustment events that were REJECTED: the stock moved but neither valuation nor GL did (no effect on this difference; shown for completeness). */
  rejectedWithoutValueEffect: number;
}

const F07_EVENT = 'accounting.inventory.adjustment.approved';
const INVENTORY_EVENTS_WITH_MOVEMENT_TIME_VALUATION = `(
  (fe."eventType" = 'inventory.movement.recorded' AND fe.payload->>'glKind' IN ('opening_stock','manual_receipt','return_in'))
  OR fe."eventType" = 'procurement.goods_receipt.posted'
)`;

export async function analyzeInventoryDifference(
  manager: EntityManager,
  postedEntryFilter: string,
  inventoryAccountId: string,
  asOfDate: string,
): Promise<DifferenceAnalysis> {
  // ---- posted lines on the inventory account, classified by origin ----
  const [lines] = (await manager.query(
    `WITH inv AS (
       SELECT l."debitTransaction" AS dt, l."creditTransaction" AS ct, l."debitBase" AS db, l."creditBase" AS cb,
              e."sourceType" AS st, e."transactionCurrencyCode" AS tcur, e."functionalCurrencyCode" AS fcur,
              CASE WHEN fe."eventType" = '${F07_EVENT}' AND fe.payload->>'valuationEffect' = 'true' THEN 'f07_with_valuation_effect' ELSE COALESCE(fe."eventType", ofe."eventType") END AS event_type
         FROM accounting_journal_lines l
         JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
         LEFT JOIN accounting_financial_events fe ON fe.id = e."financialEventId"
         LEFT JOIN accounting_journal_entries o ON o.id = e."reversalOfEntryId"
         LEFT JOIN accounting_financial_events ofe ON ofe.id = o."financialEventId"
        WHERE l."accountId" = $1 AND ${postedEntryFilter} AND e."businessDate" <= $2::date
     )
     SELECT
       COALESCE(SUM(CASE WHEN event_type IS NOT NULL AND event_type <> '${F07_EVENT}' AND tcur = fcur THEN (dt - db) - (ct - cb) ELSE 0 END), 0)::numeric(20,4) AS rounding,
       COUNT(CASE WHEN event_type IS NOT NULL AND event_type <> '${F07_EVENT}' AND tcur = fcur AND ((dt - db) - (ct - cb)) <> 0 THEN 1 END)::int AS rounding_n,
       COALESCE(SUM(CASE WHEN event_type = '${F07_EVENT}' THEN db - cb ELSE 0 END), 0)::numeric(20,4) AS f07_gl,
       COUNT(CASE WHEN event_type = '${F07_EVENT}' THEN 1 END)::int AS f07_n,
       COALESCE(SUM(CASE WHEN event_type IS NULL THEN db - cb ELSE 0 END), 0)::numeric(20,4) AS manual_gl,
       COUNT(CASE WHEN event_type IS NULL THEN 1 END)::int AS manual_n
     FROM inv`,
    [inventoryAccountId, asOfDate],
  )) as Array<{ rounding: string; rounding_n: number; f07_gl: string; f07_n: number; manual_gl: string; manual_n: number }>;

  // ---- rounding by warehouse (event payload carries the warehouse) ----
  const roundingByWarehouse = (await manager.query(
    `SELECT COALESCE(fe.payload->>'warehouseId', ofe.payload->>'warehouseId') AS "warehouseId",
            SUM((l."debitTransaction" - l."debitBase") - (l."creditTransaction" - l."creditBase"))::numeric(20,4) AS "amountBase",
            COUNT(*)::int AS postings
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
       LEFT JOIN accounting_financial_events fe ON fe.id = e."financialEventId"
       LEFT JOIN accounting_journal_entries o ON o.id = e."reversalOfEntryId"
       LEFT JOIN accounting_financial_events ofe ON ofe.id = o."financialEventId"
      WHERE l."accountId" = $1 AND ${postedEntryFilter} AND e."businessDate" <= $2::date
        AND COALESCE(fe."eventType", ofe."eventType") IS NOT NULL AND COALESCE(fe."eventType", ofe."eventType") <> '${F07_EVENT}'
        AND e."transactionCurrencyCode" = e."functionalCurrencyCode"
        AND ((l."debitTransaction" - l."debitBase") - (l."creditTransaction" - l."creditBase")) <> 0
      GROUP BY 1 ORDER BY 1`,
    [inventoryAccountId, asOfDate],
  )) as Array<{ warehouseId: string | null; amountBase: string; postings: number }>;

  // ---- valuation applied at movement time whose journal does not exist yet ----
  const [unposted] = (await manager.query(
    `SELECT
       (SELECT COALESCE(SUM(CASE WHEN fe."eventType" = 'inventory.movement.recorded' THEN (fe.payload->>'totalCostBase')::numeric ELSE (fe.payload->>'totalValueBase')::numeric END), 0)
          FROM accounting_financial_events fe
         WHERE fe.status IN ('REJECTED','RECEIVED','MAPPED') AND fe."businessDate" <= $1::date AND ${INVENTORY_EVENTS_WITH_MOVEMENT_TIME_VALUATION}) AS ev_value,
       (SELECT COUNT(*)::int FROM accounting_financial_events fe
         WHERE fe.status IN ('REJECTED','RECEIVED','MAPPED') AND fe."businessDate" <= $1::date AND ${INVENTORY_EVENTS_WITH_MOVEMENT_TIME_VALUATION}) AS ev_n,
       (SELECT COALESCE(SUM(CASE WHEN o.topic = 'inventory.movement.recorded' THEN (o.payload->>'totalCostBase')::numeric ELSE (o.payload->>'totalValueBase')::numeric END), 0)
          FROM event_outbox o
         WHERE o.status IN ('pending','processing','failed')
           AND ((o.topic = 'inventory.movement.recorded' AND o.payload->>'glKind' IN ('opening_stock','manual_receipt','return_in')) OR o.topic = 'procurement.goods_receipt.posted')
           AND (o.payload->>'businessDate')::date <= $1::date) AS ob_value,
       (SELECT COUNT(*)::int FROM event_outbox o
         WHERE o.status IN ('pending','processing','failed')
           AND ((o.topic = 'inventory.movement.recorded' AND o.payload->>'glKind' IN ('opening_stock','manual_receipt','return_in')) OR o.topic = 'procurement.goods_receipt.posted')
           AND (o.payload->>'businessDate')::date <= $1::date) AS ob_n`,
    [asOfDate],
  )) as Array<{ ev_value: string; ev_n: number; ob_value: string; ob_n: number }>;

  const unpostedItems = (await manager.query(
    `SELECT 'financial_event' AS source, fe.id::text AS id, fe.status AS status,
            COALESCE(fe.payload->>'glKind', fe."eventType") AS kind, fe."rejectionReason" AS reason,
            fe.payload->>'warehouseId' AS "warehouseId", fe.payload->>'productId' AS "productId",
            fe.payload->>'referenceType' AS "referenceType", fe.payload->>'referenceId' AS "referenceId",
            fe."businessDate"::text AS "businessDate",
            CASE WHEN fe."eventType" = 'inventory.movement.recorded' THEN fe.payload->>'totalCostBase' ELSE fe.payload->>'totalValueBase' END AS "amountBase"
       FROM accounting_financial_events fe
      WHERE fe.status IN ('REJECTED','RECEIVED','MAPPED') AND fe."businessDate" <= $1::date AND ${INVENTORY_EVENTS_WITH_MOVEMENT_TIME_VALUATION}
     UNION ALL
     SELECT 'outbox', o.id::text, o.status, COALESCE(o.payload->>'glKind', o.topic), NULL,
            o.payload->>'warehouseId', o.payload->>'productId', o.payload->>'referenceType', o.payload->>'referenceId',
            o.payload->>'businessDate',
            CASE WHEN o.topic = 'inventory.movement.recorded' THEN o.payload->>'totalCostBase' ELSE o.payload->>'totalValueBase' END
       FROM event_outbox o
      WHERE o.status IN ('pending','processing','failed')
        AND ((o.topic = 'inventory.movement.recorded' AND o.payload->>'glKind' IN ('opening_stock','manual_receipt','return_in')) OR o.topic = 'procurement.goods_receipt.posted')
        AND (o.payload->>'businessDate')::date <= $1::date
      ORDER BY 1, 10 DESC
      LIMIT 200`,
    [asOfDate],
  )) as UnpostedItem[];

  const f07Entries = (await manager.query(
    `SELECT e.id AS "journalEntryId", e."businessDate"::text AS "businessDate",
            SUM(l."debitBase" - l."creditBase")::numeric(20,4) AS "inventoryEffectBase", e."financialEventId"
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
       JOIN accounting_financial_events fe ON fe.id = e."financialEventId"
      WHERE l."accountId" = $1 AND ${postedEntryFilter} AND e."businessDate" <= $2::date AND fe."eventType" = '${F07_EVENT}' AND COALESCE(fe.payload->>'valuationEffect', 'false') <> 'true'
      GROUP BY e.id, e."businessDate", e."financialEventId" ORDER BY e."businessDate" DESC LIMIT 200`,
    [inventoryAccountId, asOfDate],
  )) as DifferenceAnalysis['f07Entries'];

  const [rejectedOther] = (await manager.query(
    `SELECT COUNT(*)::int AS n FROM accounting_financial_events fe
      WHERE fe.status = 'REJECTED' AND fe."businessDate" <= $1::date AND fe."eventType" = 'inventory.movement.recorded'
        AND COALESCE(fe.payload->>'glKind', 'dispatch') IN ('dispatch','adjustment')`,
    [asOfDate],
  )) as Array<{ n: number }>;

  // ---- contributions to (valuation - GL) and the explained total, in NUMERIC ----
  const [sums] = (await manager.query(
    `SELECT ($1::numeric + $2::numeric)::numeric(20,4) AS unposted_value,
            (-1 * $3::numeric)::numeric(20,4) AS f07_effect,
            (-1 * $4::numeric)::numeric(20,4) AS manual_effect,
            ($5::numeric + ($1::numeric + $2::numeric) - $3::numeric - $4::numeric)::numeric(20,4) AS explained`,
    [unposted.ev_value, unposted.ob_value, lines.f07_gl, lines.manual_gl, lines.rounding],
  )) as Array<{ unposted_value: string; f07_effect: string; manual_effect: string; explained: string }>;

  return {
    categories: [
      { code: 'rounding', amountBase: lines.rounding, count: lines.rounding_n, note: 'The base-currency scale rounded away part of the 4-decimal transaction amount the valuation carries (exact, line by line; no tolerance).' },
      { code: 'unposted_value', amountBase: sums.unposted_value, count: unposted.ev_n + unposted.ob_n, note: 'Valuation applied at movement time whose journal is not posted yet: events REJECTED/RECEIVED/MAPPED and outbox rows not dispatched.' },
      { code: 'f07_without_valuation_effect', amountBase: sums.f07_effect, count: lines.f07_n, note: 'Approved F07 inventory adjustments approved BEFORE slice C6 (or submitted with the valuation flag off) post to the GL only; the valuation is not changed by them. Entries submitted with a valuation effect are excluded: they move both sides.' },
      { code: 'manual_or_opening_journals', amountBase: sums.manual_effect, count: lines.manual_n, note: 'Manual/opening journal lines on the inventory control account (blocked by policy; reported if present).' },
    ],
    explainedBase: sums.explained,
    roundingByWarehouse,
    unpostedItems,
    f07Entries,
    rejectedWithoutValueEffect: rejectedOther.n,
  };
}
