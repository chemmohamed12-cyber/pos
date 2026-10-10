'use strict';
// node --test tools/ops/f-inv-001-usage-collect.test.js — fake client only: no database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { collect, queries, PERIODS, READ_ONLY } = require('./f-inv-001-usage-collect');

function fakeClient({ readOnly = 'on' } = {}) {
  const log = [];
  return {
    log,
    async query(sql) {
      log.push(sql);
      if (/^SHOW transaction_read_only/i.test(sql)) return { rows: [{ transaction_read_only: readOnly }] };
      if (/count\(\*\)::int AS movements/.test(sql)) return { rows: [{ movements: 3, oldest: '2026-01-01', newest: '2026-10-01' }] };
      return { rows: [] };
    },
  };
}

test('every collected statement is a SELECT/SHOW and the work happens inside BEGIN READ ONLY … ROLLBACK', async () => {
  const c = fakeClient();
  const out = await collect(c, { operator: 'Test Operator', database: 'db1', host: 'h' });
  assert.equal(c.log[0], 'BEGIN READ ONLY');
  assert.equal(c.log[c.log.length - 1], 'ROLLBACK');
  for (const sql of c.log.slice(1, -1)) assert.match(sql, READ_ONLY, sql);
  assert.deepEqual(Object.keys(out.periods), PERIODS.map((p) => p.id));
  assert.ok(out.periods['all-history'].META && !out.periods['last-90-days'].META);
  assert.equal(out.serverReadOnly, 'on');
});

test('refuses to run when the session is not read-only, and still rolls back', async () => {
  const c = fakeClient({ readOnly: 'off' });
  await assert.rejects(() => collect(c, { operator: 'x', database: 'db', host: 'h' }), /not read-only/);
  assert.equal(c.log[c.log.length - 1], 'ROLLBACK');
});

test('no statement contains a data-changing keyword and the 90-day filter is the only variable fragment', () => {
  for (const p of PERIODS) for (const q of queries(p)) {
    assert.doesNotMatch(q.sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|COPY)\b/i, q.id);
    assert.match(q.sql, READ_ONLY, q.id);
  }
  assert.match(queries(PERIODS[1])[0].sql, /interval '90 days'/);
  assert.doesNotMatch(queries(PERIODS[0])[0].sql, /interval/);
});
