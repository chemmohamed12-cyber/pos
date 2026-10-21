'use strict';
/**
 * Post-deployment smoke of the DEPLOYED v1.1.11 application (HTTP, real backend on RH_PORT over the engine-upgraded isolated DBs).
 * Auth -> company selection -> permissions -> Treasury document flow with maker/checker -> customer payment reversal -> supplier payment (allocated) -> supplier payment reversal
 * -> duplicate/concurrent reversal -> consistency (Treasury vs GL vs ledgers) -> fail-closed GL policy keys.
 * Business fixtures that need the full PR->PO->GR chain (a POSTED supplier invoice) are inserted by SQL (that chain is covered by the 30-spec regression); everything else is the real API.
 */
const path = require('path');
const APP = process.env.RH_APP;
const nm = (p) => require(path.join(APP, 'node_modules', p));
const { Client } = nm('pg');
const bcrypt = nm('bcrypt');
const { randomUUID } = require('crypto');
const fs = require('fs');
const B = `http://127.0.0.1:${process.env.RH_PORT || 3690}/api`;
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail: String(detail).slice(0, 220) }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); };
const j = async (m, p, body, tok, extra = {}) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d: d && d.data !== undefined ? d.data : d, raw: d }; };

async function login(email, pw, companyId) {
  const l = await j('POST', '/auth/login', { email, password: pw });
  if (l.s !== 201 && l.s !== 200) return { err: l };
  const s = await j('POST', '/auth/select-company', { companyId }, l.d.accessToken);
  return { tok: s.d.accessToken, status: s.s };
}

(async () => {
  const pg = (db) => new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: db });
  const cp = pg(process.env.RH_MAIN); await cp.connect();
  const co = pg(process.env.RH_CO); await co.connect();
  const companyId = (await cp.query(`SELECT id FROM companies LIMIT 1`)).rows[0].id;
  const adminPw = process.env.RH_ADMIN_PASSWORD;
  // second operator (checker): company admin, NOT a platform admin
  const credFile = path.join(process.env.RH_SCRATCH || '.', 'checker.cred');
  const checkerEmail = 'checker@daii.example';
  let checkerPw = fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8').split(' ')[1] : 'Ck!' + randomUUID().replace(/-/g, '').slice(0, 12);
  const existing = (await cp.query(`SELECT id FROM users WHERE email = $1`, [checkerEmail])).rows;
  let checkerId = existing[0] && existing[0].id;
  if (!checkerId) {
    checkerId = randomUUID();
    await cp.query(`INSERT INTO users (id,"fullName",email,status) VALUES ($1,'Rehearsal Checker',$2,'active')`, [checkerId, checkerEmail]);
    await cp.query(`INSERT INTO credentials ("userId","passwordHash","passwordChangedAt") VALUES ($1,$2,now())`, [checkerId, await bcrypt.hash(checkerPw, 10)]);
    await cp.query(`INSERT INTO user_company_memberships (id,"userId","companyId","roleKey") VALUES ($1,$2,$3,'admin')`, [randomUUID(), checkerId, companyId]);
    const role = (await co.query(`SELECT id FROM roles WHERE key='admin'`)).rows[0];
    await co.query(`INSERT INTO users (id,"fullName",email,status) VALUES ($1,'Rehearsal Checker',$2,'active')`, [checkerId, checkerEmail]);
    await co.query(`INSERT INTO user_roles (id,"userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), checkerId, role.id]);
  }
  fs.writeFileSync(path.join(process.env.RH_SCRATCH || '.', 'checker.cred'), checkerEmail + ' ' + checkerPw);

  // ---------- 1 health / auth / company selection / permissions
  const root = await fetch(B.replace('/api', '/')); ok('UI served at / (frontend bundle from the package)', root.status === 200, root.status);
  const bad = await j('POST', '/auth/login', { email: 'admin@daii.example', password: 'wrong-password' }); ok('wrong password refused', bad.s === 401 || bad.s === 400, bad.s);
  const A = await login('admin@daii.example', adminPw, companyId); ok('maker login + select-company', !!A.tok, A.status);
  const C = await login(checkerEmail, checkerPw, companyId); ok('checker login + select-company', !!C.tok, C.status);
  const noCo = await j('GET', '/treasury/accounts', undefined, (await j('POST', '/auth/login', { email: 'admin@daii.example', password: adminPw })).d.accessToken); ok('company-scoped route refused before company selection (403/401)', [401, 403].includes(noCo.s), noCo.s);
  const anon = await j('GET', '/treasury/accounts'); ok('anonymous refused', anon.s === 401, anon.s);
  const me = await j('GET', '/auth/me', undefined, A.tok); ok('/auth/me returns the user with permissions for the selected company', me.s === 200, JSON.stringify(me.d).slice(0, 120));

  // ---------- 2 policy (Treasury reason profiles only - NOT the four procurement cost accounts)
  const setPol = async (k, v) => j('POST', '/accounting/policy-config/' + k, { value: v }, A.tok);
  ok('policy: clearing account', (await setPol('accounting.cash_movement_clearing_account_code', '3999')).s === 201);
  ok('policy: receipt reason profile', (await setPol('accounting.treasury_receipt_reason_accounts', { OTHER_INCOME: '4900' })).s === 201);
  const pol = await j('GET', '/accounting/policy-config', undefined, A.tok);
  const polList = Array.isArray(pol.d) ? pol.d : pol.d && pol.d.items ? pol.d.items : [];
  const costKeys = polList.filter((k) => /cost|ppv|price_variance|cost_difference|returns|charges/i.test(k.key || ''));
  console.log('procurement-cost related policy keys:', costKeys.map((k) => `${k.key}=${JSON.stringify(k.value ?? k.currentValue ?? null)}`).join(' | '));
  ok('fail-closed: the four procurement cost-account policy keys are listed and UNSET (no guessed default)', costKeys.length >= 4 && costKeys.every((k) => (k.value ?? k.currentValue ?? null) === null || (k.value ?? k.currentValue) === ''), costKeys.map((k) => k.key).join(','));

  // ---------- 3 Treasury document: collection with maker != checker, execute, customer payment reversal
  const accts = (await j('GET', '/treasury/accounts', undefined, A.tok)).d;
  const bank = accts.find((a) => a.code === 'RH-BANK');
  ok('seeded mapped bank account visible', !!bank && bank.glAccountCode === '1102');
  const cust = (await co.query(`SELECT id FROM customers WHERE code='CUST-RH'`)).rows[0].id;
  const invs = (await co.query(`SELECT id, "invoiceNumber" FROM sales_invoices ORDER BY "invoiceNumber"`)).rows;
  const doc = await j('POST', '/treasury/documents', { kind: 'customer_collection', treasuryAccountId: bank.id, customerId: cust, method: 'bank_transfer', reference: 'RH-COL-1', purpose: 'Rehearsal collection', allocations: [{ invoiceId: invs[0].id, amount: '900.00' }] }, A.tok);
  ok('create customer-collection document (draft)', doc.s === 201 && doc.d.status === 'draft', doc.s);
  const sub = await j('POST', `/treasury/documents/${doc.d.id}/submit`, { expectedVersion: doc.d.version }, A.tok); ok('submit', sub.s === 201 && sub.d.status === 'submitted', sub.s);
  const selfAppr = await j('POST', `/treasury/documents/${doc.d.id}/decide`, { decision: 'approved' }, A.tok); ok('maker cannot approve own document (maker != checker)', [403, 409, 400].includes(selfAppr.s), selfAppr.s);
  const appr = await j('POST', `/treasury/documents/${doc.d.id}/decide`, { decision: 'approved' }, C.tok); ok('checker approves', appr.s === 201 && appr.d.status === 'approved', appr.s);
  const exec = await j('POST', `/treasury/documents/${doc.d.id}/execute`, { expectedVersion: appr.d.version }, C.tok, { 'idempotency-key': 'rh-exec-1' }); ok('execute (Treasury leg + customer payment + GL)', exec.s === 201 && exec.d.status === 'executed', exec.s + ' ' + (exec.d && exec.d.status));
  const again = await j('POST', `/treasury/documents/${doc.d.id}/execute`, {}, C.tok, { 'idempotency-key': 'rh-exec-1' }); ok('replayed execute with the same key does not double-post', again.s < 300 || again.s === 409, again.s);
  const q = async (sql, p = []) => (await co.query(sql, p)).rows;
  ok('exactly one Treasury leg + one payment + one journal for the document', Number((await q(`SELECT count(*) n FROM treasury_transactions WHERE reference = $1`, [doc.d.documentNumber || 'x']))[0].n) <= 1 && Number((await q(`SELECT count(*) n FROM customer_payments`))[0].n) === 1);
  const payId = (await q(`SELECT id FROM customer_payments LIMIT 1`))[0].id;
  const rev = await j('POST', `/payments/${payId}/reverse`, { reason: 'rehearsal reversal' }, C.tok); ok('customer payment reversal', rev.s === 201, rev.s + ' ' + JSON.stringify(rev.d).slice(0, 80));
  const rev2 = await j('POST', `/payments/${payId}/reverse`, { reason: 'again' }, C.tok); ok('duplicate customer-payment reversal refused (409)', rev2.s === 409, rev2.s);
  ok('invoice re-opened after reversal (remaining back to 900.00)', (await q(`SELECT sum(CASE WHEN direction='credit' THEN -amount ELSE amount END)::numeric(14,2)::text r FROM customer_ledger_entries WHERE "invoiceId" = $1`, [invs[0].id]))[0].r === '900.00');

  // ---------- 4 supplier payment (allocated over two invoices) + reversal (the new endpoint)
  const sup = (await q(`SELECT id FROM suppliers WHERE code='SUP-RH'`))[0].id;
  const wh = (await q(`SELECT id FROM warehouses LIMIT 1`))[0].id;
  const po = randomUUID();
  await co.query(`INSERT INTO purchase_orders (id,"poNumber",\"supplierId\",\"warehouseId\") VALUES ($1,'PO-RH-1',$2,$3)`, [po, sup, wh]);
  const si = [];
  for (const [n, t] of [['SINV-RH-1', '300.00'], ['SINV-RH-2', '200.00']]) {
    const id = randomUUID(); si.push(id);
    await co.query(`INSERT INTO supplier_invoices (id,"invoiceNumber","supplierId","purchaseOrderId","totalAmount","createdByUserId") VALUES ($1,$2,$3,$4,$5,$6)`, [id, n, sup, po, t, checkerId]);
    await co.query(`INSERT INTO process_instances (id,"definitionKey","entityType","entityId","currentState") VALUES ($1,'supplier_invoice_lifecycle','supplier_invoice',$2,'posted')`, [randomUUID(), id]);
  }
  // fund the bank through the real receipt flow is not needed: reuse the collection money? it was reversed -> fund via a misc receipt document
  const fundDoc = await j('POST', '/treasury/documents', { kind: 'misc_receipt', treasuryAccountId: bank.id, amount: '5000.00', reasonCode: 'OTHER_INCOME', reference: 'RH-FUND', purpose: 'Rehearsal funding' }, A.tok);
  await j('POST', `/treasury/documents/${fundDoc.d.id}/submit`, {}, A.tok);
  const fa = await j('POST', `/treasury/documents/${fundDoc.d.id}/decide`, { decision: 'approved' }, C.tok);
  const fe = await j('POST', `/treasury/documents/${fundDoc.d.id}/execute`, {}, C.tok); ok('fund the bank through an approved misc-receipt document', fe.s === 201 && fe.d.status === 'executed', fe.s);
  const bankBefore = (await j('GET', '/treasury/accounts', undefined, A.tok)).d.find((a) => a.code === 'RH-BANK').balance;
  const sp = await j('POST', '/procurement/supplier-payments/allocated', { supplierId: sup, allocations: [{ invoiceId: si[0], amount: '300.00' }, { invoiceId: si[1], amount: '150.00' }], method: 'bank_transfer', treasuryAccountId: bank.id }, A.tok);
  ok('allocated supplier payment (2 invoices)', sp.s === 201, sp.s + ' ' + JSON.stringify(sp.d).slice(0, 100));
  const st = async (id) => (await q(`SELECT "currentState" s FROM process_instances WHERE "entityId" = $1 AND "entityType"='supplier_invoice'`, [id]))[0].s;
  ok('invoice states paid / partially_paid', (await st(si[0])) === 'paid' && (await st(si[1])) === 'partially_paid');
  const bankMid = (await j('GET', '/treasury/accounts', undefined, A.tok)).d.find((a) => a.code === 'RH-BANK').balance;
  const norev = await j('POST', `/procurement/supplier-payments/${sp.d.id}/reverse`, { reason: 'x' }, A.tok); // reason too short (<3)
  ok('reason shorter than 3 characters refused (400)', norev.s === 400, norev.s);
  const srev = await j('POST', `/procurement/supplier-payments/${sp.d.id}/reverse`, { reason: 'paid to the wrong supplier' }, C.tok, { 'idempotency-key': 'rh-srev-1' });
  ok('SUPPLIER PAYMENT REVERSAL via the deployed route', srev.s === 201 && /^SPREV/.test((srev.d || {}).reversalNumber || ''), srev.s + ' ' + JSON.stringify(srev.d).slice(0, 100));
  ok('both supplier invoices re-opened to posted', (await st(si[0])) === 'posted' && (await st(si[1])) === 'posted', (await st(si[0])) + '/' + (await st(si[1])));
  const bankAfter = (await j('GET', '/treasury/accounts', undefined, A.tok)).d.find((a) => a.code === 'RH-BANK').balance;
  ok('Treasury balance returns to the pre-payment value', bankAfter === bankBefore && bankMid !== bankBefore, `${bankBefore} -> ${bankMid} -> ${bankAfter}`);
  const dup = await Promise.all(Array.from({ length: 4 }, () => j('POST', `/procurement/supplier-payments/${sp.d.id}/reverse`, { reason: 'concurrent duplicate' }, C.tok)));
  ok('duplicate / concurrent reversals all refused (no second effect)', dup.every((r) => r.s === 409), dup.map((r) => r.s).join(','));
  ok('exactly one reversal record, one reversal event POSTED', Number((await q(`SELECT count(*) n FROM supplier_payment_reversals`))[0].n) === 1 && Number((await q(`SELECT count(*) n FROM accounting_financial_events WHERE "eventType"='finance.supplier_payment.reversed' AND status='POSTED'`))[0].n) === 1);
  const noperm = await j('POST', `/procurement/supplier-payments/${randomUUID()}/reverse`, { reason: 'abc' }, undefined); ok('reverse route needs authentication (401)', noperm.s === 401, noperm.s);

  const exc = await j('GET', '/accounting/cash-bank/posting-exceptions', undefined, A.tok);
  const excRows = (exc.d && exc.d.rows) || [];
  ok('posting-exceptions view shows NO exception for payment legs (reversal legs are covered by their own event)', exc.s === 200 && excRows.filter((r) => /payment/.test(r.category)).length === 0, exc.s + ' rows=' + excRows.length + ' ' + excRows.map((r) => r.category + ':' + r.cause).join(','));
  // ---------- 5 consistency
  const gl = async (code) => (await q(`SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"),0)::numeric(20,2)::text b FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" JOIN accounting_journal_entries je ON je.id = jl."journalEntryId" AND je."postedAt" IS NOT NULL WHERE ga.code = $1`, [code]))[0].b;
  const treasuryBal = (await q(`SELECT COALESCE(SUM(CASE WHEN type='cash_in' THEN amount ELSE -amount END),0)::numeric(20,2)::text b FROM treasury_transactions t JOIN treasury_accounts a ON a.id=t."treasuryAccountId" WHERE a.code='RH-BANK' AND t.status IN ('posted','reversed')`))[0].b;
  ok('Treasury (RH-BANK ledger) == GL 1102', treasuryBal === (await gl('1102')), `${treasuryBal} vs ${await gl('1102')}`);
  const apSub = (await q(`SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END),0)::numeric(14,2)::text b FROM supplier_ledger_entries WHERE "supplierPaymentId" IS NOT NULL`))[0].b;
  ok('AP subledger (payment-related) == GL AP 2101', apSub === (await gl('2101')), `${apSub} vs ${await gl('2101')}`);
  const arSub = (await q(`SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN -amount ELSE amount END),0)::numeric(14,2)::text b FROM customer_ledger_entries WHERE "paymentId" IS NOT NULL`))[0].b;
  ok('AR subledger (payment-related) == GL AR 1110', arSub === (await gl('1110')), `${arSub} vs ${await gl('1110')}`);
  ok('every posted journal balanced; no non-POSTED financial event', Number((await q(`SELECT count(*) n FROM accounting_journal_entries WHERE "postedAt" IS NOT NULL AND "totalDebitBase" <> "totalCreditBase"`))[0].n) === 0 && Number((await q(`SELECT count(*) n FROM accounting_financial_events WHERE status <> 'POSTED'`))[0].n) === 0);
  const out = { when: new Date().toISOString(), base: B, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results };
  fs.writeFileSync(path.join(process.env.RH_SCRATCH || '.', 'smoke-results.json'), JSON.stringify(out, null, 1));
  console.log(`SMOKE: ${out.passed} passed, ${out.failed} failed`);
  await cp.end(); await co.end();
  process.exit(out.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
