import { createHash } from 'crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { PayrollException, PayrollExceptionClass } from '../infrastructure/payroll-exception.entity';
import { PayrollRun } from '../infrastructure/payroll-run.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { PayrollSodService } from './payroll-sod.service';

export interface DetectedException {
  code: string;
  impactClass: PayrollExceptionClass;
  employeeId: string | null;
  /** Facts that caused the exception. They are part of the fingerprint: an acknowledgement survives a recalculation only if these facts are identical. */
  detail: Record<string, unknown>;
}

/** Deterministic JSON (sorted keys) so equal facts always hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export function exceptionFingerprint(e: DetectedException): string {
  return createHash('sha256').update(`${e.code}|${e.employeeId ?? ''}|${stableStringify(e.detail)}`).digest('hex');
}

/**
 * Addendum A-9/A-10 — the exception register of a run revision. Three impact classes:
 *  - `B_APPROVE`: the run cannot be approved until the cause is fixed and the run recalculated (never acknowledgeable);
 *  - `A_DOC`: approval is allowed only after a documented acknowledgement (decision reference + acknowledger, recorded as a stage actor, SoD-checked);
 *  - `INFO`: recorded for traceability, never blocks.
 * There is no "ignore" state. An exception disappears only when a recalculation no longer detects it; an acknowledgement is carried over to a recalculation
 * only when the fingerprint (code + employee + causing facts) is identical.
 */
@Injectable()
export class PayrollExceptionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly sod: PayrollSodService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  /** Replaces the run's exception set with `detected`, keeping identical (same fingerprint) rows and their acknowledgements. Call inside the calculation transaction. */
  async replaceForRun(runId: string, detected: DetectedException[], manager: EntityManager): Promise<PayrollException[]> {
    const repo = manager.getRepository(PayrollException);
    const existing = await repo.find({ where: { payrollRunId: runId } });
    const byFp = new Map(existing.map((e) => [e.fingerprint, e]));
    const wanted = new Map<string, DetectedException>();
    for (const d of detected) wanted.set(exceptionFingerprint(d), d);

    const stale = existing.filter((e) => !wanted.has(e.fingerprint));
    if (stale.length > 0) await repo.delete({ id: In(stale.map((s) => s.id)) });

    const out: PayrollException[] = [];
    for (const [fp, d] of wanted) {
      const kept = byFp.get(fp);
      if (kept) {
        out.push(kept);
        continue;
      }
      out.push(
        await repo.save(
          repo.create({ payrollRunId: runId, employeeId: d.employeeId, code: d.code, impactClass: d.impactClass, detail: d.detail, fingerprint: fp, status: d.impactClass === 'INFO' ? 'resolved' : 'open' }),
        ),
      );
    }
    return out;
  }

  async list(runId: string, manager?: EntityManager): Promise<PayrollException[]> {
    return this.em(manager).getRepository(PayrollException).find({ where: { payrollRunId: runId }, order: { impactClass: 'ASC', code: 'ASC', createdAt: 'ASC' } });
  }

  /** What still prevents approval: every open `B_APPROVE` / `A_DOC` row. */
  async blockers(runId: string, manager?: EntityManager): Promise<PayrollException[]> {
    const rows = await this.list(runId, manager);
    return rows.filter((e) => e.impactClass !== 'INFO' && e.status !== 'acknowledged' && e.status !== 'resolved');
  }

  /**
   * Acknowledge `A_DOC` exceptions (by ids, or every open exception of one `code`). `decisionRef` is mandatory — the reference of the documented decision that
   * allows approval despite the condition; it is stored, audited and shown to the approver.
   */
  async acknowledge(
    runId: string,
    selector: { exceptionIds?: string[]; code?: string },
    decisionRef: string,
    userId: string,
    manager?: EntityManager,
  ): Promise<PayrollException[]> {
    const ref = (decisionRef ?? '').trim();
    if (ref.length < 3) throw new ConflictException('A decision reference is required to acknowledge an exception.');
    const run = await this.em(manager).getRepository(PayrollRun).findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException(`PayrollRun "${runId}" not found.`);
    if (run.status !== 'calculated' && run.status !== 'reviewed') {
      throw new ConflictException(`Exceptions can be acknowledged only while the run is "calculated" or "reviewed" (current: "${run.status}").`);
    }
    await this.sod.assert(runId, 'acknowledge_exception', userId, manager);

    const done: PayrollException[] = [];
    await this.runTx(manager, async (tx) => {
      const repo = tx.getRepository(PayrollException);
      let rows: PayrollException[];
      if (selector.exceptionIds && selector.exceptionIds.length > 0) rows = await repo.find({ where: { payrollRunId: runId, id: In(selector.exceptionIds) } });
      else if (selector.code) rows = await repo.find({ where: { payrollRunId: runId, code: selector.code, status: 'open' } });
      else throw new ConflictException('Provide exceptionIds or a code to acknowledge.');
      if (rows.length === 0) throw new NotFoundException('No matching open exception on this run.');
      for (const row of rows) {
        if (row.impactClass !== 'A_DOC') throw new ConflictException(`Exception "${row.code}" is "${row.impactClass}" and cannot be acknowledged — fix the cause and recalculate.`);
        if (row.status === 'acknowledged') continue;
        row.status = 'acknowledged';
        row.decisionRef = ref;
        row.acknowledgedByUserId = userId;
        row.acknowledgedAt = new Date();
        done.push(await repo.save(row));
      }
      await this.sod.record(runId, 'acknowledge_exception', userId, tx, ref);
      await this.audit.record(
        { actorUserId: userId, organizationId: null, action: 'payroll.exception.acknowledged', resource: 'payroll_run', resourceId: runId, result: 'success', correlationId: null, after: { decisionRef: ref, count: done.length, codes: [...new Set(done.map((d) => d.code))] } },
        tx,
      );
    });
    return done;
  }

  private runTx<T>(manager: EntityManager | undefined, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    const m = this.em(manager);
    return m.queryRunner?.isTransactionActive ? fn(m) : m.transaction(fn);
  }
}
