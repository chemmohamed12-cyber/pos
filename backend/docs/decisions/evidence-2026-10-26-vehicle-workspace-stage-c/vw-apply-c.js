// Applies the Stage C logistics migrations (1790040000000..1790040300000) from the worktree build to the vw verification DBs on 5546. Verification environment only.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const env = {};
for (const l of fs.readFileSync('D:/DAII-LOCAL-DEPLOY-R1111C/rehearsal.env', 'utf8').split(/\r?\n/)) { const m = l.match(/^([^=]+)=(.*)$/); if (m) env[m[1]] = m[2]; }
const dir = 'D:/CLAUDE-CODE/XNEXUS-WORKSPACE/1-hosting/daii.xnexustech.com/release-new/.claude/worktrees/vehicle-workspace/backend/dist/database/migrations/logistics';
(async () => {
  for (const db of ['daii_test_biz_t96_vw_co1']) {
    const c = new Client({ host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 5546), user: env.DB_USER || env.DB_USERNAME, password: env.DB_PASSWORD, database: db });
    await c.connect();
    const files = fs.readdirSync(dir).filter((f) => /^1790040[0-4]00000-.*\.js$/.test(f) && !f.endsWith('.d.ts')).sort();
    for (const f of files) {
      const mod = require(path.join(dir, f));
      const Cls = Object.values(mod)[0];
      const inst = new Cls();
      const done = await c.query('SELECT 1 FROM migrations WHERE name = $1', [inst.name]);
      if (done.rowCount) { console.log(db, 'already', inst.name); continue; }
      const qr = { query: (sql, p) => c.query(sql, p).then((r) => r.rows) };
      await inst.up(qr);
      const ts = Number(inst.name.match(/(\d{13})$/)[1]);
      await c.query('INSERT INTO migrations ("timestamp","name") VALUES ($1,$2)', [ts, inst.name]);
      console.log(db, 'applied', inst.name);
    }
    await c.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
