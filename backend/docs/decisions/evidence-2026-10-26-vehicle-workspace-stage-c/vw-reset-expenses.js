// isolated DB only: the (unreleased) custody_expenses table was corrected in place for the separate-float policy; recreate it on the verification DB
const fs = require('fs'); const { Client } = require('pg'); const env = {};
for (const l of fs.readFileSync('D:/DAII-LOCAL-DEPLOY-R1111C/rehearsal.env', 'utf8').split(/\r?\n/)) { const m = l.match(/^([^=]+)=(.*)$/); if (m) env[m[1]] = m[2]; }
(async () => { const c = new Client({ host: env.DB_HOST, port: +env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD, database: 'daii_test_biz_t96_vw_co1' }); await c.connect();
  await c.query('DROP TABLE IF EXISTS custody_expenses'); await c.query("DELETE FROM migrations WHERE name='CreateCustodyExpenses1790040200000'"); await c.end(); console.log('reset'); })();
