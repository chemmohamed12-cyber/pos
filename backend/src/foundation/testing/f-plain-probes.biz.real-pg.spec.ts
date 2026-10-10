import { randomUUID } from 'crypto';
import { abortBiz, attempt, finishBiz, record, result, tally, widePool } from './biz-support';
import { FinEnv, setUpFinance } from './biz-finance-support';
import { CustomersService } from '../../domains/crm/application/customers.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { NumberingService } from '../numbering/numbering.service';
import { ProcessDefinition } from '../process-engine/process-definition';

/**
 * PLAIN-MANAGER PROBES (informational — OUTSIDE the frozen T-xx set; they never change a frozen verdict; NO product code is changed by this file).
 * Question: do the two shared foundation primitives that use `manager ? run(manager) : dataSource.transaction(run)` keep their guarantees when a controller
 * hands them `req.companyContext.dataSource.manager` (a manager with NO open transaction)?
 *   N) NumberingService.getNextNumber — `SELECT … FOR UPDATE` then `UPDATE … SET lastNumber = <computed>`; with a plain manager the row lock is released at once.
 *   P) ProcessEngineService.transition — `SELECT … FOR UPDATE` then `UPDATE currentState`; same hazard.
 * Each is measured with (A) a plain manager and (B) the same call inside manager.transaction. Result is a measurement of the VERIFIED behaviour
 * (PASS = guarantee held, FAIL-DEFECT = guarantee violated), used to classify risk — not to demand a change.
 * Disposable databases `daii_test_biz_t17_*` only.
 */
describe('Plain-manager probes — numbering and process-engine', () => {
  jest.setTimeout(900_000);
  let env: FinEnv | undefined;
  let failure: unknown;
  afterAll(async () => {
    if (env) await abortBiz(env, failure);
  });

  it('records the behaviour of both primitives under concurrency', async () => {
    try {
      env = await setUpFinance('T-17', 'biz_t17');
      const e = env;
      const wide = await widePool(e, 40);
      const numbering = new NumberingService(e.h.controlPlane);
      await numbering.registerDocumentType('PROBE_PLAIN', 'PP', false, e.manager);
      await numbering.registerDocumentType('PROBE_TX', 'PT', false, e.manager);

      // ---- N) numbering ----
      const rounds = 10; const concurrent = 20;
      const dup = { plain: 0, transaction: 0 };
      const outcomes: Record<string, unknown[]> = { plain: [], transaction: [] };
      for (const style of ['plain', 'transaction'] as const) {
        const type = style === 'plain' ? 'PROBE_PLAIN' : 'PROBE_TX';
        for (let r = 0; r < rounds; r += 1) {
          const nums = await Promise.all(Array.from({ length: concurrent }, () => (style === 'plain'
            ? numbering.getNextNumber(type, wide.manager)
            : wide.manager.transaction((tx) => numbering.getNextNumber(type, tx))).then((n) => n, (err) => `ERR:${String(err?.message ?? err).slice(0, 40)}`)));
          const distinct = new Set(nums).size;
          if (distinct !== nums.length) dup[style] += 1;
          outcomes[style].push({ round: r, issued: nums.length, distinct });
        }
      }
      const finalPlain = (await e.dsA.query(`SELECT "lastNumber" FROM numbering_sequences WHERE "documentType" = 'PROBE_PLAIN'`))[0].lastNumber;
      const finalTx = (await e.dsA.query(`SELECT "lastNumber" FROM numbering_sequences WHERE "documentType" = 'PROBE_TX'`))[0].lastNumber;
      record(e, 'N-numbering.json', { rounds, concurrent, roundsWithDuplicateNumbers: dup, lastNumberAfter: { plain: finalPlain, transaction: finalTx }, expected: rounds * concurrent, outcomes });
      result(e, 'N-A-plain-manager', dup.plain === 0 && Number(finalPlain) === rounds * concurrent ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ roundsWithDuplicates: dup.plain, lastNumber: finalPlain, expected: rounds * concurrent }));
      result(e, 'N-B-transaction-manager', dup.transaction === 0 && Number(finalTx) === rounds * concurrent ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ roundsWithDuplicates: dup.transaction, lastNumber: finalTx, expected: rounds * concurrent }));

      // ---- P) process engine ----
      const def: ProcessDefinition = { key: 'probe_flow', initialState: 'a', transitions: [{ from: 'a', to: 'b', action: 'go' }, { from: 'b', to: 'c', action: 'go' }] };
      const prounds = 15; const pconc = 8;
      const pstats = { plain: { multiWin: 0, wins: [] as number[], extraHistory: 0 }, transaction: { multiWin: 0, wins: [] as number[], extraHistory: 0 } };
      for (const style of ['plain', 'transaction'] as const) {
        for (let r = 0; r < prounds; r += 1) {
          const id = randomUUID();
          await e.processEngine.start(def, 'probe', id, e.manager);
          const outs = await Promise.all(Array.from({ length: pconc }, () => attempt(() => (style === 'plain'
            ? e.processEngine.transition(def, 'probe', id, 'go', e.actor, wide.manager)
            : wide.manager.transaction((tx) => e.processEngine.transition(def, 'probe', id, 'go', e.actor, tx))))));
          const wins = outs.filter((o) => o.ok).length;
          const hist = (await e.dsA.query(`SELECT count(*)::int AS n FROM process_transition_records WHERE "processInstanceId" = (SELECT id FROM process_instances WHERE "definitionKey" = 'probe_flow' AND "entityId" = $1)`, [id]))[0].n;
          // from 'a' the legal path is a->b then b->c: a perfectly serialised run lets at most 2 of the identical 'go' requests succeed (a->b, b->c), the rest get 409
          pstats[style].wins.push(wins);
          if (wins > 2 || hist !== wins) pstats[style].multiWin += 1;
          void tally;
        }
      }
      record(e, 'P-process-engine.json', { prounds, pconc, pstats, note: 'serialised behaviour = at most 2 successes (a->b, b->c) and history rows = successes' });
      result(e, 'P-A-plain-manager', pstats.plain.multiWin === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ roundsViolating: pstats.plain.multiWin, wins: pstats.plain.wins }));
      result(e, 'P-B-transaction-manager', pstats.transaction.multiWin === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ roundsViolating: pstats.transaction.multiWin, wins: pstats.transaction.wins }));
      // ---- C) production call shape: CustomersService.createCustomer(dto, user, req.companyContext.dataSource.manager) — numbering is called with the caller's manager, the insert in a separate transaction ----
      const authz = new AuthorizationService(e.dsA.getRepository(Role), e.dsA.getRepository(UserRole));
      const limitsStub = { check: async () => ({ allowed: true, max: null }), consume: async () => ({ allowed: true, max: null }) } as never;
      const customers = new CustomersService(e.h.controlPlane, numbering, {} as never, e.audit, e.events, authz, {} as never, limitsStub);
      await numbering.registerDocumentType('customer', 'CUS', false, e.manager);
      const cstats = { plain: { ok: 0, errors: {} as Record<string, number>, distinctCodes: 0, rounds: 0 }, transaction: { ok: 0, errors: {} as Record<string, number>, distinctCodes: 0, rounds: 0 } };
      const crounds = 8; const cconc = 15;
      for (const style of ['plain', 'transaction'] as const) {
        for (let r = 0; r < crounds; r += 1) {
          const settled = await Promise.allSettled(Array.from({ length: cconc }, (_, i) => (style === 'plain'
            ? customers.createCustomer({ name: `probe-${style}-${r}-${i}` } as never, e.actor, wide.manager)
            : wide.manager.transaction((tx) => customers.createCustomer({ name: `probe-${style}-${r}-${i}` } as never, e.actor, tx)))));
          const codes = new Set<string>();
          for (const s of settled) {
            if (s.status === 'fulfilled') { cstats[style].ok += 1; codes.add((s.value as { code: string }).code); }
            else { const k = `${(s.reason as { code?: string; name?: string })?.code ?? (s.reason as Error)?.name ?? 'error'}`; cstats[style].errors[k] = (cstats[style].errors[k] ?? 0) + 1; }
          }
          cstats[style].distinctCodes += codes.size; cstats[style].rounds += 1;
        }
      }
      const expectedC = crounds * cconc;
      record(e, 'C-customer-create.json', { crounds, cconc, expectedPerStyle: expectedC, cstats });
      result(e, 'C-A-plain-manager', cstats.plain.ok === expectedC ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ succeeded: cstats.plain.ok, of: expectedC, errors: cstats.plain.errors }));
      result(e, 'C-B-transaction-manager', cstats.transaction.ok === expectedC ? 'PASS' : 'FAIL-DEFECT', JSON.stringify({ succeeded: cstats.transaction.ok, of: expectedC, errors: cstats.transaction.errors }));
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
