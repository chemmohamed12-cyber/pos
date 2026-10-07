// Interleaved A/B latency comparison: pre-F1 build (3602) vs current build (3601), same isolated DBs, one client, alternating requests. GET only.
const CO = '8a60c675-42c5-4747-91cf-3f1f12250c15';
const J = { 'Content-Type': 'application/json' };
const N = Number(process.env.PERF_N || 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function session(port) {
  const API = `http://127.0.0.1:${port}/api`;
  const l = await (await fetch(API + '/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ email: 'bv.admin@example.test', password: process.env.BV_TEST_PASSWORD }) })).json();
  const s = await (await fetch(API + '/auth/select-company', { method: 'POST', headers: { ...J, Authorization: 'Bearer ' + l.data.accessToken }, body: JSON.stringify({ companyId: CO }) })).json();
  return { API, H: { Authorization: 'Bearer ' + s.data.accessToken } };
}
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const time = async (s, p) => { const t = process.hrtime.bigint(); const r = await fetch(s.API + p, { headers: s.H }); await r.text(); return [Number(process.hrtime.bigint() - t) / 1e6, r.status]; };
(async () => {
  const pre = await session(3602);
  const cur = await session(3601);
  const eps = [['health', '/health'], ['auth/me', '/auth/me'], ['me/navigation', '/me/navigation'], ['memberships/mine', '/memberships/mine'], ['accounting/accounts', '/accounting/accounts'], ['sales-orders', '/sales-orders'], ['approvals/requests', '/approvals/requests'], ['purchase-orders', '/procurement/purchase-orders'], ['organization/units', '/organization/units'], ['customers', '/customers?page=1&pageSize=20'], ['company/users (F2 only)', '/company/users']];
  const out = [];
  for (const [name, p] of eps) {
    for (let i = 0; i < 5; i++) { await time(pre, p); await time(cur, p); }
    const a = [], b = []; let sa = 0, sb = 0, badA = 0, badB = 0; const onlyCur = name.includes('F2 only');
    for (let i = 0; i < N; i++) {
      if (i % 2 === 0) { const x = onlyCur ? [0, 200] : await time(pre, p); a.push(x[0]); sa = x[1]; if (x[1] !== 200) badA++; const y = await time(cur, p); b.push(y[0]); sb = y[1]; if (y[1] !== 200) badB++; }
      else { const y = await time(cur, p); b.push(y[0]); sb = y[1]; if (y[1] !== 200) badB++; const x = onlyCur ? [0, 200] : await time(pre, p); a.push(x[0]); sa = x[1]; if (x[1] !== 200) badA++; }
    }
    out.push({ name, preStatus: badA ? 429 : sa, curStatus: badB ? 429 : sb, badPre: badA, badCur: badB, pre: { p50: +pct(a, 0.5).toFixed(1), p95: +pct(a, 0.95).toFixed(1) }, cur: { p50: +pct(b, 0.5).toFixed(1), p95: +pct(b, 0.95).toFixed(1) } });
  }
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
