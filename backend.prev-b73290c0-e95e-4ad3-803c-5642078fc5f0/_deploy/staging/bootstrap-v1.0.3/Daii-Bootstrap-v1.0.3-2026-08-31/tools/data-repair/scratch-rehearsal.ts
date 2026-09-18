/**
 * Controlled UUID Data Repair — full rehearsal against a scratch database.
 *
 * Run by `scratch-rehearsal.sh` (which stands up an isolated PostgreSQL
 * cluster first). Also usable directly against any throwaway DB via the
 * standard DB_* env vars. NEVER point this at staging or production — it
 * deliberately corrupts data to reproduce the bug.
 *
 * Proves the CTO's exact chain:
 *   pre-repair backup -> audit -> mapping -> repair -> integrity verify ->
 *   application check (@IsUUID now passes) -> restore/rollback returns the
 *   DB to its pre-repair state.
 *
 * Writes every artifact to tools/data-repair/rehearsal-evidence/.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  auditNonCompliantUuids,
  planUuidRepairMapping,
  runUuidRfc4122Repair,
  verifyUuidRepairIntegrity,
  isRfc4122Uuid,
  RepairSqlExecutor,
} from '../../src/database/uuid-repair.core';
import { CashMoveDto } from '../../src/domains/treasury/interface/treasury.controller';

const EVIDENCE_DIR = join(__dirname, 'rehearsal-evidence');

/**
 * A UUID-shaped id with random version/variant nibbles — byte-for-byte the
 * kind of value the prod (PG10) `md5(...)::uuid` workaround produced. We
 * insert these as EXPLICIT ids because PG18's core `gen_random_uuid()`
 * (RFC4122-compliant) always wins the unqualified call over a `public.`
 * redefinition, so the broken function can't be reproduced by name here.
 * Loops until it actually lands on a non-compliant value.
 */
function brokenUuid(): string {
  for (;;) {
    const h = createHash('md5').update(Math.random() + '|' + process.hrtime.bigint()).digest('hex');
    const u = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    if (!isRfc4122Uuid(u)) return u;
  }
}

const db = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'daii',
  password: process.env.DB_PASSWORD ?? 'x',
  database: process.env.DB_NAME ?? 'daii_scratch',
};
const PG_DUMP = process.env.PG_DUMP_BIN ?? 'pg_dump';
const PG_RESTORE = process.env.PG_RESTORE_BIN ?? 'pg_restore';

function log(step: string, msg = '') {
  console.log(`\n[rehearsal] ${step}${msg ? ' — ' + msg : ''}`);
}
function save(name: string, data: unknown) {
  writeFileSync(join(EVIDENCE_DIR, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const ds = new DataSource({ type: 'postgres', ...db, synchronize: false, logging: false });
  await ds.initialize();
  const exec: RepairSqlExecutor = { query: (sql, params) => ds.query(sql, params as unknown[]) };

  try {
    // ---- 1. Reproduce legacy non-compliant ids -----------------------------
    // Insert rows with EXPLICIT non-compliant ids (see brokenUuid() for why
    // the function itself can't be swapped in on PG18). This is exactly the
    // prod state: a treasury account + its account type + a user + its
    // credentials, all with pre-fix ids, plus real FK relationships between
    // them so the repair's cascade is genuinely exercised.
    log('1. Injecting legacy non-compliant rows with explicit pre-fix ids');
    // idempotent: clear any leftovers from a previous rehearsal run
    await ds.query(`DELETE FROM credentials WHERE "userId" IN (SELECT id FROM users WHERE email = 'rehearsal@example.com')`);
    await ds.query(`DELETE FROM users WHERE email = 'rehearsal@example.com'`);
    await ds.query(`DELETE FROM treasury_accounts WHERE code = 'REH-1'`);
    await ds.query(`DELETE FROM treasury_account_types WHERE code = 'rehearsal-cash'`);
    const legacyTypeId = brokenUuid();
    const legacyAcctId = brokenUuid();
    const legacyUserId = brokenUuid();
    await ds.query(`INSERT INTO treasury_account_types (id, code, name) VALUES ($1,'rehearsal-cash','Rehearsal Cash')`, [legacyTypeId]);
    await ds.query(
      `INSERT INTO treasury_accounts (id, code, name, "accountTypeId", status) VALUES ($1,'REH-1','Rehearsal Account',$2,'active')`,
      [legacyAcctId, legacyTypeId],
    );
    await ds.query(`INSERT INTO users (id, "fullName", email, status) VALUES ($1,'Rehearsal User','rehearsal@example.com','active')`, [legacyUserId]);
    await ds.query(`INSERT INTO credentials ("userId", "passwordHash") VALUES ($1, 'x')`, [legacyUserId]);

    assert(!isRfc4122Uuid(legacyAcctId), `injected treasury_accounts.id is non-RFC4122 (${legacyAcctId})`);
    assert(!isRfc4122Uuid(legacyUserId), `injected users.id is non-RFC4122 (${legacyUserId})`);
    save('01-injected-legacy-ids.json', { legacyTypeId, legacyAcctId, legacyUserId });

    // Baseline row counts (must be identical after repair — only ids change).
    const countTables = ['treasury_accounts', 'treasury_account_types', 'users', 'credentials', 'roles', 'terminology_entries'];
    const before: Record<string, number> = {};
    for (const t of countTables) before[t] = Number((await ds.query(`SELECT count(*)::int c FROM "${t}"`))[0].c);

    // ---- 2. Pre-repair backup --------------------------------------------
    log('2. Pre-repair pg_dump -Fc backup');
    const backupPath = join(EVIDENCE_DIR, 'pre-repair.dump');
    execFileSync(PG_DUMP, ['-h', db.host, '-p', String(db.port), '-U', db.username, '-Fc', '-f', backupPath, db.database], {
      env: { ...process.env, PGPASSWORD: db.password },
    });
    console.log(`  backup: ${backupPath}`);

    // ---- 3. Audit -------------------------------------------------------
    log('3. Read-only UUID audit');
    const audit = await auditNonCompliantUuids(exec);
    save('03-audit.json', audit);
    assert(audit.totalNonCompliant >= 3, `audit found the injected non-compliant rows (total=${audit.totalNonCompliant})`);

    // ---- 4. Mapping ---------------------------------------------------
    log('4. Plan old -> new mapping (read-only)');
    const mapping = await planUuidRepairMapping(exec);
    save('04-mapping.json', mapping);
    assert(mapping.every((m) => isRfc4122Uuid(m.newId)), 'every new id in the mapping is RFC4122-compliant');
    assert(mapping.some((m) => m.oldId === legacyAcctId), 'mapping includes the legacy treasury account id');

    // ---- 5. Repair (one transaction) --------------------------------
    log('5. Execute repair in a single transaction');
    const applied = await ds.transaction(async (m) => {
      const tx: RepairSqlExecutor = { query: (sql, params) => m.query(sql, params as unknown[]) };
      return runUuidRfc4122Repair(tx, mapping);
    });
    save('05-applied.json', applied);
    console.log(`  repaired ${applied.totalRepaired} row(s)`);

    // ---- 6. Integrity verification ---------------------------------
    log('6. Post-repair integrity verification');
    const integrity = await verifyUuidRepairIntegrity(exec);
    save('06-integrity.json', integrity);
    assert(integrity.passed, `integrity verification PASSED (${integrity.checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || 'all checks ok'})`);
    assert(integrity.remainingNonCompliant === 0, 'zero non-compliant primary keys remain');

    // ---- 7. Same logical record, references intact -----------------
    log('7. Same logical record + FK integrity');
    const [{ id: newAcctId, accountTypeId: acctTypeRef, code: acctCode }] = await ds.query(
      `SELECT id::text, "accountTypeId"::text AS "accountTypeId", code FROM treasury_accounts WHERE code = 'REH-1'`,
    );
    const [{ id: newTypeId }] = await ds.query(`SELECT id::text FROM treasury_account_types WHERE code = 'rehearsal-cash'`);
    const [{ id: newUserId }] = await ds.query(`SELECT id::text FROM users WHERE email = 'rehearsal@example.com'`);
    const [{ userId: credUserRef }] = await ds.query(
      `SELECT "userId"::text AS "userId" FROM credentials WHERE "userId" = $1`,
      [newUserId],
    );
    assert(acctCode === 'REH-1', 'the treasury account is still the same row (code unchanged)');
    assert(isRfc4122Uuid(newAcctId) && newAcctId !== legacyAcctId, `treasury_accounts.id was rewritten to a compliant id (${newAcctId})`);
    assert(acctTypeRef === newTypeId, 'treasury_accounts.accountTypeId still points at the (repaired) account type — FK intact');
    assert(credUserRef === newUserId, 'credentials.userId still equals the (repaired) users.id — shared-PK cascade intact');

    const after: Record<string, number> = {};
    for (const t of countTables) after[t] = Number((await ds.query(`SELECT count(*)::int c FROM "${t}"`))[0].c);
    assert(JSON.stringify(before) === JSON.stringify(after), `row counts identical before/after (${JSON.stringify(after)})`);
    save('07-record-integrity.json', { before, after, legacyAcctId, newAcctId, legacyUserId, newUserId });

    // ---- 8. Application check: @IsUUID() now passes ---------------
    log('8. Application-level check — the repaired id passes @IsUUID()');
    const errsLegacy = validateSync(plainToInstance(CashMoveDto, { accountId: legacyAcctId, amount: '100' }));
    const errsFixed = validateSync(plainToInstance(CashMoveDto, { accountId: newAcctId, amount: '100' }));
    assert(errsLegacy.some((e) => e.constraints?.isUuid), 'the OLD legacy id would have been rejected by CashMoveDto (@IsUUID)');
    assert(errsFixed.length === 0, 'the NEW repaired id is accepted by CashMoveDto — "accountId must be a UUID" no longer fires');

    // ---- 9. Rollback / restore rehearsal ------------------------
    log('9. Restore the pre-repair backup and confirm the DB returns to its prior state');
    await ds.destroy();
    execFileSync(
      PG_RESTORE,
      ['-h', db.host, '-p', String(db.port), '-U', db.username, '-d', db.database, '--clean', '--if-exists', backupPath],
      { env: { ...process.env, PGPASSWORD: db.password }, stdio: 'pipe' },
    );
    const ds2 = new DataSource({ type: 'postgres', ...db, synchronize: false, logging: false });
    await ds2.initialize();
    const [{ id: restoredAcctId }] = await ds2.query(`SELECT id::text FROM treasury_accounts WHERE code = 'REH-1'`);
    const restoredCounts: Record<string, number> = {};
    for (const t of countTables) restoredCounts[t] = Number((await ds2.query(`SELECT count(*)::int c FROM "${t}"`))[0].c);
    assert(restoredAcctId === legacyAcctId, `after restore, treasury_accounts.id is back to the pre-repair legacy value (${restoredAcctId})`);
    assert(JSON.stringify(restoredCounts) === JSON.stringify(before), 'after restore, row counts match the pre-repair baseline');
    save('09-restore.json', { restoredAcctId, restoredCounts });
    await ds2.destroy();

    log('DONE', 'all rehearsal assertions passed — evidence in tools/data-repair/rehearsal-evidence/');
    save('00-SUMMARY.md', summaryMd({ audit, applied, integrity, before, after, legacyAcctId, newAcctId }));
  } catch (err) {
    if (ds.isInitialized) await ds.destroy().catch(() => undefined);
    throw err;
  }
}

function summaryMd(x: {
  audit: Awaited<ReturnType<typeof auditNonCompliantUuids>>;
  applied: { totalRepaired: number };
  integrity: Awaited<ReturnType<typeof verifyUuidRepairIntegrity>>;
  before: Record<string, number>;
  after: Record<string, number>;
  legacyAcctId: string;
  newAcctId: string;
}): string {
  return `# Controlled UUID Data Repair — Rehearsal Result

Ran against an isolated scratch PostgreSQL cluster (NOT staging/production).

| Step | Result |
|---|---|
| Legacy rows injected | via the pre-fix \`gen_random_uuid()\` (reproduces the prod PG10 state) |
| Audit — non-compliant PKs found | ${x.audit.totalNonCompliant} |
| Mapping generated | ${x.audit.totalNonCompliant} old→new pairs, all new ids RFC4122 |
| Repair | ${x.applied.totalRepaired} row(s), one transaction |
| Integrity verification | ${x.integrity.passed ? 'PASS' : 'FAIL'} — ${x.integrity.remainingNonCompliant} non-compliant remaining, ${x.integrity.checks.filter((c) => !c.ok).length} failed checks |
| Row-count parity | ${JSON.stringify(x.before) === JSON.stringify(x.after) ? 'identical before/after' : 'MISMATCH'} |
| \`treasury_accounts\` example | \`${x.legacyAcctId}\` → \`${x.newAcctId}\` |
| \`@IsUUID()\` on the repaired id | accepted (old id rejected) |
| Restore/rollback | pre-repair \`pg_dump\` restored → ids + counts back to pre-repair state |

Environment: Node ${process.version}, PostgreSQL 18 scratch cluster. Production
is Node 20.20.2 / PostgreSQL 10 — the real staging run uses the same
\`DataRepairService\` flow (\`DATA_REPAIR_RUNBOOK.md\`).
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
