require('./db-guard-register'); // DB guard (M-R2 §11): default deny, all layers — must run before any database import
import { runMigrationsForDatabase } from '../../src/foundation/release-orchestration/company-migration-runner';
const TAGS = ['core', 'sales', 'inventory', 'logistics', 'finance', 'hr', 'procurement', 'accounting', 'manufacturing', 'attendance', 'commission', 'payroll', 'targets'];
runMigrationsForDatabase(process.cwd(), { host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 5656), username: process.env.DB_USER ?? 'd3verify', password: process.env.DB_PASSWORD ?? 'x', database: process.env.BV_CP_DB ?? 'bv_cp' }, TAGS).then((r) => {
  console.log(JSON.stringify(r).slice(0, 300));
  process.exit(r.success ? 0 : 1);
});
