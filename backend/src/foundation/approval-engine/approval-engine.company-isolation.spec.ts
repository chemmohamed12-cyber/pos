import { randomUUID } from 'crypto';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApprovalEngineService } from './approval-engine.service';
import { ProcessEngineService } from '../process-engine/process-engine.service';
import { AuditService } from '../audit/audit.service';
import { EventBusService } from '../events/event-bus.service';
import { PermissionService } from '../permission/permission.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { ApprovalRequest } from './approval-request.entity';
import { DataSource } from 'typeorm';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../testing/two-company-real-pg-harness';
import { ApprovalRequestType } from './approval-request-type.entity';
import { ApprovalMatrixRule } from './approval-matrix-rule.entity';
import { ApprovalDecision } from './approval-decision.entity';
import { ProcessInstance } from '../process-engine/process-instance.entity';
import { ProcessTransitionRecord } from '../process-engine/process-transition-record.entity';
import { AuditRecord } from '../audit/audit-record.entity';
import { EventOutbox } from '../events/event-outbox.entity';

/**
 * Area 21 (2026-10-05, CTO-authorized) — real-Postgres proof that the Approval
 * Engine is Company-scoped: two real Company databases + a control-plane DB acting
 * as the (inert) ambient connection, never mocked.
 *
 * Proves: a request lives only in its own Company's database; the Company's
 * catalog (request types + default matrix rules) is synchronised from the
 * code-declared one on first use and Company edits never leak; the approver's
 * authority is resolved against THAT Company's roles; maker ≠ checker still holds;
 * the approval event lands in — and its handler runs with the context of — that
 * Company only; another Company can neither read nor decide the request; the
 * ambient (manager-less) path is unchanged.
 */
describe('ApprovalEngineService — Company isolation (real PostgreSQL)', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource; // the (inert) ambient/Platform connection, with the entities the engine touches
  let approvals: ApprovalEngineService;
  let events: EventBusService;
  const TYPE = 'area21.test_action';
  const NODE = 'area21.approve';
  const seen: Array<{ companyId: string | null; requestId: string }> = [];

  let makerA: string;
  let approverA: string;
  let approverB: string;

  async function grant(companyId: string, userId: string) {
    const ds = await h.connections.getDataSource(companyId);
    const role = (await ds.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    await ds.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable') ON CONFLICT DO NOTHING`, [role.id, NODE]);
    void userId;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'approval_isolation' });
    const opts = h.controlPlane.options as { host: string; port: number; username: string; password: string; database: string };
    ambient = new DataSource({
      type: 'postgres', host: opts.host, port: opts.port, username: opts.username, password: opts.password, database: opts.database,
      entities: [ApprovalRequestType, ApprovalMatrixRule, ApprovalRequest, ApprovalDecision, ProcessInstance, ProcessTransitionRecord, AuditRecord, EventOutbox],
      synchronize: false, logging: false,
    });
    await ambient.initialize();
    const inert = {} as never;
    const audit = new AuditService(ambient);
    events = new EventBusService(inert, h.connections);
    const authz = new AuthorizationService(inert, inert);
    const permissions = new PermissionService(inert, authz);
    approvals = new ApprovalEngineService(ambient, new ProcessEngineService(ambient), audit, events, permissions, { get: () => 24 } as never);

    // code-declared catalog (what each domain service does in onModuleInit)
    await approvals.registerRequestType(TYPE, 'action.area21_test');
    await approvals.upsertMatrixRule({ requestTypeCode: TYPE, minApprovers: 1, requiredPermissionNode: NODE }, randomUUID());

    events.subscribe(
      'approval.request.approved',
      async (payload, ctx) => {
        seen.push({ companyId: ctx.companyId, requestId: String(payload.approvalRequestId) });
      },
      { scope: 'company' },
    );

    makerA = (await h.createUserWithAdminRoleIn('Maker A', h.companyAId)).id;
    approverA = (await h.createUserWithAdminRoleIn('Approver A', h.companyAId)).id;
    approverB = (await h.createUserWithAdminRoleIn('Approver B', h.companyBId)).id;
    await grant(h.companyAId, approverA);
    await grant(h.companyBId, approverB);
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown();
  });

  const submitIn = async (companyId: string, maker: string) => {
    const ds = await h.connections.getDataSource(companyId);
    return approvals.submit(
      { requestTypeCode: TYPE, resourceType: 'thing', resourceId: randomUUID(), requestedAction: 'do', payload: { amount: 10 }, makerUserId: maker },
      ds.manager,
    );
  };

  it("a Company's request is stored only in that Company's database; its catalog is synchronised on first use", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsA.query(`SELECT count(*)::int n FROM approval_request_types WHERE "requestTypeCode" = $1`, [TYPE]))[0].n).toBe(0); // nothing before first use

    const req = await submitIn(h.companyAId, makerA);
    expect(req.state).toBe('pending');
    expect(req.resolvedRequiredNode).toBe(NODE);

    expect(await dsA.getRepository(ApprovalRequest).findOne({ where: { id: req.id } })).toBeTruthy();
    expect(await dsB.getRepository(ApprovalRequest).findOne({ where: { id: req.id } })).toBeNull();
    expect(await ambient.query(`SELECT count(*)::int n FROM approval_requests`).then((r) => r[0].n)).toBe(0); // ambient untouched
    // catalog landed in A (type + the declared default rule), and B still has none until it is used
    expect((await dsA.query(`SELECT count(*)::int n FROM approval_request_types WHERE "requestTypeCode" = $1`, [TYPE]))[0].n).toBe(1);
    expect((await dsA.query(`SELECT count(*)::int n FROM approval_matrix_rules WHERE "requestTypeCode" = $1`, [TYPE]))[0].n).toBe(1);
    expect((await dsB.query(`SELECT count(*)::int n FROM approval_request_types WHERE "requestTypeCode" = $1`, [TYPE]))[0].n).toBe(0);
  });

  it('maker can never decide their own request (segregation of duties holds in the Company flow)', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const req = await submitIn(h.companyAId, makerA);
    await expect(approvals.decide(req.id, makerA, 'approved', null, dsA.manager)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("the approver's authority is resolved against THAT Company's roles", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    const reqB = await submitIn(h.companyBId, approverB); // maker is B's approver → needs another checker in B
    // approver A has editable authority in A only: in B they have no roles at all → forbidden
    await expect(approvals.decide(reqB.id, approverA, 'approved', null, dsB.manager)).rejects.toBeInstanceOf(ForbiddenException);
    // and approver A can approve a request made in A
    const reqA = await submitIn(h.companyAId, makerA);
    const done = await approvals.decide(reqA.id, approverA, 'approved', null, dsA.manager);
    expect(done.state).toBe('approved');
  });

  it("the approval event lands in — and its handler runs with the context of — that Company only", async () => {
    seen.length = 0;
    const dsA = await h.connections.getDataSource(h.companyAId);
    const reqA = await submitIn(h.companyAId, makerA);
    await approvals.decide(reqA.id, approverA, 'approved', null, dsA.manager);
    expect(seen.map((s) => s.requestId)).toContain(reqA.id);
    expect(seen.filter((s) => s.requestId === reqA.id).every((s) => s.companyId === h.companyAId)).toBe(true);
    // the event row is in A's outbox (dispatched), never in B's
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect((await dsB.query(`SELECT count(*)::int n FROM event_outbox WHERE topic = 'approval.request.approved'`))[0].n).toBe(0);
  });

  it('another Company can neither read nor decide a request it does not own', async () => {
    const reqA = await submitIn(h.companyAId, makerA);
    const dsB = await h.connections.getDataSource(h.companyBId);
    await expect(approvals.getRequest(reqA.id, dsB.manager)).rejects.toBeInstanceOf(NotFoundException);
    await expect(approvals.decide(reqA.id, approverB, 'approved', null, dsB.manager)).rejects.toBeInstanceOf(NotFoundException);
    expect((await approvals.listRequests({}, dsB.manager)).some((r) => r.id === reqA.id)).toBe(false);
  });

  it("a Company's own matrix-rule edit applies to it alone, and the catalog sync never overwrites it", async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const dsB = await h.connections.getDataSource(h.companyBId);
    await submitIn(h.companyBId, approverB); // ensures B's catalog is synced
    const ruleB = (await approvals.listMatrixRules(TYPE, dsB.manager))[0];
    await approvals.upsertMatrixRule({ id: ruleB.id, requestTypeCode: TYPE, minApprovers: 3, requiredPermissionNode: NODE }, approverB, dsB.manager);
    expect((await approvals.listMatrixRules(TYPE, dsB.manager))[0].minApprovers).toBe(3);
    expect((await approvals.listMatrixRules(TYPE, dsA.manager))[0].minApprovers).toBe(1); // A untouched
    // a fresh sync (new use) does not reset B's customisation
    const again = await submitIn(h.companyBId, approverB);
    expect(again.resolvedMinApprovers).toBe(3);
  });

  it('maker-only withdraw works inside the Company; others cannot withdraw', async () => {
    const dsA = await h.connections.getDataSource(h.companyAId);
    const req = await submitIn(h.companyAId, makerA);
    await expect(approvals.withdraw(req.id, approverA, dsA.manager)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await approvals.withdraw(req.id, makerA, dsA.manager)).state).toBe('withdrawn');
  });

  it('the ambient (manager-less) path is unchanged: requests go to the ambient database and never into a Company', async () => {
    const before = (await ambient.query(`SELECT count(*)::int n FROM approval_requests`))[0].n;
    const req = await approvals.submit({ requestTypeCode: TYPE, resourceType: 'thing', resourceId: randomUUID(), requestedAction: 'do', payload: {}, makerUserId: randomUUID() });
    expect(req.state).toBe('pending');
    expect((await ambient.query(`SELECT count(*)::int n FROM approval_requests`))[0].n).toBe(before + 1);
    const dsA = await h.connections.getDataSource(h.companyAId);
    expect(await dsA.getRepository(ApprovalRequest).findOne({ where: { id: req.id } })).toBeNull();
  });
});
