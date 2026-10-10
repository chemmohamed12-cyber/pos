'use strict';
// node --test tools/testing/biz-evidence.test.js — writes only under backend/docs/decisions/evidence-2026-10-10-biz/_selftest (removed afterwards).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ev = require('./biz-evidence');

const SELF = path.join(ev.EVIDENCE_BASE, '_selftest');
test.after(() => fs.rmSync(SELF, { recursive: true, force: true }));

test('evidence stays inside the approved evidence directory; header pins commit/version/env and carries no credentials', () => {
  const run = ev.createRun('_selftest');
  assert.ok(run.dir.startsWith(ev.EVIDENCE_BASE + path.sep));
  const h = ev.writeHeader(run, { systemIdentifier: '7692905965783805068', databases: ['daii_test_biz_t00_x'] });
  assert.match(h.commit, /^[0-9a-f]{40}$/);
  assert.equal(h.projectRoot, ev.ROOT);
  assert.ok(h.applicationVersion);
  assert.equal(JSON.stringify(h).toLowerCase().includes('password'), false);
  assert.throws(() => ev.assertInside(path.join(ev.ROOT, '..', 'elsewhere', 'x.json')), /escapes/);
  assert.throws(() => ev.assertInside(path.join(ev.ROOT, 'backend', 'src', 'x.json')), /escapes/);
  assert.throws(() => ev.createRun('../etc'), /bad test id/);
  assert.throws(() => ev.writeJson(run, '../x.json', {}), /bad evidence file name/);
});

test('finalize writes a manifest and re-verifies every file; tampering or a missing file fails BEFORE any cleanup', () => {
  const run = ev.createRun('_selftest');
  ev.writeHeader(run, {});
  ev.writeJson(run, 'raw-round-01.json', { ok: [1, 2, 3] });
  ev.writeResult(run, [{ id: 'case-1', status: 'PASS' }]);
  const m = ev.finalize(run);
  assert.equal(m.files.length, 3);
  assert.ok(fs.existsSync(path.join(run.dir, 'MANIFEST.sha256')));
  // tamper after finalize => a second finalize must detect it
  fs.writeFileSync(path.join(run.dir, 'raw-round-01.json'), '{"ok":[9]}');
  const again = ev.createRun('_selftest');
  ev.writeJson(again, 'a.json', { a: 1 });
  fs.rmSync(path.join(again.dir, 'a.json'));
  assert.throws(() => ev.finalize(again));
  assert.throws(() => ev.writeResult(run, [{ id: 'x', status: 'MAYBE' }]), /bad result status/);
});

test('fingerprint: equal for unchanged data, different after a change, "absent" for missing tables (fake ds)', async () => {
  let rows = [{ n: 2, h: 'aaa' }];
  const ds = { query: async (sql) => (/to_regclass/.test(sql) ? [{ e: true }] : rows) };
  const a = await ev.fingerprint(ds, ['stock_movements', 'event_outbox']);
  const b = await ev.fingerprint(ds, ['stock_movements', 'event_outbox']);
  assert.deepEqual(ev.diffFingerprints(a, b), []);
  rows = [{ n: 3, h: 'bbb' }];
  const c = await ev.fingerprint(ds, ['stock_movements', 'event_outbox']);
  assert.equal(ev.diffFingerprints(a, c).length, 2);
  const none = await ev.fingerprint({ query: async () => [{ e: false }] }, ['nope']);
  assert.deepEqual(none, { nope: 'absent' });
  await assert.rejects(() => ev.fingerprint(ds, ['x; drop table y']), /bad table name/);
});
