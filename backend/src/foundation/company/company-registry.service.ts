import { Injectable } from '@nestjs/common';
import { CompanyService } from './company.service';
import { Company } from './company.entity';
import { CompanyStatus, isCompanyVisible, isValidCompanyTransition } from './company-status';

/**
 * Multi-Company Phase 3 V7, Area 2 (Company Registry). CRUD + the
 * lifecycle state machine on top of Area 1's `Company` entity and
 * `CompanyService` (unchanged, reused as the persistence layer — this
 * service does not duplicate it). Every Company this service creates
 * starts at `PROVISIONING`; every write to `status` goes through
 * `transitionTo`, which is the one place the guard in `company-status.ts`
 * is enforced. No controller, no HTTP surface — V7 Area 2's own Change
 * field names only the service, the enum, and the guard logic.
 */
export class InvalidCompanyTransitionError extends Error {
  constructor(from: CompanyStatus, to: CompanyStatus) {
    super(`Invalid Company status transition: ${from} -> ${to}`);
    this.name = 'InvalidCompanyTransitionError';
  }
}

@Injectable()
export class CompanyRegistryService {
  constructor(private readonly companies: CompanyService) {}

  /** New Companies always start at PROVISIONING — the one unambiguous entry point in V7's state chain. */
  async provision(installationId: string, name: string): Promise<Company> {
    return this.companies.create({ installationId, name, status: 'PROVISIONING' });
  }

  /** See `CompanyService.deleteIfUnprovisioned`. */
  discardUnprovisioned(id: string): Promise<boolean> {
    return this.companies.deleteIfUnprovisioned(id);
  }

  async findById(id: string): Promise<Company | null> {
    return this.companies.findById(id);
  }

  /** V7 Area 2 Verification: "no company shown before READY." Everything except PROVISIONING is visible. */
  async listVisible(installationId: string): Promise<Company[]> {
    const all = await this.companies.findByInstallationId(installationId);
    return all.filter((c) => isCompanyVisible(c.status));
  }

  async transitionTo(id: string, to: CompanyStatus): Promise<Company> {
    const company = await this.companies.findById(id);
    if (!company) {
      throw new Error(`Company not found: ${id}`);
    }
    if (!isValidCompanyTransition(company.status, to)) {
      throw new InvalidCompanyTransitionError(company.status, to);
    }
    return this.companies.update(id, { status: to });
  }
}
