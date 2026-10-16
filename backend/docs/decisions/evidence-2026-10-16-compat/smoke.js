// usage: node smoke.js <baseUrl> [--write]
const base = process.argv[2]; const write = process.argv.includes('--write');
const J = { 'Content-Type': 'application/json' };
const out = [];
const rec = (n, ok, d) => { out.push([ok ? 'PASS' : 'FAIL', n, d ?? ''].join(' | ')); };
(async () => {
  const hz = await fetch(base + '/api/health/deep'); rec('health/deep', hz.status === 200, hz.status);
  const idx = await fetch(base + '/'); const html = await idx.text(); const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]);
  rec('frontend index served', idx.status === 200 && assets.length > 0, `status=${idx.status} assets=${assets.join(',')}`);
  for (const a of assets) { const r = await fetch(base + a); rec('asset ' + a, r.status === 200, r.status); }
  const lg = await fetch(base + '/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ email: 'bv.admin@example.test', password: 'BvAdmin#2026' }) });
  const lj = await lg.json(); rec('login', lg.status === 201 || lg.status === 200, lg.status);
  let tok = lj.data?.accessToken; const me = await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + tok } }); const mj = await me.json();
  const cid = process.env.SIM_COMPANY_ID || (mj.data?.memberships ?? [])[0]?.companyId;
  const sc = await fetch(base + '/api/auth/select-company', { method: 'POST', headers: { ...J, Authorization: 'Bearer ' + tok }, body: JSON.stringify({ companyId: cid }) });
  const sj = await sc.json(); rec('select-company', sc.status < 300, sc.status); tok = sj.data?.accessToken ?? tok;
  const H = { Authorization: 'Bearer ' + tok, ...J };
  const g = async (n, p) => { const r = await fetch(base + p, { headers: H }); let b = ''; if (r.status >= 400) b = (await r.text()).slice(0, 160); rec(n, r.status === 200, r.status + ' ' + b); return r; };
  await g('GET /customers', '/api/customers'); await g('GET /products/all', '/api/products/all'); { const r = await fetch(base + '/api/products/lookup?code=ZZZ', { headers: H }); rec('GET /products/lookup (new route: unknown code answers 404 NOT_FOUND)', r.status === 404, r.status); }
  await g('GET /inventory/warehouses', '/api/inventory/warehouses'); await g('GET /procurement/suppliers', '/api/procurement/suppliers');
  await g('GET /procurement/purchase-orders', '/api/procurement/purchase-orders'); await g('GET /accounting/trial-balance', '/api/accounting/trial-balance');
  if (write) {
    const c = await fetch(base + '/api/customers', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Sim Customer', phone: '0100000099' }) }); const cj = await c.json(); rec('POST /customers', c.status < 300, c.status + ' ' + JSON.stringify(cj).slice(0, 120));
    const cuid = cj.data?.id ?? cj.data?.customer?.id;
    if (cuid) { await g('GET /customers/:id/profile (new)', '/api/customers/' + cuid + '/profile');
      const u = await fetch(base + '/api/customers/' + cuid + '/update', { method: 'POST', headers: H, body: JSON.stringify({ email: 'sim@example.test', partyType: 'company' }) }); rec('POST customer profile update (new fields)', u.status < 300, u.status + ' ' + (u.status >= 300 ? (await u.text()).slice(0, 120) : '')); }
    const s = await fetch(base + '/api/procurement/suppliers', { method: 'POST', headers: H, body: JSON.stringify({ legalName: 'Sim Supplier', supplierType: 'company' }) }); const sj2 = await s.json(); rec('POST /procurement/suppliers', s.status < 300, s.status + ' ' + JSON.stringify(sj2).slice(0, 120));
  }
  console.log(out.join('\n')); console.log('TOTAL', out.filter(x => x.startsWith('PASS')).length, 'pass', out.filter(x => x.startsWith('FAIL')).length, 'fail');
})().catch(e => { console.log(out.join('\n')); console.error('SMOKE ERROR', e); process.exit(1); });
