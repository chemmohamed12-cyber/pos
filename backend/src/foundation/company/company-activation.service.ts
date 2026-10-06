import { Injectable } from '@nestjs/common';
import { CompanyRegistryService } from './company-registry.service';
import { Company } from './company.entity';

/**
 * Multi-Company Phase 3 V7, Area 19 (Company Activation/Deactivation).
 * Operational triggers on top of Area 2's already-built state machine —
 * this class adds no new transitions of its own; it only names the
 * ones Area 2's `isValidCompanyTransition` already allows.
 *
 * V7 names three triggers: suspend, reactivate, decommission.
 *
 * "reactivate" (Area 2/Area 19 decision, recorded 2026-09-22): any of
 * DEGRADED/SUSPENDED/MIGRATING/FAILED → READY is allowed, with no
 * distinct policy for FAILED — it delegates to `transitionTo`, which
 * itself rejects a reactivation attempt from any other status (e.g.
 * PROVISIONING, DECOMMISSIONED).
 *
 * "decommission" is narrower than it may first appear: Area 2's chain
 * only allows {DEGRADED,SUSPENDED,MIGRATING,FAILED} → DECOMMISSIONED,
 * never READY → DECOMMISSIONED directly (confirmed intentional by the
 * same 2026-09-22 decision — a READY Company must pass through one of
 * the four intermediate states first). `decommission()` is implemented
 * exactly as the transition table allows, not expanded to cover READY.
 */
@Injectable()
export class CompanyActivationService {
  constructor(private readonly companyRegistry: CompanyRegistryService) {}

  /** READY -> SUSPENDED. The only "deactivate" direction Area 2's table actually allows from READY. */
  async suspend(companyId: string): Promise<Company> {
    return this.companyRegistry.transitionTo(companyId, 'SUSPENDED');
  }

  /** DEGRADED/SUSPENDED/MIGRATING/FAILED -> READY. Invalid source statuses are rejected by `transitionTo` itself. */
  async reactivate(companyId: string): Promise<Company> {
    return this.companyRegistry.transitionTo(companyId, 'READY');
  }

  /** DEGRADED/SUSPENDED/MIGRATING/FAILED -> DECOMMISSIONED, exactly as Area 2's table allows. Not extended to cover READY -> DECOMMISSIONED directly — that arrow does not exist in V7's literal chain either. */
  async decommission(companyId: string): Promise<Company> {
    return this.companyRegistry.transitionTo(companyId, 'DECOMMISSIONED');
  }
}
