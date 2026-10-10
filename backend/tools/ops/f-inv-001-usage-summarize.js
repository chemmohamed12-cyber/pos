'use strict';
/**
 * F-INV-001 / D-02 — summarises the JSON files returned by authorised operators (tools/ops/f-inv-001-usage-collect.js) into the release decision table of
 * docs/decisions/test-03/F-INV-001-OPERATOR-EXECUTION-GUIDE-2026-10-11.md §3-§4. It only READS the result files.
 *   node tools/ops/f-inv-001-usage-summarize.js result-*.json  [> summary.md]
 * The output is evidence for a human decision; it never states that the 410 change is safe to release — absence of rows in the queried databases does not prove the absence of external
 * integrations (request logs are needed for that), and every missing database/period is listed as a gap.
 */
const fs = require('fs');
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node tools/ops/f-inv-001-usage-summarize.js result-*.json'); process.exit(2); }
const rows = []; const gaps = [];
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const period of ['all-history', 'last-90-days']) {
    const p = r.periods?.[period]; if (!p) { gaps.push(`${r.database}: period ${period} missing`); continue; }
    const q1 = (p.Q1 || []).filter((x) => x.movementType !== 'receipt'); const q2 = p.Q2 || []; const q3 = p.Q3 || []; const q4 = p.Q4 || [];
    rows.push({ database: r.database, operator: r.operator, at: r.collectedAtUtc, period, nonReceiptMovements: q1.reduce((s, x) => s + Number(x.n), 0), types: q1.map((x) => `${x.movementType}:${x.n}`).join(', ') || '-', lastUse: q1.map((x) => x.last_use).sort().pop() || '-', actors: [...new Set(q2.map((x) => x.createdByUserId))].length, auditActions: q3.reduce((s, x) => s + Number(x.n), 0), negativeStockPairs: q4.length, oldestMovement: period === 'all-history' ? p.META?.[0]?.oldest ?? '-' : '' });
  }
}
console.log('| Database | Period | Non-receipt HTTP-origin movements | Types | Last use | Distinct actors | Non-receipt audit actions | Negative-stock pairs | Oldest movement in DB | Collected (UTC) by |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const x of rows) console.log(`| ${x.database} | ${x.period} | ${x.nonReceiptMovements} | ${x.types} | ${x.lastUse} | ${x.actors} | ${x.auditActions} | ${x.negativeStockPairs} | ${x.oldestMovement} | ${x.at} / ${x.operator} |`);
const live = rows.filter((x) => x.period === 'last-90-days' && x.nonReceiptMovements > 0); const historic = rows.filter((x) => x.period === 'all-history' && x.nonReceiptMovements > 0);
console.log('');
console.log(live.length ? `**LIVE CONSUMER SIGNAL** in ${live.length} database(s) within the last 90 days — do NOT release the 410 change; identify the actors (Q2) first.` : historic.length ? `Historical use only in ${historic.length} database(s), none in the last 90 days — identify and confirm the consumer is retired before accepting risk.` : 'No non-receipt HTTP-origin movements in the returned databases/periods.');
console.log('Limitation: this does not cover external integrations whose calls were rejected or never produced rows, nor databases that were not returned.');
if (gaps.length) console.log('Gaps: ' + gaps.join('; '));
