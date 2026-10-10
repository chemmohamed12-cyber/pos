import { DataSource } from 'typeorm';
import { BizEnv, abortBiz, approvedDoc, attempt, auditProbe, finishBiz, fp, fpDiff, onHand, receive, record, result, seedProduct, setUpBiz } from './biz-support';
import { reconcileAndRecord } from './biz-reconcile';
import { WAREHOUSE_TRANSACTION_PROCESS } from '../../domains/inventory-warehouse/domain/warehouse-transaction-process';

/**
 * T-12 (G2: loss of the database connection in the middle of a document posting) — FROZEN in
 * docs/decisions/test-program/T-PLAN-FROZEN-2026-10-10.md. Fixture: an approved issue document (1 unit) on a disposable company database.
 * Steps: the posting transaction is held mid-flight (a second connection owns the document's advisory lock, so the posting connection waits INSIDE its
 * transaction); the posting backend is then terminated with pg_terminate_backend restricted to datname + a unique application_name + excluding our own pid,
 * and ONLY if exactly ONE backend matches (otherwise: no kill, STOP). Expected: no partial effect (movement + state together or nothing: here nothing);
 * the retry succeeds exactly once. Disposable databases `daii_test_biz_t12_*` only.
 */
describe('T-12 — a connection killed in the middle of a posting leaves no partial effect, and the retry posts exactly once', () => {
  jest.setTimeout(900_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('kill the posting backend while it waits inside its transaction', async () => {
    try {
      env = await setUpBiz('T-12', 'biz_t12');
      const e = env;
      const W = e.warehouseId;
      const P = await seedProduct(e.dsA, 'T12-P1');
      await receive(e, W, P, 5);
      const dbName = e.databases.find((d) => d.endsWith('_company_a'))!;

      for (let round = 1; round <= 3; round += 1) {
        const tag = `biz-t12-${e.run.runId}-r${round}`.slice(0, 60);
        const opts: any = e.dsA.options;
        const victim = new DataSource({ ...opts, extra: { ...(opts.extra ?? {}), max: 4, application_name: tag } });
        await victim.initialize();
        e.extraDataSources.push(victim);

        const doc = await approvedDoc(e, 'issue', W, [{ productId: P, quantity: 1 }]);
        const before = await fp(e);
        const onHandBefore = await onHand(e, W, P);

        // hold the document's advisory lock from another connection so the posting backend waits INSIDE its transaction
        const holder = e.dsA.createQueryRunner();
        await holder.connect();
        await holder.startTransaction();
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`warehouse_transaction_post:${doc}`]);

        const posting = attempt(() => e.whTx.transition(doc, 'post', e.actor, victim.manager));

        // wait (<= 20 s) until the posting backend is waiting on that lock
        let waiting = 0;
        for (let i = 0; i < 100 && waiting === 0; i += 1) {
          await new Promise((r) => setTimeout(r, 200));
          waiting = (await e.dsA.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = $2 AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`, [dbName, tag]))[0].n;
        }
        const matching = (await e.dsA.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = $2 AND pid <> pg_backend_pid()`, [dbName, tag]))[0].n;
        if (waiting !== 1 || matching < 1) {
          await holder.rollbackTransaction().catch(() => undefined);
          await holder.release();
          result(e, `T-12-R${round}`, 'STOP', JSON.stringify({ waiting, matching, note: 'the target backend was not identified uniquely; NO kill was issued' }));
          break;
        }
        // exactly one backend is WAITING; the kill is restricted to datname + application_name + not-self and is limited to waiting backends
        const killed = await e.dsA.query(
          `SELECT pg_terminate_backend(pid) AS t FROM pg_stat_activity WHERE datname = $1 AND application_name = $2 AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
          [dbName, tag],
        );
        const outcome = await posting;
        await holder.rollbackTransaction();
        await holder.release();

        const after = await fp(e);
        const onHandAfter = await onHand(e, W, P);
        const state = await e.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, 'warehouse_transaction', doc, e.manager);
        const movements = (await e.dsA.query(`SELECT count(*)::int AS n FROM stock_movements WHERE "referenceType" = 'warehouse_transaction' AND "referenceId" = $1`, [doc]))[0].n;
        const noPartial = fpDiff(before, after).length === 0 && onHandAfter === onHandBefore && movements === 0 && state === 'approved';
        record(e, `T-12-R${round}-kill.json`, { tag, waiting, matching, killedRows: killed.length, outcome, state, movements, onHandBefore, onHandAfter, fingerprintDiff: fpDiff(before, after) });
        const okKill = killed.length === 1 && !outcome.ok && noPartial;

        // retry on a fresh connection: posts exactly once
        const retry = await attempt(() => e.whTx.transition(doc, 'post', e.actor, e.manager));
        const movementsAfter = (await e.dsA.query(`SELECT count(*)::int AS n FROM stock_movements WHERE "referenceType" = 'warehouse_transaction' AND "referenceId" = $1`, [doc]))[0].n;
        const stateAfter = await e.processEngine.getState(WAREHOUSE_TRANSACTION_PROCESS, 'warehouse_transaction', doc, e.manager);
        const okRetry = retry.ok && movementsAfter === 1 && stateAfter === 'posted' && (await onHand(e, W, P)) === onHandBefore - 1;
        result(e, `T-12-R${round}`, okKill && okRetry ? 'PASS' : 'STOP', JSON.stringify({ okKill, okRetry, killedRows: killed.length, outcome, retry, movementsAfter, stateAfter }));
        await victim.destroy().catch(() => undefined);
        if (!(okKill && okRetry)) break;
      }

      await auditProbe(e, 'final');
      await reconcileAndRecord(e, {});
      await finishBiz(e);
      expect(e.results.filter((r) => r.status === 'FAIL' || r.status === 'STOP')).toEqual([]);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
