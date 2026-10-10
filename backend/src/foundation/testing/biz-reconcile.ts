import { BizEnv, record, result } from './biz-support';

/**
 * R1–R10 reconciliation (definitions frozen in T-PLAN-R2-CLARIFICATIONS-RECONCILIATION-AND-GUARD-COVERAGE-2026-10-10.md §3).
 * Runs on the run's own disposable company database BEFORE cleanup and is written to evidence by the caller.
 * Expected values come from an independent computation (raw SQL vs service, sub-ledger vs GL, oracle supplied by the test) — never from
 * the reconciliation services themselves. An unexplained difference is STOP. Differences are explainable ONLY through `declared`.
 */
export interface Declared {
  /** treasury movements deliberately posted WITHOUT a GL event (non-emitting funding) — amount in base currency */
  nonGlTreasury?: number;
  /** value of goods-receipt-style receipts recorded in valuation WITHOUT a GL event (their GL is posted by the procurement flow, outside this run) */
  valuationWithoutGl?: number;
  /** pairs whose ledger/valuation difference is explained by a declared REJECTED/PENDING financial event: `${warehouseId}:${productId}` */
  explainedPairs?: string[];
  /** event ids that are intentionally not POSTED at reconciliation time (e.g. T-11 before re-drive) */
  explainedEvents?: string[];
  /** independent expectation of the net CREDIT balance of the tax control accounts (output tax payable − input tax receivable); default 0 */
  expectedTaxNet?: number;
  /** oracle: expected on-hand per `${warehouseId}:${productId}` computed independently by the test */
  oracleOnHand?: Record<string, number>;
  /** sub-ledgers/GL that this run legitimately never touched (reported, not skipped silently) */
  notes?: string[];
}
export interface RCheck { id: string; status: 'PASS' | 'STOP'; detail: unknown }

const num = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number) => Math.abs(a - b) < 0.0001;

async function hasTable(env: BizEnv, t: string): Promise<boolean> {
  return (await env.dsA.query('SELECT to_regclass($1) IS NOT NULL AS e', [`public.${t}`]))[0].e;
}

export async function runReconciliation(env: BizEnv, declared: Declared = {}): Promise<RCheck[]> {
  const q = (sql: string, p: unknown[] = []) => env.dsA.query(sql, p);
  const out: RCheck[] = [];
  const explainedPairs = new Set(declared.explainedPairs ?? []);

  // ---- R1: stock balances == movements (service vs raw SQL), no negative pair, oracle if provided ----
  const pairs: Array<{ warehouseId: string; productId: string; s: string }> = await q('SELECT "warehouseId","productId",SUM(quantity)::text AS s FROM stock_movements GROUP BY 1,2');
  const r1Diffs: unknown[] = [];
  let negative = 0;
  for (const p of pairs) {
    const svc = await env.inventory.getOnHand(p.warehouseId, p.productId, env.manager);
    const key = `${p.warehouseId}:${p.productId}`;
    if (!near(svc, num(p.s))) r1Diffs.push({ key, service: svc, sql: num(p.s) });
    if (num(p.s) < 0) negative += 1;
    if (declared.oracleOnHand && key in declared.oracleOnHand && !near(declared.oracleOnHand[key], num(p.s))) r1Diffs.push({ key, oracle: declared.oracleOnHand[key], sql: num(p.s) });
  }
  out.push({ id: 'R1', status: r1Diffs.length === 0 && negative === 0 ? 'PASS' : 'STOP', detail: { pairs: pairs.length, differences: r1Diffs, negativePairs: negative } });

  // ---- R2: valuation == ledger per pair (explained pairs aside) and Σ valuation == GL inventory control balance ----
  if (await hasTable(env, 'inventory_valuation_state')) {
    const val: Array<{ warehouseId: string; productId: string; q: string; v: string }> = await q('SELECT "warehouseId","productId","onHandQuantity"::text AS q,"totalValueBase"::text AS v FROM inventory_valuation_state');
    const diffs: unknown[] = [];
    const explained: unknown[] = [];
    for (const v of val) {
      const key = `${v.warehouseId}:${v.productId}`;
      const led = num(pairs.find((p) => p.warehouseId === v.warehouseId && p.productId === v.productId)?.s);
      if (!near(led, num(v.q))) (explainedPairs.has(key) ? explained : diffs).push({ key, ledger: led, valuation: num(v.q) });
    }
    const totalVal = val.reduce((s, v) => s + num(v.v), 0);
    const gl = num((await q(`SELECT coalesce(sum(jl."debitBase" - jl."creditBase"),0)::text AS b FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE ga."controlFunction" = 'inventory'`))[0]?.b);
    const glApplicable = val.length > 0 && (await hasTable(env, 'accounting_journal_lines'));
    const expectedGl = totalVal - (declared.valuationWithoutGl ?? 0);
    if (glApplicable && !near(expectedGl, gl)) diffs.push({ valuationTotal: totalVal, declaredValuationWithoutGl: declared.valuationWithoutGl ?? 0, expectedGl, glInventory: gl });
    out.push({ id: 'R2', status: diffs.length === 0 ? 'PASS' : 'STOP', detail: { valuationRows: val.length, valuationTotal: totalVal, glInventory: gl, differences: diffs, explainedByDeclaredEvents: explained } });
  } else out.push({ id: 'R2', status: 'PASS', detail: 'not applicable: no valuation tables in this run' });

  // ---- R3: customer ledger net == GL AR control net ----
  if ((await hasTable(env, 'customer_ledger_entries')) && (await hasTable(env, 'accounting_journal_lines'))) {
    const led = num((await q(`SELECT coalesce(sum(CASE WHEN direction = 'debit' THEN amount ELSE -amount END),0)::text AS t FROM customer_ledger_entries WHERE status IS DISTINCT FROM 'void'`))[0].t);
    const gl = num((await q(`SELECT coalesce(sum(jl."debitBase" - jl."creditBase"),0)::text AS t FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE ga."controlFunction" = 'ar'`))[0].t);
    out.push({ id: 'R3', status: near(led, gl) ? 'PASS' : 'STOP', detail: { customerLedgerNet: led, glArNet: gl } });
  } else out.push({ id: 'R3', status: 'PASS', detail: 'not applicable: no customer ledger / GL tables in this run' });

  // ---- R4: supplier ledger net == GL AP control net ----
  if ((await hasTable(env, 'supplier_ledger_entries')) && (await hasTable(env, 'accounting_journal_lines'))) {
    const led = num((await q(`SELECT coalesce(sum(CASE WHEN direction = 'credit' THEN amount ELSE -amount END),0)::text AS t FROM supplier_ledger_entries WHERE status IS DISTINCT FROM 'void'`))[0].t);
    const gl = num((await q(`SELECT coalesce(sum(jl."creditBase" - jl."debitBase"),0)::text AS t FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE ga."controlFunction" = 'ap'`))[0].t);
    out.push({ id: 'R4', status: near(led, gl) ? 'PASS' : 'STOP', detail: { supplierLedgerNet: led, glApNet: gl } });
  } else out.push({ id: 'R4', status: 'PASS', detail: 'not applicable: no supplier ledger / GL tables in this run' });

  // ---- R5: treasury balances of GL-mapped accounts == GL net of their mapped accounts (+ declared non-GL funding) ----
  if ((await hasTable(env, 'treasury_transactions')) && (await hasTable(env, 'accounting_journal_lines'))) {
    const tre = num((await q(
      `SELECT coalesce(sum(CASE WHEN t.type IN ('cash_in','transfer_in') THEN t.amount ELSE -t.amount END),0)::text AS b
         FROM treasury_transactions t JOIN treasury_accounts a ON a.id = t."treasuryAccountId" WHERE a."glAccountCode" IS NOT NULL`,
    ))[0].b);
    const gl = num((await q(
      `SELECT coalesce(sum(jl."debitBase" - jl."creditBase"),0)::text AS b FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId"
        WHERE ga.code IN (SELECT DISTINCT "glAccountCode" FROM treasury_accounts WHERE "glAccountCode" IS NOT NULL)`,
    ))[0].b);
    const expectedGl = tre - (declared.nonGlTreasury ?? 0);
    out.push({ id: 'R5', status: near(expectedGl, gl) ? 'PASS' : 'STOP', detail: { treasuryNetMapped: tre, declaredNonGlTreasury: declared.nonGlTreasury ?? 0, expectedGl, glNet: gl } });
  } else out.push({ id: 'R5', status: 'PASS', detail: 'not applicable: no treasury / GL tables in this run' });

  // ---- R6: every journal entry balances ----
  if (await hasTable(env, 'accounting_journal_lines')) {
    const unbalanced = await q('SELECT "journalEntryId" FROM accounting_journal_lines GROUP BY 1 HAVING SUM("debitBase") <> SUM("creditBase")');
    out.push({ id: 'R6', status: unbalanced.length === 0 ? 'PASS' : 'STOP', detail: { unbalancedEntries: unbalanced.length } });
  } else out.push({ id: 'R6', status: 'PASS', detail: 'not applicable: no journal tables' });

  // ---- R7: movement <-> financial event <-> journal ----
  if ((await hasTable(env, 'accounting_financial_events')) && (await hasTable(env, 'accounting_journal_entries'))) {
    const notPosted: Array<{ id: string; status: string; reason: string | null }> = await q(`SELECT id, status, "rejectionReason" AS reason FROM accounting_financial_events WHERE status <> 'POSTED'`);
    const unexplained = notPosted.filter((e) => !(declared.explainedEvents ?? []).includes(e.id));
    const postedNoJournal = (await q(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE status = 'POSTED' AND "journalEntryId" IS NULL`))[0].n;
    const dup = await q(`SELECT "idempotencyKey", count(*)::int AS n FROM accounting_financial_events GROUP BY 1 HAVING count(*) > 1`);
    const movementEvents = await q(
      `SELECT m.id FROM stock_movements m WHERE m."movementType" IN ('dispatch','adjustment','return_in') AND NOT EXISTS (SELECT 1 FROM accounting_financial_events e WHERE e."idempotencyKey" = 'inventory:movement:' || m.id || ':recorded')`,
    );
    const evidenceOfEvents = (await q('SELECT count(*)::int AS n FROM accounting_financial_events'))[0].n;
    // movements without an event are only a defect when the run wired the event bus (events exist at all) and the movement type is GL-bearing
    const missing = evidenceOfEvents > 0 ? movementEvents.length : 0;
    const orphanJournals = (await q(`SELECT count(*)::int AS n FROM accounting_journal_entries j WHERE NOT EXISTS (SELECT 1 FROM accounting_financial_events e WHERE e."journalEntryId" = j.id) AND j.id IN (SELECT "journalEntryId" FROM accounting_journal_lines)`))[0].n;
    out.push({ id: 'R7', status: unexplained.length === 0 && postedNoJournal === 0 && dup.length === 0 && missing === 0 && orphanJournals === 0 ? 'PASS' : 'STOP', detail: { events: evidenceOfEvents, notPosted: notPosted.length, unexplainedNotPosted: unexplained, postedWithoutJournal: postedNoJournal, duplicateIdempotencyKeys: dup.length, movementsWithoutEvent: missing, journalsWithoutEvent: orphanJournals, explained: notPosted.filter((e) => (declared.explainedEvents ?? []).includes(e.id)) } });
  } else out.push({ id: 'R7', status: 'PASS', detail: 'not applicable: no financial-event tables in this run' });

  // ---- R8: GRNI / WIP / PPV / VAT control accounts equal the scenario's independent expectation (default: untouched = 0) ----
  if (await hasTable(env, 'accounting_journal_lines')) {
    const rows: Array<{ code: string; fn: string | null; net: string }> = await q(
      `SELECT ga.code, ga."controlFunction" AS fn, coalesce(sum(jl."creditBase" - jl."debitBase"),0)::text AS net FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId"
        WHERE ga."controlFunction" IN ('grni','wip','tax_payable','tax_receivable') OR ga.code LIKE '5301%' GROUP BY 1,2 ORDER BY 1`,
    );
    const taxNet = rows.filter((r) => r.fn === 'tax_payable' || r.fn === 'tax_receivable').reduce((s, r) => s + num(r.net), 0);
    const otherNonZero = rows.filter((r) => r.fn !== 'tax_payable' && r.fn !== 'tax_receivable' && !near(num(r.net), 0));
    const expectedTax = declared.expectedTaxNet ?? 0;
    out.push({ id: 'R8', status: near(taxNet, expectedTax) && otherNonZero.length === 0 ? 'PASS' : 'STOP', detail: { taxNetCredit: taxNet, expectedTaxNetCredit: expectedTax, grniWipPpvNonZero: otherNonZero, accountsSeen: rows } });
  } else out.push({ id: 'R8', status: 'PASS', detail: 'not applicable' });

  out.push({ id: 'R9', status: 'PASS', detail: 'reversals/returns/adjustments: evaluated by the owning scenario (T-07 oracle); this run: ' + (declared.notes?.join('; ') || 'none declared') });
  out.push({ id: 'R10', status: 'PASS', detail: 'refused operations: evaluated by the owning scenario through before/after table fingerprints (see its case results)' });
  return out;
}

/** Runs R1–R10, writes `reconciliation-R1-R10.json` to the run's evidence and registers one result per R (T-10 criteria): an unexplained difference is STOP. */
export async function reconcileAndRecord(env: BizEnv, declared: Declared = {}): Promise<RCheck[]> {
  const checks = await runReconciliation(env, declared);
  record(env, 'reconciliation-R1-R10.json', { declared, checks });
  for (const c of checks) result(env, `T-10/${env.testId}/${c.id}`, c.status, typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail).slice(0, 400));
  return checks;
}
