import { randomUUID } from 'crypto';
import { LimitService } from '../limit-engine/limit.service';
import { LimitProfile } from '../limit-engine/limit-profile.entity';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';
import { CustomersService } from '../../domains/crm/application/customers.service';
import { HrService } from '../../domains/hr/application/hr.service';
import { BizEnv, abortBiz, attempt, finishBiz, onHand, receive, record, result, seedProduct, seedWarehouse, setUpBiz, tally, widePool } from './biz-support';

/**
 * T-30 — WP-INV-09: N-02 sibling probes (TEST-ONLY; spec: DAII-N02-SIBLING-PROBES-AND-H5-FIXTURE-TEST-SPECIFICATION-2026-10-11 §2, authorised by the CTO decision of 2026-10-11, item 6).
 * It MEASURES and changes no product logic. A PASS is a measurement of the tested shape only; a FAIL-DEFECT is a CANDIDATE defect for the CTO to judge (a change needs its own authorisation).
 * Each probe has its own report row. Every concurrent probe is run in both calling styles: A) the plain manager a controller passes, B) the same call inside `manager.transaction`.
 *   S1  InventoryService.relocateReservedStock        (A/B concurrency, rollback, forced partial failure, opposite-direction concurrency with a reserving operation)
 *   S2  InventoryService.releaseReservedQuantityForReference (A/B concurrency, rollback)   — sibling of releaseReservedQuantity, which N-02/H2 already moved to runInTransaction
 *   S3  InventoryService.releaseReservation           (A/B concurrency on one reservation id)
 *   S4  limit-gated creation paths as the service is really called: CustomersService.createCustomer (sales.max_customers) and HrService.createEmployee (hr.max_employees)
 * S3-C/D (release versus fulfil on one reservation; rollback of a release) were added with the C14 remediation (`inventory.service.ts`: relocateReservedStock, releaseReservedQuantityForReference and releaseReservation now run in one
 * transaction via `runInTransaction`, and releaseReservation locks the same per-(warehouse,product) key as the other reservation operations). Before that change the six cases S1-A, S1-C-A, S1-D-A, S2-A, S3-A, S3-B were FAIL-DEFECT (evidence `d68fd10-t30-sibling-probes/`).
 * S5 (reach analysis: which callers pass a plain manager) is documentation and lives in DAII-N02-SIBLING-PROBES-RESULTS-2026-10-14.md.
 * Disposable databases `daii_test_biz_t30_*` only (the DB guard refuses anything else).
 */
describe('T-30 — N-02 sibling probes (WP-INV-09): relocation, reference release, whole-reservation release, limit-gated creation', () => {
  jest.setTimeout(1_800_000);
  let env: (BizEnv & { warehouseId: string }) | undefined;
  let failure: unknown;
  afterAll(async () => { if (env) await abortBiz(env, failure); });

  it('S1-S4: concurrency, rollback, partial failure, integrity — both calling styles', async () => {
    try {
      env = await setUpBiz('T-30', 'biz_t30', { tags: ['sales', 'inventory', 'finance', 'procurement', 'accounting', 'hr'] });
      const e = env;
      const wide = await widePool(e, 40);
      const W1 = e.warehouseId;
      const detail: Record<string, unknown> = {};
      const sum = async (sql: string, params: unknown[]) => Number((await e.dsA.query(sql, params))[0].n);
      const activeQty = (so: string, wh: string) => sum(`SELECT coalesce(sum(quantity),0)::int AS n FROM stock_reservations WHERE "salesOrderId" = $1 AND "warehouseId" = $2 AND status = 'active'`, [so, wh]);
      const activeQtyRef = (ref: string, wh: string) => sum(`SELECT coalesce(sum(quantity),0)::int AS n FROM stock_reservations WHERE "referenceId" = $1 AND "warehouseId" = $2 AND status = 'active'`, [ref, wh]);
      const movements = (p: string, type: string) => sum(`SELECT count(*)::int AS n FROM stock_movements WHERE "productId" = $1 AND "movementType" = $2`, [p, type]);
      const audits = (action: string, resourceLike: string) => sum(`SELECT count(*)::int AS n FROM audit_records WHERE action = $1 AND "resourceId" LIKE $2`, [action, resourceLike]);
      const reservationRows = async (so: string) => JSON.stringify(await e.dsA.query(`SELECT "warehouseId", quantity, status FROM stock_reservations WHERE "salesOrderId" = $1 ORDER BY "warehouseId", status, quantity`, [so]));
      // negative on-hand pairs for ONE product (a database-wide count would carry an earlier probe's defect into every later case)
      const negPairs = (p: string) => sum(`SELECT count(*)::int AS n FROM (SELECT 1 FROM stock_movements WHERE "productId" = $1 GROUP BY "warehouseId" HAVING SUM(quantity) < 0) x`, [p]);
      const styles = ['plain', 'transaction'] as const;
      const label = (s: (typeof styles)[number]) => (s === 'plain' ? 'A-plain-manager' : 'B-transaction-manager');

      // ================= S1-A/B relocateReservedStock — 8 concurrent relocations of 1 unit against 5 reserved =================
      for (const style of styles) {
        // four independent rounds per style: the plain-manager race is probabilistic, a single round can pass by luck; every round must conserve the reservation
        const rounds: Array<Record<string, unknown>> = [];
        let allSafe = true;
        for (let round = 0; round < 4; round += 1) {
          const P = await seedProduct(e.dsA, `T30-S1-${style}-${round}`);
          const W2 = await seedWarehouse(e.dsA, `T30-S1-${style}-${round}`);
          await receive(e, W1, P, 5);
          const so = randomUUID();
          await e.inventory.reserveStock(W1, P, 5, so, e.actor, 'active', e.manager);
          const refs = Array.from({ length: 8 }, () => randomUUID());
          const outs = await Promise.all(refs.map((ref) => attempt(() => (style === 'plain'
            ? e.inventory.relocateReservedStock(so, P, W1, W2, 1, 'probe', ref, e.actor, wide.manager)
            : wide.manager.transaction((tx) => e.inventory.relocateReservedStock(so, P, W1, W2, 1, 'probe', ref, e.actor, tx))))));
          const ok = outs.filter((o) => o.ok).length;
          const d = {
            round, reserved: 5, calls: 8, ok, tally: tally(outs), activeAtW1: await activeQty(so, W1), activeAtW2: await activeQty(so, W2),
            onHandW1: await onHand(e, W1, P), onHandW2: await onHand(e, W2, P), transferOut: await movements(P, 'transfer_out'), transferIn: await movements(P, 'transfer_in'),
            auditRows: await sum(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'inventory.reservation.relocated' AND after->>'productId' = $1`, [P]), negativeStock: await negPairs(P),
          };
          const safe = ok === 5 && (d.tally['ConflictException:409'] ?? 0) === 3 && d.activeAtW1 === 0 && d.activeAtW2 === 5 && d.onHandW1 === 0 && d.onHandW2 === 5 && d.transferOut === 5 && d.transferIn === 5 && d.auditRows === 5 && d.negativeStock === 0;
          allSafe = allSafe && safe;
          rounds.push(d);
        }
        detail[`S1-${style}`] = rounds;
        result(e, `S1-${label(style)}-concurrent-relocation-conserves-reservation`, allSafe ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(rounds));
      }

      // ================= S1-C relocateReservedStock — rollback and forced partial failure =================
      {
        const P = await seedProduct(e.dsA, 'T30-S1C-rollback');
        const W2 = await seedWarehouse(e.dsA, 'T30-S1C-rollback');
        await receive(e, W1, P, 5);
        const so = randomUUID();
        await e.inventory.reserveStock(W1, P, 5, so, e.actor, 'active', e.manager);
        const before = { rows: await reservationRows(so), out: await movements(P, 'transfer_out'), aud: await sum(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'inventory.reservation.relocated' AND after->>'productId' = $1`, [P]) };
        const out = await attempt(() => wide.manager.transaction(async (tx) => { await e.inventory.relocateReservedStock(so, P, W1, W2, 2, 'probe', randomUUID(), e.actor, tx); throw new Error('forced rollback'); }));
        const after = { rows: await reservationRows(so), out: await movements(P, 'transfer_out'), aud: await sum(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'inventory.reservation.relocated' AND after->>'productId' = $1`, [P]) };
        detail['S1-C-rollback'] = { rolledBack: !out.ok, before, after };
        result(e, 'S1-C-outer-rollback-restores-reservation-movements-audit', !out.ok && before.rows === after.rows && before.out === after.out && before.aud === after.aud ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['S1-C-rollback']));
      }
      for (const style of styles) {
        // a destination warehouse that does not exist: the reservation rows or the transfer must refuse, and nothing may be left half-done
        const P = await seedProduct(e.dsA, `T30-S1C-partial-${style}`);
        await receive(e, W1, P, 5);
        const so = randomUUID();
        await e.inventory.reserveStock(W1, P, 5, so, e.actor, 'active', e.manager);
        const ghost = randomUUID();
        const before = { rows: await reservationRows(so), out: await movements(P, 'transfer_out'), inn: await movements(P, 'transfer_in'), onHand: await onHand(e, W1, P) };
        const out = await attempt(() => (style === 'plain'
          ? e.inventory.relocateReservedStock(so, P, W1, ghost, 2, 'probe', randomUUID(), e.actor, wide.manager)
          : wide.manager.transaction((tx) => e.inventory.relocateReservedStock(so, P, W1, ghost, 2, 'probe', randomUUID(), e.actor, tx))));
        const after = { rows: await reservationRows(so), out: await movements(P, 'transfer_out'), inn: await movements(P, 'transfer_in'), onHand: await onHand(e, W1, P) };
        const ghostRows = await sum(`SELECT count(*)::int AS n FROM stock_reservations WHERE "warehouseId" = $1`, [ghost]);
        detail[`S1-C-partial-${style}`] = { refused: !out.ok, outcome: out, before, after, reservationsAtMissingWarehouse: ghostRows };
        result(e, `S1-C-${label(style)}-failed-relocation-is-all-or-nothing`, !out.ok && before.rows === after.rows && before.out === after.out && before.inn === after.inn && before.onHand === after.onHand && ghostRows === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail[`S1-C-partial-${style}`]));
      }

      // ================= S1-D relocateReservedStock — opposite-direction concurrency with a reserving operation =================
      for (const style of styles) {
        const P = await seedProduct(e.dsA, `T30-S1D-${style}`);
        const W2 = await seedWarehouse(e.dsA, `T30-S1D-${style}`);
        await receive(e, W1, P, 10);
        await receive(e, W2, P, 10);
        const o1 = randomUUID(); const o2 = randomUUID(); const o3 = randomUUID();
        await e.inventory.reserveStock(W1, P, 5, o1, e.actor, 'active', e.manager);
        await e.inventory.reserveStock(W2, P, 5, o2, e.actor, 'active', e.manager);
        const call = (fn: (m: import('typeorm').EntityManager) => Promise<unknown>) => attempt(() => (style === 'plain' ? fn(wide.manager) : wide.manager.transaction((tx) => fn(tx))));
        const jobs = [
          ...Array.from({ length: 6 }, () => call((m) => e.inventory.relocateReservedStock(o1, P, W1, W2, 1, 'probe', randomUUID(), e.actor, m))),
          ...Array.from({ length: 6 }, () => call((m) => e.inventory.relocateReservedStock(o2, P, W2, W1, 1, 'probe', randomUUID(), e.actor, m))),
          ...Array.from({ length: 4 }, () => call((m) => e.inventory.reserveStock(W1, P, 1, o3, e.actor, 'active', m))),
        ];
        const outs = await Promise.all(jobs);
        const t = tally(outs);
        const unexpected = outs.filter((o) => !o.ok && o.kind !== 'ConflictException:409');
        const d = {
          tally: t, deadlocks: outs.filter((o) => o.pgCode === '40P01').length, unexpectedFailures: unexpected.map((o) => ({ kind: o.kind, pgCode: o.pgCode })),
          o1Total: (await activeQty(o1, W1)) + (await activeQty(o1, W2)), o2Total: (await activeQty(o2, W1)) + (await activeQty(o2, W2)),
          o3Reserved: (await activeQty(o3, W1)) + (await activeQty(o3, W2)), onHandTotal: (await onHand(e, W1, P)) + (await onHand(e, W2, P)), negativeStock: await negPairs(P),
        };
        detail[`S1-D-${style}`] = d;
        const reserveOk = outs.slice(12).filter((o) => o.ok).length;
        result(e, `S1-D-${label(style)}-opposite-relocations-and-reserve`, d.deadlocks === 0 && unexpected.length === 0 && d.o1Total === 5 && d.o2Total === 5 && d.o3Reserved === reserveOk && d.onHandTotal === 20 && d.negativeStock === 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(d));
      }

      // ================= S2 releaseReservedQuantityForReference =================
      const reserveForRef = async (P: string, ref: string, qty: number) => e.dsA.transaction((tx) => e.inventory.reserveStockForReferenceInTransaction(tx, W1, P, qty, 'WORK_ORDER', ref, e.actor, 'active'));
      for (const style of styles) {
        const P = await seedProduct(e.dsA, `T30-S2-${style}`);
        await receive(e, W1, P, 50);
        const ref = randomUUID();
        await reserveForRef(P, ref, 5);
        const before = await onHand(e, W1, P);
        const outs = await Promise.all(Array.from({ length: 12 }, () => attempt(() => (style === 'plain'
          ? e.inventory.releaseReservedQuantityForReference('WORK_ORDER', ref, P, W1, 1, e.actor, wide.manager)
          : wide.manager.transaction((tx) => e.inventory.releaseReservedQuantityForReference('WORK_ORDER', ref, P, W1, 1, e.actor, tx))))));
        const ok = outs.filter((o) => o.ok).length;
        const d = {
          reserved: 5, calls: 12, ok, tally: tally(outs), stillActive: await activeQtyRef(ref, W1), onHandDelta: (await onHand(e, W1, P)) - before,
          auditRows: await audits('inventory.reservation.partially_released', `WORK_ORDER:${ref}:%`),
        };
        detail[`S2-${style}`] = d;
        result(e, `S2-${label(style)}-concurrent-reference-release-never-exceeds-reserved`, ok === 5 && (d.tally['ConflictException:409'] ?? 0) === 7 && d.stillActive === 0 && d.onHandDelta === 0 && d.auditRows === 5 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(d));
      }
      {
        const P = await seedProduct(e.dsA, 'T30-S2-rollback');
        await receive(e, W1, P, 50);
        const ref = randomUUID();
        await reserveForRef(P, ref, 5);
        const out = await attempt(() => wide.manager.transaction(async (tx) => { await e.inventory.releaseReservedQuantityForReference('WORK_ORDER', ref, P, W1, 3, e.actor, tx); throw new Error('forced rollback'); }));
        const mid = await activeQtyRef(ref, W1);
        const again = await attempt(() => e.inventory.releaseReservedQuantityForReference('WORK_ORDER', ref, P, W1, 3, e.actor, wide.manager));
        detail['S2-rollback'] = { rolledBack: !out.ok, activeAfterRollback: mid, retryOk: again.ok, activeEnd: await activeQtyRef(ref, W1) };
        result(e, 'S2-C-outer-rollback-restores-reservation', !out.ok && mid === 5 && again.ok && (await activeQtyRef(ref, W1)) === 2 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['S2-rollback']));
      }

      // ================= S3 releaseReservation (whole reservation by id) =================
      for (const style of styles) {
        const P = await seedProduct(e.dsA, `T30-S3-${style}`);
        await receive(e, W1, P, 50);
        const so = randomUUID();
        const resv = await e.inventory.reserveStock(W1, P, 3, so, e.actor, 'active', e.manager);
        const outs = await Promise.all(Array.from({ length: 8 }, () => attempt(() => (style === 'plain'
          ? e.inventory.releaseReservation(resv.id, e.actor, wide.manager)
          : wide.manager.transaction((tx) => e.inventory.releaseReservation(resv.id, e.actor, tx))))));
        const ok = outs.filter((o) => o.ok).length;
        const d = {
          calls: 8, ok, tally: tally(outs), status: (await e.dsA.query(`SELECT status FROM stock_reservations WHERE id = $1`, [resv.id]))[0].status,
          releasedAuditRows: await audits('inventory.reservation.released', resv.id),
        };
        detail[`S3-${style}`] = d;
        result(e, `S3-${label(style)}-single-release-per-reservation`, ok === 1 && (d.tally['ConflictException:409'] ?? 0) === 7 && d.status === 'released' && d.releasedAuditRows === 1 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(d));
      }

      // ================= S3-C/D releaseReservation — competing operation and rollback (added with the C14 remediation) =================
      for (const style of styles) {
        // a release and a fulfilment of the SAME reservation race: exactly one wins and the other is refused; the ledger and the status must agree with the winner
        const P = await seedProduct(e.dsA, `T30-S3C-${style}`);
        await receive(e, W1, P, 50);
        const so = randomUUID();
        const resv = await e.inventory.reserveStock(W1, P, 3, so, e.actor, 'active', e.manager);
        const before = await onHand(e, W1, P);
        const jobs = [
          ...Array.from({ length: 4 }, () => attempt(() => (style === 'plain' ? e.inventory.releaseReservation(resv.id, e.actor, wide.manager) : wide.manager.transaction((tx) => e.inventory.releaseReservation(resv.id, e.actor, tx))))),
          ...Array.from({ length: 4 }, () => attempt(() => (style === 'plain' ? e.inventory.fulfillReservation(resv.id, e.actor, undefined, wide.manager) : wide.manager.transaction((tx) => e.inventory.fulfillReservation(resv.id, e.actor, undefined, tx))))),
        ];
        const outs = await Promise.all(jobs);
        const releaseOk = outs.slice(0, 4).filter((o) => o.ok).length;
        const fulfilOk = outs.slice(4).filter((o) => o.ok).length;
        const status = (await e.dsA.query(`SELECT status FROM stock_reservations WHERE id = $1`, [resv.id]))[0].status;
        const dispatches = await movements(P, 'dispatch');
        const d = { releaseOk, fulfilOk, status, dispatches, onHandDelta: (await onHand(e, W1, P)) - before, releasedAuditRows: await audits('inventory.reservation.released', resv.id), tally: tally(outs) };
        detail[`S3-C-${style}`] = d;
        const releaseWon = releaseOk === 1 && fulfilOk === 0 && status === 'released' && dispatches === 0 && d.onHandDelta === 0 && d.releasedAuditRows === 1;
        const fulfilWon = fulfilOk === 1 && releaseOk === 0 && status === 'fulfilled' && dispatches === 1 && d.onHandDelta === -3 && d.releasedAuditRows === 0;
        result(e, `S3-C-${label(style)}-release-versus-fulfil-exactly-one-wins`, releaseWon || fulfilWon ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(d));
      }
      {
        const P = await seedProduct(e.dsA, 'T30-S3D-rollback');
        await receive(e, W1, P, 50);
        const so = randomUUID();
        const resv = await e.inventory.reserveStock(W1, P, 3, so, e.actor, 'active', e.manager);
        const out = await attempt(() => wide.manager.transaction(async (tx) => { await e.inventory.releaseReservation(resv.id, e.actor, tx); throw new Error('forced rollback'); }));
        const mid = (await e.dsA.query(`SELECT status FROM stock_reservations WHERE id = $1`, [resv.id]))[0].status;
        const again = await attempt(() => e.inventory.releaseReservation(resv.id, e.actor, wide.manager));
        detail['S3-D-rollback'] = { rolledBack: !out.ok, statusAfterRollback: mid, retryOk: again.ok, auditRows: await audits('inventory.reservation.released', resv.id) };
        result(e, 'S3-D-outer-rollback-restores-reservation-and-audit', !out.ok && mid === 'active' && again.ok && (await audits('inventory.reservation.released', resv.id)) === 1 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['S3-D-rollback']));
      }

      // ================= S4 limit-gated creation paths as the services are really called (style A: plain manager) =================
      {
        const inert = {} as never;
        const audit = new AuditService(e.h.controlPlane);
        const numbering = new NumberingService(e.h.controlPlane);
        const limits = new LimitService(e.h.controlPlane, { sync: async () => undefined } as never, e.audit);
        const authz = new AuthorizationService(e.dsA.getRepository(Role), e.dsA.getRepository(UserRole));
        const events = { publish: async () => undefined } as never;
        const customers = new CustomersService(e.h.controlPlane, numbering, inert, audit, events, authz, inert, limits);
        const hr = new HrService(e.h.controlPlane, limits, events, audit, inert, numbering, inert, inert);
        await numbering.registerDocumentType('customer', 'CUS', false, e.manager);
        const profile = async (key: string, moduleCode: string, max: number) => { await e.dsA.getRepository(LimitProfile).save(e.dsA.getRepository(LimitProfile).create({ limitKey: key, moduleCode, unit: 'count', maxValue: max })); };
        const counter = async (key: string) => Number((await e.dsA.query(`SELECT "currentValue" FROM limit_usage_counters WHERE "limitKey" = $1`, [key]))[0]?.currentValue ?? 0);
        await profile('sales.max_customers', 'sales', 5);
        await profile('hr.max_employees', 'hr', 5);
        const custOuts = await Promise.all(Array.from({ length: 10 }, (_, i) => attempt(() => customers.createCustomer({ name: `t30-c-${i}` } as never, e.actor, wide.manager))));
        const custRows = await sum(`SELECT count(*)::int AS n FROM customers WHERE name LIKE 't30-c-%'`, []);
        detail['S4-customers'] = { cap: 5, calls: 10, ok: custOuts.filter((o) => o.ok).length, tally: tally(custOuts), rows: custRows, counter: await counter('sales.max_customers') };
        result(e, 'S4-A-plain-manager-customer-creation-respects-cap', custRows === 5 && (await counter('sales.max_customers')) === 5 && custOuts.filter((o) => o.ok).length === 5 && custOuts.filter((o) => !o.ok).every((o) => o.kind === 'ConflictException:409') ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['S4-customers']));
        const empOuts = await Promise.all(Array.from({ length: 10 }, (_, i) => attempt(() => hr.createEmployee({ fullName: `t30-e-${i}` } as never, e.actor, wide.manager))));
        const empRows = await sum(`SELECT count(*)::int AS n FROM hr_employees WHERE "fullName" LIKE 't30-e-%'`, []);
        detail['S4-employees'] = { cap: 5, calls: 10, ok: empOuts.filter((o) => o.ok).length, tally: tally(empOuts), rows: empRows, counter: await counter('hr.max_employees') };
        result(e, 'S4-A-plain-manager-employee-creation-respects-cap', empRows === 5 && (await counter('hr.max_employees')) === 5 && empOuts.filter((o) => o.ok).length === 5 && empOuts.filter((o) => !o.ok).every((o) => o.kind === 'ConflictException:409') ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['S4-employees']));
      }

      // ================= S6 audit and ledger consistency after everything above (rollbacks, failed relocations, concurrent writers) — TASK 2 of the post-C14 sequence =================
      {
        const chain = await e.audit.verifyCompanyChain(e.manager);
        const auditRows = await sum(`SELECT count(*)::int AS n FROM audit_records`, []);
        const relocatedAudit = await sum(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'inventory.reservation.relocated'`, []);
        const probeTransfers = await sum(`SELECT count(*)::int AS n FROM stock_movements WHERE "movementType" = 'transfer_out' AND "referenceType" = 'probe'`, []);
        const releasedAudit = await sum(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'inventory.reservation.released'`, []);
        const releasedOrFulfilled = await sum(`SELECT count(*)::int AS n FROM stock_reservations WHERE status = 'released'`, []);
        detail['S6'] = { chainValid: chain.valid, auditRows, relocatedAudit, probeTransfers, releasedAudit, reservationsReleased: releasedOrFulfilled };
        result(e, 'S6-A-audit-chain-valid-after-all-rollbacks-failures-and-concurrent-writers', chain.valid && auditRows > 0 ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['S6']));
        // every committed relocation has exactly one transfer-out movement and one audit row; rolled-back or refused ones left neither
        result(e, 'S6-B-relocation-audit-rows-equal-transfer-movements', relocatedAudit === probeTransfers ? 'PASS' : 'FAIL-DEFECT', JSON.stringify(detail['S6']));
      }

      record(e, 'T-30-detail.json', detail);
      await finishBiz(e);
    } catch (err) {
      failure = err;
      throw err;
    }
  });
});
