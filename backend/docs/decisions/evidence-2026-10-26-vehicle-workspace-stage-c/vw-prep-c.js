'use strict';
// Stage C preview/acceptance data, isolated DBs daii_test_biz_t96_vw_* only, through the REAL API as the admin test account.
// Env: RH_PORT RH_SCRATCH RH_APP RH_MAIN DB_* RH_ADMIN_PASSWORD (see rehearsal.env). Idempotent-ish: safe to re-run.
const fs = require('fs');
const B = 'http://127.0.0.1:' + process.env.RH_PORT + '/api';
const seed = JSON.parse(fs.readFileSync(process.env.RH_SCRATCH + '/vw-seed.json', 'utf8'));
const j = async (m, p, body, tok) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d: d && d.data !== undefined ? d.data : d }; };
const must = (r, what) => { if (r.s >= 300) throw new Error(what + ' -> ' + r.s + ' ' + JSON.stringify(r.d).slice(0, 300)); return r.d; };
(async () => {
  const pg = require(process.env.RH_APP + '/node_modules/pg');
  const co = new pg.Client({ host: process.env.DB_HOST, port: +process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.RH_MAIN.replace('_main', '_co1') }); await co.connect();
  const cp = new pg.Client({ host: process.env.DB_HOST, port: +process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.RH_MAIN }); await cp.connect();
  const companyId = (await cp.query('select id from companies limit 1')).rows[0].id; await cp.end();
  // chart additions (test environment): custody, float, expense - all asset/expense, bank control for the cash-like ones
  for (const [code, name, type, fn] of [['1190', 'Driver custody (collections)', 'asset', 'bank'], ['1195', 'Driver expense float', 'asset', 'bank'], ['5910', 'Vehicle expenses', 'expense', null]]) {
    await co.query(`INSERT INTO accounting_gl_accounts (id,code,name,"accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") SELECT gen_random_uuid(),$1::varchar,$2,$3,$4,true,false,true,$5 WHERE NOT EXISTS (SELECT 1 FROM accounting_gl_accounts WHERE code=$1::varchar)`, [code, name, type, type === 'expense' || type === 'asset' ? 'debit' : 'credit', fn]);
  }
  const login = async (email, pw) => { const l = must(await j('POST', '/auth/login', { email, password: pw }), 'login'); return must(await j('POST', '/auth/select-company', { companyId }, l.accessToken), 'select').accessToken; };
  const A = await login('admin@daii.example', process.env.RH_ADMIN_PASSWORD);
  const accounts = must(await j('GET', '/treasury/accounts', undefined, A), 'accounts');
  const types = must(await j('GET', '/treasury/account-types', undefined, A), 'types');
  const cashType = types.find((t) => t.code === 'cash').id;
  const byCode = (c) => accounts.find((a) => a.code === c);
  // map the existing accounts (the fail-closed gaps are real until Accounting does this)
  const mapGl = async (id, gl) => must(await j('POST', `/treasury/accounts/${id}/gl-mapping`, { glAccountCode: gl }, A), 'gl-mapping ' + gl);
  const main = byCode('MAIN-CASH'); if (!main.glAccountCode) await mapGl(main.id, '1101');
  for (const c of accounts.filter((a) => /^CUST-/.test(a.code))) if (!c.glAccountCode) await mapGl(c.id, '1190');
  // float accounts (cash type) for VH-101 only; VH-202 deliberately has none (fail-closed demonstration)
  let f1 = byCode('FLT-VH101');
  if (!f1) { f1 = must(await j('POST', '/treasury/accounts', { code: 'FLT-VH101', name: 'Float VH-101', accountTypeId: cashType }, A), 'create float'); await mapGl(f1.id, '1195'); }
  // posting-profile mappings (Accounting policy API)
  must(await j('POST', '/accounting/policy-config/accounting.treasury_disbursement_reason_accounts', { value: { custody_fuel: '5910', custody_toll: '5910' } }, A), 'policy disbursement');
  must(await j('POST', '/accounting/policy-config/accounting.treasury_receipt_reason_accounts', { value: { OTHER_INCOME: '4900' } }, A), 'policy receipt');
  // assign the float
  must(await j('POST', `/shipments/vehicles/${seed.V1.id}/expense-float`, { treasuryAccountId: f1.id }, A), 'assign float');
  // fund it through REAL Treasury documents: misc receipt into MAIN-CASH, then a transfer MAIN-CASH -> float (prepare / submit / separate approver / execute)
  const checkerPw = fs.readFileSync(process.env.RH_SCRATCH + '/checker.cred', 'utf8').trim().split(/\s+/)[1];
  const C = await login('checker@daii.example', checkerPw);
  const flow = async (input) => {
    const d = must(await j('POST', '/treasury/documents', input, A), 'doc create');
    let s = must(await j('POST', `/treasury/documents/${d.id}/submit`, {}, A), 'doc submit');
    if (s.status === 'submitted') must(await j('POST', `/treasury/documents/${d.id}/decide`, { decision: 'approved' }, C), 'doc approve');
    return must(await j('POST', `/treasury/documents/${d.id}/execute`, {}, A), 'doc execute');
  };
  const bal = async (id) => Number((must(await j('GET', '/treasury/accounts', undefined, A), 'accts').find((a) => a.id === id) || {}).balance || 0);
  if ((await bal(f1.id)) < 500) {
    if ((await bal(main.id)) < 1000) await flow({ kind: 'misc_receipt', treasuryAccountId: main.id, amount: '2000.00', reasonCode: 'OTHER_INCOME', reference: 'PREVIEW-SEED', purpose: 'Preview seed cash' });
    await flow({ kind: 'transfer', subtype: 'account_transfer', treasuryAccountId: main.id, counterTreasuryAccountId: f1.id, amount: '1000.00', purpose: 'Initial expense float for VH-101', reference: 'FLOAT-FUND-1' });
  }
  console.log('float account', f1.id, 'balance', await bal(f1.id));
  fs.writeFileSync(process.env.RH_SCRATCH + '/vw-float.json', JSON.stringify({ floatId: f1.id, mainId: main.id }, null, 1));
  await co.end();
})().catch((e) => { console.error('PREP FAILED:', e.message); process.exit(1); });
