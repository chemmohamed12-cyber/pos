import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProcessDefinitionPayload, ProcessDefinitionService } from '../application/process-definition.service';
import { ProductsService } from '../../commerce/application/products.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Manufacturing Engine S3 (decision D-ME-3) — the versioned process definition, real PostgreSQL, Company B is the untouched witness.
 * Proves: a typed operation graph with sequence / parallel branches / joins / optional / repeatable operations; inputs with alternates; final and intermediate outputs;
 * draft -> active -> retired with exactly one active version per product; immutability of active versions and cloning to a new draft; structural refusals
 * (cycles, unknown types / operations, bad quantities, lone alternates, orphan or backwards intermediates); the configurable operation-type catalogue.
 */
describe('Manufacturing Engine S3 — process definition (versions, graph, inputs, outputs) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let svc: ProcessDefinitionService;
  const actor = randomUUID();
  const p: Record<string, string> = {};
  const dsA = () => h.connections.getDataSource(h.companyAId);
  const dsB = () => h.connections.getDataSource(h.companyBId);
  const m = async () => (await dsA()).manager;

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'mfg_s3', extraCompanyTags: ['sales', 'inventory', 'logistics', 'finance', 'procurement', 'accounting', 'manufacturing'] });
    const audit = new AuditService(h.controlPlane);
    const products = new ProductsService(h.controlPlane, audit, new EventBusService({} as never, h.connections));
    svc = new ProcessDefinitionService(h.controlPlane, audit);
    await (await dsA()).query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'MFG Operator','mfg-s3@test.local') ON CONFLICT DO NOTHING`, [actor]);
    for (const [k, name] of [['lamp', 'Lamp'], ['body', 'Body'], ['pcb', 'PCB board'], ['chip', 'Chip'], ['wire', 'Wire'], ['wireB', 'Wire B'], ['shell', 'Shell'], ['scrapMetal', 'Scrap metal']] as const) {
      p[k] = (await products.createProduct(`S3-${k.toUpperCase()}`, name, '1.00', actor, 'pcs', (await dsA()).manager)).id;
    }
  });
  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('MFG S3 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  /** electronics-like: two PARALLEL branches (board, housing) joined by assembly, then an optional repeatable inspection */
  const lampBody = (over: Partial<ProcessDefinitionPayload> = {}): ProcessDefinitionPayload => ({
    name: 'Lamp process',
    operations: [
      { code: 'BOARD', name: 'Make board', operationTypeCode: 'transform', sequenceNo: 10 },
      { code: 'HOUSE', name: 'Make housing', operationTypeCode: 'transform', sequenceNo: 10 },
      { code: 'ASM', name: 'Assemble', operationTypeCode: 'assembly', sequenceNo: 20 },
      { code: 'QC', name: 'Inspect', operationTypeCode: 'quality', sequenceNo: 30, optional: true, maxRuns: 3 },
    ],
    edges: [{ from: 'BOARD', to: 'ASM' }, { from: 'HOUSE', to: 'ASM' }, { from: 'ASM', to: 'QC' }],
    inputs: [
      { operationCode: 'BOARD', componentProductId: p.chip, quantityPerUnit: 4 },
      { operationCode: 'BOARD', componentProductId: p.wire, quantityPerUnit: 2, alternateGroup: 'WIRE' },
      { operationCode: 'BOARD', componentProductId: p.wireB, quantityPerUnit: 2, alternateGroup: 'WIRE' },
      { operationCode: 'HOUSE', componentProductId: p.shell, quantityPerUnit: 1 },
      { operationCode: 'ASM', componentProductId: p.pcb, quantityPerUnit: 1 },
      { operationCode: 'ASM', componentProductId: p.body, quantityPerUnit: 1 },
    ],
    outputs: [
      { operationCode: 'BOARD', productId: p.pcb, quantityPerUnit: 1, role: 'good', intermediate: true },
      { operationCode: 'HOUSE', productId: p.body, quantityPerUnit: 1, role: 'good', intermediate: true },
      { operationCode: 'ASM', productId: p.lamp, quantityPerUnit: 1, role: 'good' },
    ],
    ...over,
  });

  let v1 = '';
  it('S3-1 a graph with parallel branches, a join, alternates, intermediates and an optional repeatable inspection saves as draft v1 and reads back whole', async () => {
    const v = await svc.createDraft(p.lamp, lampBody(), actor, await m());
    v1 = v.version.id;
    expect(v.version.versionNo).toBe(1);
    expect(v.version.status).toBe('draft');
    expect(v.operations.map((o) => o.code).sort()).toEqual(['ASM', 'BOARD', 'HOUSE', 'QC']);
    expect(v.operations.find((o) => o.code === 'QC')).toMatchObject({ optional: true, maxRuns: 3, operationTypeKind: 'quality' });
    expect(v.edges).toHaveLength(3);
    expect(v.inputs.filter((i) => i.alternateGroup === 'WIRE')).toHaveLength(2);
    expect(v.outputs.filter((o) => o.intermediate)).toHaveLength(2);
  });

  it('S3-2 structural mistakes are refused with nothing saved (cycle, self edge, unknown type / operation, duplicate code, bad quantity, lone alternate)', async () => {
    const bad = async (over: Partial<ProcessDefinitionPayload>) => svc.createDraft(p.lamp, lampBody(over), actor, await m());
    await expect(bad({ edges: [{ from: 'ASM', to: 'BOARD' }, { from: 'BOARD', to: 'ASM' }] })).rejects.toThrow(/cycle/);
    await expect(bad({ edges: [{ from: 'ASM', to: 'ASM' }] })).rejects.toThrow(/precede itself/);
    await expect(bad({ edges: [{ from: 'ASM', to: 'NOPE' }] })).rejects.toThrow(/unknown operation/);
    await expect(bad({ operations: [{ code: 'A', name: 'a', operationTypeCode: 'welding' }], edges: [], inputs: [], outputs: [] })).rejects.toThrow(/not defined or not active/);
    await expect(bad({ operations: [{ code: 'A', name: 'a', operationTypeCode: 'transform' }, { code: 'A', name: 'b', operationTypeCode: 'transform' }], edges: [], inputs: [], outputs: [] })).rejects.toThrow(/used twice/);
    await expect(bad({ inputs: [{ operationCode: 'ASM', componentProductId: p.pcb, quantityPerUnit: 0 }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(bad({ inputs: [{ operationCode: 'ASM', componentProductId: p.pcb, quantityPerUnit: 1, alternateGroup: 'ONLY' }] })).rejects.toThrow(/at least two alternatives/);
    await expect(bad({ operations: [{ code: 'A', name: 'a', operationTypeCode: 'transform', workCenterId: randomUUID() }], edges: [], inputs: [], outputs: [] })).rejects.toThrow(/work center/);
    const n = await (await dsA()).query(`SELECT count(*)::int AS n FROM "mfg_process_versions" WHERE "productId" = $1`, [p.lamp]);
    expect(n[0].n).toBe(1); // only v1 exists: every refused call rolled back, including the version row
  });

  it('S3-3 a draft may be incomplete, but it cannot be activated until it produces its own product with a cost-carrying final output', async () => {
    const v = await svc.createDraft(p.lamp, lampBody({ outputs: [{ operationCode: 'BOARD', productId: p.pcb, quantityPerUnit: 1, role: 'good', intermediate: true }] }), actor, await m());
    await expect(svc.activate(v.version.id, actor, await m())).rejects.toThrow(/final "good" output/);
    await svc.saveDraft(v.version.id, lampBody({ outputs: [{ operationCode: 'ASM', productId: p.lamp, quantityPerUnit: 1, role: 'good', allocationWeight: 0 }] }), actor, await m());
    await expect(svc.activate(v.version.id, actor, await m())).rejects.toThrow(/allocation weight above zero|not consumed/);
    await svc.deleteDraft(v.version.id, await m());
  });

  it('S3-4 intermediates must be consumed by a LATER operation', async () => {
    const orphan = await svc.createDraft(p.lamp, lampBody({ inputs: [{ operationCode: 'BOARD', componentProductId: p.chip, quantityPerUnit: 1 }, { operationCode: 'ASM', componentProductId: p.pcb, quantityPerUnit: 1 }] }), actor, await m());
    await expect(svc.activate(orphan.version.id, actor, await m())).rejects.toThrow(/Intermediate output .* not consumed/);
    await svc.saveDraft(
      orphan.version.id,
      lampBody({
        // PCB is consumed only by BOARD itself (which makes it), i.e. not by a later operation
        inputs: [{ operationCode: 'BOARD', componentProductId: p.pcb, quantityPerUnit: 1 }, { operationCode: 'ASM', componentProductId: p.body, quantityPerUnit: 1 }],
      }),
      actor,
      await m(),
    );
    await expect(svc.activate(orphan.version.id, actor, await m())).rejects.toThrow(/do not come after/);
    await svc.deleteDraft(orphan.version.id, await m());
  });

  it('S3-5 activating v1 makes it the one active version; activating a cloned v2 retires v1; an active or retired version cannot be edited or deleted', async () => {
    const a1 = await svc.activate(v1, actor, await m());
    expect(a1.version.status).toBe('active');
    await expect(svc.saveDraft(v1, lampBody(), actor, await m())).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.deleteDraft(v1, await m())).rejects.toBeInstanceOf(ConflictException);
    const c = await svc.clone(v1, actor, await m());
    expect(c.version.versionNo).toBe(2);
    expect(c.version.status).toBe('draft');
    expect(c.operations).toHaveLength(4);
    expect(c.edges).toHaveLength(3);
    const a2 = await svc.activate(c.version.id, actor, await m());
    expect(a2.version.status).toBe('active');
    const all = await svc.list(p.lamp, await m());
    expect(all.map((x) => [x.versionNo, x.status])).toEqual([[2, 'active'], [1, 'retired']]);
    await expect(svc.saveDraft(v1, lampBody(), actor, await m())).rejects.toBeInstanceOf(ConflictException); // retired
    await expect(svc.activate(v1, actor, await m())).rejects.toBeInstanceOf(ConflictException);
  });

  it('S3-6 the database itself refuses a second active version for a product (partial unique index)', async () => {
    const ds = await dsA();
    const act = (await ds.query(`SELECT id FROM "mfg_process_versions" WHERE "productId" = $1 AND "status" = 'retired' LIMIT 1`, [p.lamp]))[0].id;
    await expect(ds.query(`UPDATE "mfg_process_versions" SET "status" = 'active' WHERE "id" = $1`, [act])).rejects.toThrow(/IDX_mfg_process_versions_one_active|duplicate key/);
  });

  it('S3-7 multi-output (co-product + by-product with weights) and a disassembly-style process are plain configuration', async () => {
    const blend = await svc.createDraft(
      p.body,
      {
        name: 'Blend',
        operations: [{ code: 'MIX', name: 'Blend', operationTypeCode: 'transform' }],
        edges: [],
        inputs: [{ operationCode: 'MIX', componentProductId: p.shell, quantityPerUnit: 10 }],
        outputs: [
          { operationCode: 'MIX', productId: p.body, quantityPerUnit: 6, role: 'good', allocationWeight: 6 },
          { operationCode: 'MIX', productId: p.pcb, quantityPerUnit: 3, role: 'co_product', allocationWeight: 3 },
          { operationCode: 'MIX', productId: p.scrapMetal, quantityPerUnit: 1, role: 'by_product', allocationWeight: 0 },
        ],
      },
      actor,
      await m(),
    );
    expect((await svc.activate(blend.version.id, actor, await m())).version.status).toBe('active');
    const dis = await svc.createDraft(
      p.chip,
      {
        name: 'Disassemble lamp',
        operations: [{ code: 'DIS', name: 'Disassemble', operationTypeCode: 'disassembly' }],
        edges: [],
        inputs: [{ operationCode: 'DIS', componentProductId: p.lamp, quantityPerUnit: 1 }],
        outputs: [
          { operationCode: 'DIS', productId: p.chip, quantityPerUnit: 4, role: 'good', allocationWeight: 4 },
          { operationCode: 'DIS', productId: p.shell, quantityPerUnit: 1, role: 'co_product', allocationWeight: 1 },
        ],
      },
      actor,
      await m(),
    );
    expect((await svc.activate(dis.version.id, actor, await m())).version.status).toBe('active');
  });

  it('S3-8 the operation-type catalogue is configurable: a new type works, its kind cannot change, an inactive one is refused', async () => {
    await svc.upsertOperationType('welding', 'لحام', 'Welding', 'transform', true, await m());
    const ok = await svc.createDraft(p.shell, { name: 'Weld', operations: [{ code: 'W', name: 'Weld', operationTypeCode: 'welding' }], edges: [], inputs: [], outputs: [] }, actor, await m());
    expect(ok.operations[0].operationTypeKind).toBe('transform');
    await expect(svc.upsertOperationType('welding', 'لحام', 'Welding', 'quality', true, await m())).rejects.toBeInstanceOf(ConflictException);
    await svc.upsertOperationType('welding', 'لحام', 'Welding', 'transform', false, await m());
    await expect(svc.saveDraft(ok.version.id, { name: 'Weld', operations: [{ code: 'W', name: 'Weld', operationTypeCode: 'welding' }], edges: [], inputs: [], outputs: [] }, actor, await m())).rejects.toThrow(/not defined or not active/);
  });

  it('S3-9 Company B (the witness) holds no process data of Company A', async () => {
    const b = await dsB();
    for (const t of ['mfg_process_versions', 'mfg_process_operations', 'mfg_process_edges', 'mfg_process_inputs', 'mfg_process_outputs']) {
      expect((await b.query(`SELECT count(*)::int AS n FROM "${t}"`))[0].n).toBe(0);
    }
    expect((await b.query(`SELECT count(*)::int AS n FROM "mfg_operation_types"`))[0].n).toBe(6); // only the seeded defaults
  });
});
