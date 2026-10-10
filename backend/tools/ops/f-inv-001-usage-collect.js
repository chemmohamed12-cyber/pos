'use strict';
/**
 * F-INV-001 / D-02 — READ-ONLY usage collector for an AUTHORISED OPERATOR. Runs the documented queries Q1–Q4
 * (docs/decisions/test-program/F-INV-001-USAGE-MEASUREMENT-QUERIES-2026-10-10.md) against ONE Company database, twice: all history and the last 90 days, and writes a JSON result file.
 *
 *   OPERATOR="Name Surname" PGHOST=… PGPORT=… PGUSER=<read-only role> PGPASSWORD=<from your own secret store> \
 *   node tools/ops/f-inv-001-usage-collect.js --database <company database name> --out result-<db>.json
 *
 * Guarantees: every statement is a SELECT/SHOW inside `BEGIN READ ONLY` (the server refuses writes), and the script checks that before running; the password is read from the environment only and is never
 * printed or written; no row contents are returned beyond counts, movement types, dates and actor ids. This repository's agent has NOT run it against any real database (no authorisation); it is
 * verified on a fake client by tools/ops/f-inv-001-usage-collect.test.js.
 */
const fs = require('fs');

const PERIODS = [
  { id: 'all-history', where: '' },
  { id: 'last-90-days', where: ` AND "createdAt" >= now() - interval '90 days'` },
];
// $1 placeholders are not needed: the only variable part is the fixed period fragment above (no operator input is interpolated).
const queries = (p) => [
  { id: 'Q1', sql: `SELECT "movementType", count(*)::int AS n, min("createdAt") AS first_use, max("createdAt") AS last_use, count(*) FILTER (WHERE quantity < 0)::int AS negative_rows FROM stock_movements WHERE "referenceType" IS NULL AND "referenceId" IS NULL${p.where} GROUP BY 1 ORDER BY 1` },
  { id: 'Q2', sql: `SELECT "movementType", "createdByUserId", count(*)::int AS n, max("createdAt") AS last_use FROM stock_movements WHERE "referenceType" IS NULL AND "referenceId" IS NULL AND "movementType" <> 'receipt'${p.where} GROUP BY 1, 2 ORDER BY n DESC` },
  { id: 'Q3', sql: `SELECT action, count(*)::int AS n, min("timestamp") AS first_use, max("timestamp") AS last_use FROM audit_records WHERE action LIKE 'inventory.movement.%' AND action <> 'inventory.movement.receipt'${p.where.replace('"createdAt"', '"timestamp"')} GROUP BY 1 ORDER BY 1` },
  { id: 'Q4', sql: `SELECT "warehouseId", "productId", sum(quantity)::int AS on_hand FROM stock_movements GROUP BY 1, 2 HAVING sum(quantity) < 0` },
  { id: 'META', sql: `SELECT count(*)::int AS movements, min("createdAt") AS oldest, max("createdAt") AS newest FROM stock_movements` },
];
const READ_ONLY = /^\s*(SELECT|SHOW)\b/i;

async function collect(client, meta) {
  const out = { tool: 'f-inv-001-usage-collect', version: 1, operator: meta.operator, database: meta.database, host: meta.host, collectedAtUtc: new Date().toISOString(), periods: {} };
  await client.query('BEGIN READ ONLY');
  try {
    out.serverReadOnly = (await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only;
    if (out.serverReadOnly !== 'on') throw new Error('REFUSED: the session is not read-only');
    for (const p of PERIODS) {
      out.periods[p.id] = {};
      for (const q of queries(p)) {
        if (!READ_ONLY.test(q.sql)) throw new Error(`REFUSED: ${q.id} is not a SELECT`);
        if (q.id === 'META' && p.id !== 'all-history') continue;
        out.periods[p.id][q.id] = (await client.query(q.sql)).rows;
      }
    }
  } finally {
    await client.query('ROLLBACK');
  }
  return out;
}

module.exports = { collect, queries, PERIODS, READ_ONLY };

if (require.main === module) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const database = arg('--database'); const outFile = arg('--out'); const operator = process.env.OPERATOR;
  if (!database || !outFile || !operator || !process.env.PGPASSWORD) { console.error('usage: OPERATOR=… PGHOST=… PGPORT=… PGUSER=… PGPASSWORD=… node tools/ops/f-inv-001-usage-collect.js --database <name> --out <file.json>'); process.exit(2); }
  const { Client } = require('pg');
  (async () => {
    const client = new Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER, password: process.env.PGPASSWORD, database });
    await client.connect();
    try {
      const result = await collect(client, { operator, database, host: process.env.PGHOST });
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
      console.log(`written ${outFile} (database ${database}, periods ${Object.keys(result.periods).join(', ')})`);
    } finally { await client.end(); }
  })().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
