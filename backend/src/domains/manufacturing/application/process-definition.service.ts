import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../../../foundation/audit/audit.service';
import { OperationKind, OperationType, OutputRole, ProcessEdge, ProcessInput, ProcessOperation, ProcessOutput, ProcessVersion } from '../infrastructure/process-definition.entity';

export interface ProcessOperationInput {
  code: string;
  name: string;
  operationTypeCode: string;
  workCenterId?: string | null;
  sequenceNo?: number;
  optional?: boolean;
  maxRuns?: number;
}
export interface ProcessEdgeInput {
  from: string;
  to: string;
}
export interface ProcessInputLine {
  operationCode: string;
  componentProductId: string;
  quantityPerUnit: number;
  alternateGroup?: string | null;
}
export interface ProcessOutputLine {
  operationCode: string;
  productId: string;
  quantityPerUnit: number;
  role: OutputRole;
  intermediate?: boolean;
  allocationWeight?: number;
}
export interface ProcessDefinitionPayload {
  name: string;
  note?: string | null;
  operations: ProcessOperationInput[];
  edges: ProcessEdgeInput[];
  inputs: ProcessInputLine[];
  outputs: ProcessOutputLine[];
}

export interface ProcessVersionView {
  version: ProcessVersion;
  productSku: string | null;
  productName: string | null;
  operations: Array<ProcessOperation & { operationTypeKind: OperationKind | null }>;
  edges: Array<{ from: string; to: string }>;
  inputs: Array<ProcessInputLine & { componentSku: string | null }>;
  outputs: Array<ProcessOutputLine & { sku: string | null; intermediate: boolean; allocationWeight: number }>;
}

const CODE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Manufacturing Engine S3 (decision D-ME-3) — the versioned process definition: a DAG of typed operations with per-operation inputs (with alternates) and outputs
 * (good / co-product / by-product, intermediate or final). Definition only — executing it is S4. A version is edited as a whole while it is a DRAFT, becomes immutable when
 * activated (exactly one active per product; the previous one is retired), and a new draft is made by cloning. Nothing here posts or touches stock or cost.
 */
@Injectable()
export class ProcessDefinitionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  // ---- operation types (configurable catalogue) ----
  async listOperationTypes(manager?: EntityManager): Promise<OperationType[]> {
    return (manager ?? this.dataSource).getRepository(OperationType).find({ order: { code: 'ASC' } });
  }

  async upsertOperationType(code: string, nameAr: string, nameEn: string, kind: OperationKind, active: boolean, manager?: EntityManager): Promise<OperationType> {
    if (!CODE.test(code ?? '')) throw new BadRequestException('An operation type code is required (letters, digits, - and _, max 32).');
    const repo = (manager ?? this.dataSource).getRepository(OperationType);
    const existing = await repo.findOne({ where: { code } });
    if (existing) {
      if (existing.kind !== kind) throw new ConflictException(`Operation type "${code}" is already defined with kind "${existing.kind}" — a kind cannot be changed once definitions may use it.`);
      existing.nameAr = nameAr;
      existing.nameEn = nameEn;
      existing.active = active;
      return repo.save(existing);
    }
    return repo.save(repo.create({ code, nameAr, nameEn, kind, active }));
  }

  // ---- reads ----
  async list(productId: string | null, manager?: EntityManager): Promise<Array<ProcessVersion & { productSku: string | null; productName: string | null; operationCount: number }>> {
    const m = manager ?? this.dataSource;
    const rows: Array<ProcessVersion & { productSku: string | null; productName: string | null; operationCount: number }> = await m.query(
      `SELECT v.*, p."sku" AS "productSku", p."name" AS "productName", (SELECT count(*)::int FROM "mfg_process_operations" o WHERE o."versionId" = v."id") AS "operationCount"
         FROM "mfg_process_versions" v LEFT JOIN "products" p ON p."id" = v."productId" WHERE ($1::uuid IS NULL OR v."productId" = $1) ORDER BY p."sku", v."versionNo" DESC`,
      [productId],
    );
    return rows;
  }

  async get(versionId: string, manager?: EntityManager): Promise<ProcessVersionView> {
    const m = manager ?? this.dataSource;
    const version = await m.getRepository(ProcessVersion).findOne({ where: { id: versionId } });
    if (!version) throw new NotFoundException(`Process version "${versionId}" not found.`);
    const ops = await m.getRepository(ProcessOperation).find({ where: { versionId }, order: { sequenceNo: 'ASC', code: 'ASC' } });
    const types = await m.getRepository(OperationType).find();
    const kindOf = new Map(types.map((t) => [t.code, t.kind]));
    const codeOf = new Map(ops.map((o) => [o.id, o.code]));
    const edges = (await m.getRepository(ProcessEdge).find({ where: { versionId } })).map((e) => ({ from: codeOf.get(e.fromOperationId)!, to: codeOf.get(e.toOperationId)! }));
    const inputs = await m.getRepository(ProcessInput).find({ where: { versionId } });
    const outputs = await m.getRepository(ProcessOutput).find({ where: { versionId } });
    const prodIds = [...new Set([version.productId, ...inputs.map((i) => i.componentProductId), ...outputs.map((o) => o.productId)])];
    const prods: Array<{ id: string; sku: string; name: string }> = prodIds.length ? await m.query(`SELECT "id","sku","name" FROM "products" WHERE "id" = ANY($1)`, [prodIds]) : [];
    const pmap = new Map(prods.map((p) => [p.id, p]));
    return {
      version,
      productSku: pmap.get(version.productId)?.sku ?? null,
      productName: pmap.get(version.productId)?.name ?? null,
      operations: ops.map((o) => ({ ...o, operationTypeKind: kindOf.get(o.operationTypeCode) ?? null })),
      edges,
      inputs: inputs.map((i) => ({ operationCode: codeOf.get(i.operationId)!, componentProductId: i.componentProductId, quantityPerUnit: i.quantityPerUnit, alternateGroup: i.alternateGroup, componentSku: pmap.get(i.componentProductId)?.sku ?? null })),
      outputs: outputs.map((o) => ({ operationCode: codeOf.get(o.operationId)!, productId: o.productId, quantityPerUnit: o.quantityPerUnit, role: o.role, intermediate: o.intermediate, allocationWeight: o.allocationWeight, sku: pmap.get(o.productId)?.sku ?? null })),
    };
  }

  /** The ACTIVE version of a product's process, or null (the order then runs the Basic Profile). */
  async getActiveVersion(productId: string, manager?: EntityManager): Promise<ProcessVersion | null> {
    return (manager ?? this.dataSource).getRepository(ProcessVersion).findOne({ where: { productId, status: 'active' } });
  }

  /**
   * The raw material an order needs from stock under `choices` - inputs that are NOT intermediate outputs of the same version (those are made inside the order).
   * Every alternate group must have an explicit choice (`"<operationCode>|<group>" -> productId`); nothing is defaulted silently.
   */
  async resolveRawRequirements(versionId: string, choices: Record<string, string> | null, manager?: EntityManager): Promise<Array<{ componentProductId: string; quantityPerUnit: number }>> {
    const v = await this.get(versionId, manager);
    const intermediates = new Set(v.outputs.filter((o) => o.intermediate).map((o) => o.productId));
    const totals = new Map<string, number>();
    for (const i of v.inputs) {
      if (i.alternateGroup) {
        const key = `${i.operationCode}|${i.alternateGroup}`;
        const choice = choices?.[key];
        if (!choice) throw new ConflictException(`Choose one alternative for "${i.alternateGroup}" on operation "${i.operationCode}" (key "${key}").`);
        if (!v.inputs.some((x) => x.operationCode === i.operationCode && x.alternateGroup === i.alternateGroup && x.componentProductId === choice)) {
          throw new ConflictException(`"${choice}" is not one of the alternatives of "${i.alternateGroup}" on operation "${i.operationCode}".`);
        }
        if (i.componentProductId !== choice) continue;
      }
      if (intermediates.has(i.componentProductId)) continue;
      totals.set(i.componentProductId, (totals.get(i.componentProductId) ?? 0) + i.quantityPerUnit);
    }
    return [...totals.entries()].map(([componentProductId, quantityPerUnit]) => ({ componentProductId, quantityPerUnit }));
  }

  // ---- writes ----
  /** New DRAFT version of the process that makes `productId` (next version number). */
  async createDraft(productId: string, payload: ProcessDefinitionPayload, actorUserId: string | null, manager?: EntityManager): Promise<ProcessVersionView> {
    const run = async (tx: EntityManager) => {
      await this.assertProduct(productId, tx);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manufacturing:process:${productId}`]);
      const max: Array<{ n: number | null }> = await tx.query(`SELECT max("versionNo")::int AS n FROM "mfg_process_versions" WHERE "productId" = $1`, [productId]);
      const version = await tx.getRepository(ProcessVersion).save(
        tx.getRepository(ProcessVersion).create({ productId, versionNo: (max[0].n ?? 0) + 1, status: 'draft', name: (payload.name ?? '').trim() || 'Process', note: payload.note ?? null, createdByUserId: actorUserId }),
      );
      await this.writeBody(version, payload, tx);
      await this.audit.record({ actorUserId, organizationId: null, action: 'manufacturing.process.draft_created', resource: 'process_version', resourceId: version.id, result: 'success', correlationId: version.id, after: { productId, versionNo: version.versionNo } }, tx);
      return version.id;
    };
    const id = await (manager ?? this.dataSource).transaction(run);
    return this.get(id, manager);
  }

  /** Replaces a DRAFT version's whole body. Active / retired versions are immutable. */
  async saveDraft(versionId: string, payload: ProcessDefinitionPayload, actorUserId: string | null, manager?: EntityManager): Promise<ProcessVersionView> {
    const run = async (tx: EntityManager) => {
      const version = await this.mustVersion(versionId, tx, true);
      if (version.status !== 'draft') throw new ConflictException(`Process version ${version.versionNo} is ${version.status} and cannot be edited — clone it to a new draft.`);
      version.name = (payload.name ?? '').trim() || version.name;
      version.note = payload.note ?? null;
      await tx.getRepository(ProcessVersion).save(version);
      await this.clearBody(versionId, tx);
      await this.writeBody(version, payload, tx);
      await this.audit.record({ actorUserId, organizationId: null, action: 'manufacturing.process.draft_saved', resource: 'process_version', resourceId: version.id, result: 'success', correlationId: version.id }, tx);
    };
    await (manager ?? this.dataSource).transaction(run);
    return this.get(versionId, manager);
  }

  async clone(versionId: string, actorUserId: string | null, manager?: EntityManager): Promise<ProcessVersionView> {
    const src = await this.get(versionId, manager);
    return this.createDraft(
      src.version.productId,
      {
        name: src.version.name,
        note: src.version.note,
        operations: src.operations.map((o) => ({ code: o.code, name: o.name, operationTypeCode: o.operationTypeCode, workCenterId: o.workCenterId, sequenceNo: o.sequenceNo, optional: o.optional, maxRuns: o.maxRuns })),
        edges: src.edges,
        inputs: src.inputs.map((i) => ({ operationCode: i.operationCode, componentProductId: i.componentProductId, quantityPerUnit: i.quantityPerUnit, alternateGroup: i.alternateGroup })),
        outputs: src.outputs.map((o) => ({ operationCode: o.operationCode, productId: o.productId, quantityPerUnit: o.quantityPerUnit, role: o.role, intermediate: o.intermediate, allocationWeight: o.allocationWeight })),
      },
      actorUserId,
      manager,
    );
  }

  /** Makes a draft the ONE active version of its product (the previous active one is retired in the same transaction). */
  async activate(versionId: string, actorUserId: string | null, manager?: EntityManager): Promise<ProcessVersionView> {
    const run = async (tx: EntityManager) => {
      const version = await this.mustVersion(versionId, tx, true);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manufacturing:process:${version.productId}`]);
      if (version.status !== 'draft') throw new ConflictException(`Process version ${version.versionNo} is ${version.status}; only a draft can be activated.`);
      const body = await this.get(versionId, tx);
      this.assertComplete(body);
      await tx.query(`UPDATE "mfg_process_versions" SET "status" = 'retired' WHERE "productId" = $1 AND "status" = 'active'`, [version.productId]);
      await tx.query(`UPDATE "mfg_process_versions" SET "status" = 'active', "activatedAt" = now() WHERE "id" = $1`, [versionId]);
      await this.audit.record({ actorUserId, organizationId: null, action: 'manufacturing.process.activated', resource: 'process_version', resourceId: versionId, result: 'success', correlationId: versionId, after: { versionNo: version.versionNo } }, tx);
    };
    await (manager ?? this.dataSource).transaction(run);
    return this.get(versionId, manager);
  }

  async deleteDraft(versionId: string, manager?: EntityManager): Promise<void> {
    const run = async (tx: EntityManager) => {
      const version = await this.mustVersion(versionId, tx, true);
      if (version.status !== 'draft') throw new ConflictException(`Only a draft can be deleted; version ${version.versionNo} is ${version.status}.`);
      await this.clearBody(versionId, tx);
      await tx.getRepository(ProcessVersion).delete(versionId);
    };
    await (manager ?? this.dataSource).transaction(run);
  }

  // ---- internals ----
  private async mustVersion(versionId: string, tx: EntityManager, lock = false): Promise<ProcessVersion> {
    if (lock) await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manufacturing:process_version:${versionId}`]);
    const v = await tx.getRepository(ProcessVersion).findOne({ where: { id: versionId } });
    if (!v) throw new NotFoundException(`Process version "${versionId}" not found.`);
    return v;
  }

  private async assertProduct(productId: string, tx: EntityManager): Promise<void> {
    const rows = await tx.query(`SELECT 1 FROM "products" WHERE "id" = $1`, [productId]);
    if (rows.length === 0) throw new NotFoundException(`Product "${productId}" not found.`);
  }

  private async clearBody(versionId: string, tx: EntityManager): Promise<void> {
    for (const t of ['mfg_process_outputs', 'mfg_process_inputs', 'mfg_process_edges', 'mfg_process_operations']) await tx.query(`DELETE FROM "${t}" WHERE "versionId" = $1`, [versionId]);
  }

  /** Structural validation + insert. A draft may be incomplete (activation re-checks completeness); it can never be malformed or cyclic. */
  private async writeBody(version: ProcessVersion, p: ProcessDefinitionPayload, tx: EntityManager): Promise<void> {
    const ops = p.operations ?? [];
    const codes = new Set<string>();
    const types = new Map((await tx.getRepository(OperationType).find()).map((t) => [t.code, t]));
    for (const o of ops) {
      if (!CODE.test(o.code ?? '')) throw new BadRequestException(`Operation code "${o.code}" is invalid (letters, digits, - and _, max 32).`);
      if (codes.has(o.code)) throw new BadRequestException(`Operation code "${o.code}" is used twice.`);
      codes.add(o.code);
      if (!(o.name ?? '').trim()) throw new BadRequestException(`Operation "${o.code}" needs a name.`);
      const t = types.get(o.operationTypeCode);
      if (!t || !t.active) throw new BadRequestException(`Operation "${o.code}": operation type "${o.operationTypeCode}" is not defined or not active.`);
      const runs = o.maxRuns ?? 1;
      if (!Number.isInteger(runs) || runs < 1 || runs > 50) throw new BadRequestException(`Operation "${o.code}": maxRuns must be a whole number between 1 and 50.`);
      if (o.workCenterId) {
        const wc = await tx.query(`SELECT 1 FROM "work_centers" WHERE "id" = $1`, [o.workCenterId]);
        if (wc.length === 0) throw new BadRequestException(`Operation "${o.code}": work center "${o.workCenterId}" not found.`);
      }
    }
    const saved = new Map<string, ProcessOperation>();
    for (const o of ops) {
      saved.set(
        o.code,
        await tx.getRepository(ProcessOperation).save(
          tx.getRepository(ProcessOperation).create({ versionId: version.id, code: o.code, name: o.name.trim(), operationTypeCode: o.operationTypeCode, workCenterId: o.workCenterId ?? null, sequenceNo: o.sequenceNo ?? 0, optional: !!o.optional, maxRuns: o.maxRuns ?? 1 }),
        ),
      );
    }
    // edges: known endpoints, no duplicates, acyclic (Kahn)
    const seen = new Set<string>();
    const indeg = new Map<string, number>([...codes].map((c) => [c, 0]));
    const adj = new Map<string, string[]>([...codes].map((c) => [c, []]));
    for (const e of p.edges ?? []) {
      if (!codes.has(e.from) || !codes.has(e.to)) throw new BadRequestException(`Edge ${e.from} -> ${e.to} refers to an unknown operation.`);
      if (e.from === e.to) throw new BadRequestException(`Operation "${e.from}" cannot precede itself.`);
      const key = `${e.from}>${e.to}`;
      if (seen.has(key)) throw new BadRequestException(`Edge ${e.from} -> ${e.to} is listed twice.`);
      seen.add(key);
      adj.get(e.from)!.push(e.to);
      indeg.set(e.to, indeg.get(e.to)! + 1);
    }
    const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([c]) => c);
    let visited = 0;
    while (queue.length) {
      const c = queue.shift()!;
      visited++;
      for (const n of adj.get(c)!) {
        indeg.set(n, indeg.get(n)! - 1);
        if (indeg.get(n) === 0) queue.push(n);
      }
    }
    if (visited !== codes.size) throw new BadRequestException('The process graph contains a cycle — repeating work is expressed with maxRuns on an operation, not with a loop of edges.');
    for (const e of p.edges ?? []) {
      await tx.getRepository(ProcessEdge).save(tx.getRepository(ProcessEdge).create({ versionId: version.id, fromOperationId: saved.get(e.from)!.id, toOperationId: saved.get(e.to)!.id }));
    }
    // inputs
    const groupSize = new Map<string, number>();
    for (const i of p.inputs ?? []) {
      if (!codes.has(i.operationCode)) throw new BadRequestException(`Input refers to unknown operation "${i.operationCode}".`);
      if (!Number.isInteger(i.quantityPerUnit) || i.quantityPerUnit < 1) throw new BadRequestException(`Input on "${i.operationCode}": quantityPerUnit must be a whole number of base units, at least 1.`);
      await this.assertProduct(i.componentProductId, tx);
      if (i.alternateGroup) {
        const k = `${i.operationCode}|${i.alternateGroup}`;
        groupSize.set(k, (groupSize.get(k) ?? 0) + 1);
      }
      await tx.getRepository(ProcessInput).save(
        tx.getRepository(ProcessInput).create({ versionId: version.id, operationId: saved.get(i.operationCode)!.id, componentProductId: i.componentProductId, quantityPerUnit: i.quantityPerUnit, alternateGroup: i.alternateGroup || null }),
      );
    }
    for (const [k, n] of groupSize) if (n < 2) throw new BadRequestException(`Alternate group "${k.split('|')[1]}" on "${k.split('|')[0]}" needs at least two alternatives.`);
    // outputs
    for (const o of p.outputs ?? []) {
      if (!codes.has(o.operationCode)) throw new BadRequestException(`Output refers to unknown operation "${o.operationCode}".`);
      if (!['good', 'co_product', 'by_product'].includes(o.role)) throw new BadRequestException(`Output role "${o.role}" is not valid.`);
      if (!Number.isInteger(o.quantityPerUnit) || o.quantityPerUnit < 1) throw new BadRequestException(`Output on "${o.operationCode}": quantityPerUnit must be a whole number of base units, at least 1.`);
      const w = o.allocationWeight ?? 1;
      if (!Number.isInteger(w) || w < 0) throw new BadRequestException(`Output on "${o.operationCode}": allocationWeight must be a whole number, 0 or more.`);
      await this.assertProduct(o.productId, tx);
      await tx.getRepository(ProcessOutput).save(
        tx.getRepository(ProcessOutput).create({ versionId: version.id, operationId: saved.get(o.operationCode)!.id, productId: o.productId, quantityPerUnit: o.quantityPerUnit, role: o.role, intermediate: !!o.intermediate, allocationWeight: w }),
      );
    }
  }

  /** What a version must have before it can be activated (a draft may be saved incomplete). */
  private assertComplete(v: ProcessVersionView): void {
    if (v.operations.length === 0) throw new BadRequestException('A process needs at least one operation.');
    const finals = v.outputs.filter((o) => !o.intermediate);
    if (!finals.some((o) => o.role === 'good' && o.productId === v.version.productId)) throw new BadRequestException(`The process must produce its own product (${v.productSku ?? v.version.productId}) as a final "good" output.`);
    if (!finals.some((o) => o.allocationWeight > 0)) throw new BadRequestException('At least one final output must carry an allocation weight above zero, otherwise no output can take the order cost.');
    const consumed = new Set(v.inputs.map((i) => i.componentProductId));
    for (const o of v.outputs.filter((x) => x.intermediate)) {
      if (!consumed.has(o.productId)) throw new BadRequestException(`Intermediate output "${o.sku ?? o.productId}" of "${o.operationCode}" is not consumed by any operation input.`);
    }
    const pred = new Map<string, Set<string>>();
    for (const e of v.edges) (pred.get(e.to) ?? pred.set(e.to, new Set()).get(e.to)!).add(e.from);
    const reachesFrom = (op: string, seen = new Set<string>()): Set<string> => {
      for (const p of pred.get(op) ?? []) if (!seen.has(p)) { seen.add(p); reachesFrom(p, seen); }
      return seen;
    };
    for (const o of v.outputs.filter((x) => x.intermediate)) {
      const consumers = v.inputs.filter((i) => i.componentProductId === o.productId).map((i) => i.operationCode);
      if (!consumers.some((c) => reachesFrom(c).has(o.operationCode))) throw new BadRequestException(`Intermediate output "${o.sku ?? o.productId}" is only consumed by operations that do not come after "${o.operationCode}".`);
    }
  }
}
