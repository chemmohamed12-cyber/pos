/** Adds a second admin user to the isolated browser-verification environment (maker/checker needs two distinct users). */
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';

const base = { type: 'postgres' as const, host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 5656), username: process.env.DB_USER ?? 'd3verify', password: process.env.DB_PASSWORD ?? 'x' };
const email = process.argv[2] ?? 'bv.approver@example.test';
const password = process.argv[3] ?? 'BvApprover#2026';

async function main() {
  const cp = new DataSource({ ...base, database: process.env.BV_CP_DB ?? 'bv_cp' });
  const co = new DataSource({ ...base, database: process.env.BV_CO_DB ?? 'bv_co' });
  await cp.initialize();
  await co.initialize();
  const companyId = (await cp.query(`SELECT id FROM companies LIMIT 1`))[0].id;
  const userId = randomUUID();
  await cp.query(`INSERT INTO "users" ("id","fullName","email","status") VALUES ($1,'BV Approver',$2,'active')`, [userId, email]);
  await cp.query(`INSERT INTO "credentials" ("userId","passwordHash","passwordChangedAt") VALUES ($1,$2,now())`, [userId, await bcrypt.hash(password, 10)]);
  await cp.query(`INSERT INTO "user_company_memberships" ("id","userId","companyId","roleKey") VALUES ($1,$2,$3,'admin')`, [randomUUID(), userId, companyId]);
  const cpRole = (await cp.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
  await cp.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), userId, cpRole.id]);
  const coRole = (await co.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
  await co.query(`INSERT INTO "users" ("id","fullName","email","status") VALUES ($1,'BV Approver',$2,'active')`, [userId, email]);
  await co.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3)`, [randomUUID(), userId, coRole.id]);
  console.log(JSON.stringify({ userId, email }));
  await cp.destroy();
  await co.destroy();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
