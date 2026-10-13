const { Client } = require('D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/backend/node_modules/pg');
const base = { host: '127.0.0.1', port: 5546, user: 'daii_biz_test', password: process.env.PGPW };
const DB = 'daii_test_biz_t93_finv_rehearsal';
(async () => {
  const a = new Client({ ...base, database: 'postgres' }); await a.connect();
  await a.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`); await a.query(`CREATE DATABASE "${DB}"`); await a.end();
  const c = new Client({ ...base, database: DB }); await c.connect();
  await c.query(`CREATE TABLE stock_movements (id serial primary key, "movementType" text, "referenceType" text, "referenceId" text, quantity int, "warehouseId" text, "productId" text, "createdByUserId" text, "createdAt" timestamptz default now())`);
  await c.query(`CREATE TABLE audit_records (seq serial primary key, action text, "timestamp" timestamptz default now())`);
  // synthetic fixture: receipts (expected), a recent non-receipt (live consumer), an old non-receipt, a governed movement, a negative on-hand pair
  await c.query(`INSERT INTO stock_movements ("movementType","referenceType","referenceId",quantity,"warehouseId","productId","createdByUserId","createdAt") VALUES
    ('receipt',NULL,NULL,5,'W1','P1','u-clerk', now()-interval '10 days'),
    ('dispatch',NULL,NULL,-2,'W1','P1','svc-integration-7', now()-interval '5 days'),
    ('adjustment',NULL,NULL,-1,'W1','P1','u-manager', now()-interval '400 days'),
    ('dispatch','shipment','S-1',-3,'W2','P2','u-driver', now()-interval '3 days'),
    ('receipt',NULL,NULL,1,'W2','P2','u-clerk', now()-interval '30 days')`);
  await c.query(`INSERT INTO audit_records (action,"timestamp") VALUES ('inventory.movement.dispatch', now()-interval '5 days'),('inventory.movement.receipt', now()-interval '10 days')`);
  await c.end();
  console.log('fixture ready');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
