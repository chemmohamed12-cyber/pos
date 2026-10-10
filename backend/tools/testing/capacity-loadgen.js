'use strict';
/**
 * Standalone HTTP load generator for a STAGING-LIKE capacity run, to be executed from a SEPARATE machine (so the load generator does not share CPU with the
 * application, which is the main distortion of the local T-16 benchmark).
 *
 *   CAPACITY_BASE_URL=https://staging.example/api  CAPACITY_TOKEN=<bearer token of a TEST user>  CAPACITY_FIXTURE=fixture.json  \
 *   node tools/testing/capacity-loadgen.js [--profile tools/testing/capacity-profile.json] [--scale 1] [--out result.json]
 *
 * NOTHING here touches a database. It only sends HTTP requests, and it REFUSES to start unless the operator has explicitly authorised the target:
 *   - CAPACITY_AUTHORISED_BY must name the person who authorised the run against CAPACITY_BASE_URL (it is echoed into the result file);
 *   - the tool refuses any base URL whose host name contains "prod" (a staging host must be named accordingly).
 * The token comes from the environment only and is never printed or written. The fixture file lists ids that exist in the TARGET test Company:
 *   { "companies": [ { "header": {"x-company-id": "<id>"}, "customerId": "...", "warehouseId": "...", "accounts": ["..."], "products": ["..."] } ] }
 * (header(s) are whatever the target needs to select the Company; none are invented here). Integrity must be verified afterwards on the TARGET with the
 * SQL oracle in docs/decisions/test-program/STAGING-CAPACITY-PROFILE-2026-10-11.md.
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = process.env.CAPACITY_BASE_URL;
const token = process.env.CAPACITY_TOKEN;
const authorisedBy = process.env.CAPACITY_AUTHORISED_BY;
if (!base || !token || !process.env.CAPACITY_FIXTURE) { console.error('REFUSED: CAPACITY_BASE_URL, CAPACITY_TOKEN and CAPACITY_FIXTURE are required'); process.exit(2); }
if (!authorisedBy) { console.error('REFUSED: CAPACITY_AUTHORISED_BY (name of the person who authorised load against this target) is required'); process.exit(2); }
if (/prod/i.test(new URL(base).hostname)) { console.error('REFUSED: the target host looks like production'); process.exit(2); }
const profile = JSON.parse(fs.readFileSync(path.resolve(arg('--profile', path.join(__dirname, 'capacity-profile.json'))), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(path.resolve(process.env.CAPACITY_FIXTURE), 'utf8'));
const scale = Number(arg('--scale', '1'));
const outFile = arg('--out', `capacity-result-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pct = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0);
const uuid = () => require('crypto').randomUUID();
const mix = profile.mix; const totalW = mix.reduce((s, m) => s + m.weight, 0);
const chooseOp = () => { let r = Math.random() * totalW; for (const m of mix) { if ((r -= m.weight) < 0) return m.op; } return mix[0].op; };

async function call(c, method, p, body, key) {
  const t0 = performance.now(); let status = 0;
  try {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...c.header, ...(key ? { 'idempotency-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    await r.arrayBuffer(); status = r.status;
  } catch { status = -1; }
  return { status, ms: performance.now() - t0, ok: status >= 200 && status < 300 };
}
async function op(kind) {
  const name = chooseOp();
  const c = pick(fixture.companies);
  const acct = kind === 'hot' ? c.accounts[0] : pick(c.accounts);
  const prod = kind === 'hot' ? c.products[0] : pick(c.products);
  const key = uuid();
  let r;
  if (name === 'payment.on-account') r = await call(c, 'POST', '/payments/on-account', { customerId: c.customerId, amount: '1.00', method: 'bank_transfer', treasuryAccountId: acct, reference: key.slice(0, 20) }, key);
  else if (name === 'inventory.receipt') r = await call(c, 'POST', '/inventory/movements', { warehouseId: c.warehouseId, productId: prod, quantity: 1, movementType: 'receipt', unitCostBase: '4.00', reasonCode: 'FOUND_STOCK' });
  else if (name === 'treasury.cash-in') r = await call(c, 'POST', '/treasury/cash-in', { accountId: acct, amount: '1.00', reference: key.slice(0, 20) }, key);
  else if (name === 'treasury.cash-out') r = await call(c, 'POST', '/treasury/cash-out', { accountId: acct, amount: '1.00', reference: key.slice(0, 20) }, key);
  else if (name === 'read.treasury-accounts') r = await call(c, 'GET', '/treasury/accounts');
  else r = await call(c, 'GET', `/inventory/reports/movements?warehouseId=${c.warehouseId}`);
  return { name, r, key };
}

(async () => {
  const phases = [];
  for (const ph of profile.phases) {
    for (const users of ph.virtualUsers) {
      const seconds = Math.max(3, Math.round(ph.secondsEach * scale));
      const lat = []; const status = {}; let ok = 0; let total = 0; const windows = []; let cur = []; let winStart = Date.now();
      const t0 = Date.now(); const end = t0 + seconds * 1000;
      const worker = async () => { while (Date.now() < end) {
        const { r } = await op(ph.kind);
        total += 1; if (r.ok) ok += 1; lat.push(r.ms); status[r.status] = (status[r.status] || 0) + 1;
        if (ph.windowSeconds) { cur.push(r.ms); if (Date.now() - winStart >= ph.windowSeconds * 1000) { cur.sort((a, b) => a - b); windows.push({ t: Math.round((Date.now() - t0) / 1000), p95: Math.round(pct(cur, 95)), n: cur.length }); cur = []; winStart = Date.now(); } }
      } };
      await Promise.all(Array.from({ length: users }, worker));
      lat.sort((a, b) => a - b); const wall = (Date.now() - t0) / 1000;
      phases.push({ phase: ph.name, kind: ph.kind, virtualUsers: users, seconds: Number(wall.toFixed(1)), requests: total, success2xx: ok, nonSuccess: total - ok, statusCodes: status, requestsPerSec: Number((total / wall).toFixed(1)), p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)), windows });
      console.log(`${ph.name} users=${users} req=${total} ok=${ok} rps=${(total / wall).toFixed(1)} p95=${Math.round(pct(lat, 95))}ms`);
    }
  }
  fs.writeFileSync(outFile, JSON.stringify({ tool: 'capacity-loadgen', startedFromHost: require('os').hostname(), authorisedBy, target: new URL(base).origin, profileVersion: profile.version, scale, phases, note: 'integrity is NOT verified by this tool — run the SQL oracle on the target afterwards' }, null, 2));
  console.log(`result written to ${outFile}`);
})();
