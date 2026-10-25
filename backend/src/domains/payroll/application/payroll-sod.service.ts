import { ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PayrollRunStageActor, PayrollStage } from '../infrastructure/payroll-run-stage-actor.entity';
import { PayrollSetting } from '../infrastructure/payroll-setting.entity';
import { AuditService } from '../../../foundation/audit/audit.service';

/** A 403 (still a `ForbiddenException`) that keeps its own `code` through the error envelope (`localizable`, honoured by the exception filter) so the screen can localize it. */
export class SodViolationException extends ForbiddenException {
  constructor(message: string, readonly stage: PayrollStage, readonly conflictsWith: PayrollStage) {
    super({ statusCode: 403, code: 'SOD_VIOLATION', message, stage, conflictsWith, localizable: true, params: { stage, conflictsWith } });
  }
}

export type SodProfile = 'standard' | 'strict';
export const SOD_PROFILE_KEY = 'sod_profile';
export const DEFAULT_SOD_PROFILE: SodProfile = 'standard';
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/** One rule: the actor of `stage` must not already be an actor of any stage in `notAlso`. `floor` rules apply in every profile and can never be relaxed. */
interface SodRule {
  stage: PayrollStage;
  notAlso: PayrollStage[];
  profiles: SodProfile[];
  floor?: boolean;
  label: string;
}

/**
 * Addendum A-6 — separation of duties enforced from the RECORDED actors of each stage (`payroll_run_stage_actors`), on the server, for every path that
 * reaches the stage (the Payroll routes, the generic approvals route through the approval hook, direct service calls).
 *
 * Mandatory floor (no profile and no waiver relaxes it): the final approver is neither the preparer nor the submitter of the run.
 * `standard` (default): floor + the acknowledger of an exception is not the preparer + the disburser is not the approver.
 * `strict`: standard + preparer, reviewer, submitter, approver, exception acknowledger are pairwise different, and the reconciler is not the disburser.
 * The `minimal` profile and waivers are NOT implemented (owner decision D-6 pending).
 */
const RULES: SodRule[] = [
  { stage: 'approve', notAlso: ['prepare'], profiles: ['standard', 'strict'], floor: true, label: 'the approver prepared this run' },
  { stage: 'approve', notAlso: ['submit'], profiles: ['standard', 'strict'], floor: true, label: 'the approver submitted this run for approval' },
  { stage: 'approve', notAlso: ['review', 'acknowledge_exception'], profiles: ['strict'], label: 'the approver reviewed this run or acknowledged one of its exceptions' },
  { stage: 'review', notAlso: ['prepare'], profiles: ['strict'], label: 'the reviewer prepared this run' },
  { stage: 'submit', notAlso: ['prepare'], profiles: ['strict'], label: 'the submitter prepared this run' },
  { stage: 'acknowledge_exception', notAlso: ['prepare'], profiles: ['standard', 'strict'], label: 'the person acknowledging an exception prepared this run' },
  { stage: 'disburse', notAlso: ['approve'], profiles: ['standard', 'strict'], label: 'the person disbursing approved this run' },
  { stage: 'reconcile', notAlso: ['disburse'], profiles: ['strict'], label: 'the reconciler disbursed this run' },
];

@Injectable()
export class PayrollSodService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  async getProfile(manager?: EntityManager): Promise<SodProfile> {
    const row = await this.em(manager).getRepository(PayrollSetting).findOne({ where: { key: SOD_PROFILE_KEY } });
    return row?.value === 'strict' ? 'strict' : DEFAULT_SOD_PROFILE;
  }

  async setProfile(profile: SodProfile, actorUserId: string, manager?: EntityManager): Promise<SodProfile> {
    const repo = this.em(manager).getRepository(PayrollSetting);
    const before = await this.getProfile(manager);
    await repo.save(repo.create({ key: SOD_PROFILE_KEY, value: profile, updatedByUserId: actorUserId, updatedAt: new Date() }));
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'payroll.settings.sod_profile_changed', resource: 'payroll_settings', resourceId: null, result: 'success', correlationId: null, before: { profile: before }, after: { profile } },
      manager,
    );
    return profile;
  }

  /** Append-only. Call inside the transaction that performs the stage's own effect. */
  async record(runId: string, stage: PayrollStage, userId: string, manager: EntityManager, note?: string | null): Promise<void> {
    const repo = manager.getRepository(PayrollRunStageActor);
    await repo.save(repo.create({ payrollRunId: runId, stage, userId, note: note ?? null }));
  }

  async actors(runId: string, stage: PayrollStage, manager?: EntityManager): Promise<string[]> {
    const rows = await this.em(manager).getRepository(PayrollRunStageActor).find({ where: { payrollRunId: runId, stage } });
    return [...new Set(rows.map((r) => r.userId))];
  }

  /**
   * Throws `SodViolationException` (403, `code: 'SOD_VIOLATION'`) when `userId` performing `stage` on `runId` breaks a rule of the Company's profile.
   * The refusal is audited with result `denied` on the CALLER's manager (outside any transaction the refusal may roll back).
   */
  async assert(runId: string, stage: PayrollStage, userId: string, manager?: EntityManager): Promise<void> {
    if (userId === SYSTEM_ACTOR_ID) return;
    const profile = await this.getProfile(manager);
    for (const rule of RULES) {
      if (rule.stage !== stage || !rule.profiles.includes(profile)) continue;
      for (const other of rule.notAlso) {
        const actors = await this.actors(runId, other, manager);
        if (actors.includes(userId)) {
          const message = `Segregation of duties (${rule.floor ? 'mandatory' : profile} profile): ${rule.label}.`;
          await this.audit
            .record(
              { actorUserId: userId, organizationId: null, action: 'payroll.sod.refused', resource: 'payroll_run', resourceId: runId, result: 'denied', correlationId: null, after: { stage, conflictsWith: other, profile, floor: !!rule.floor } },
              manager,
            )
            .catch(() => undefined);
          throw new SodViolationException(message, stage, other);
        }
      }
    }
  }
}
