import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Company } from './company.entity';

/**
 * Multi-Company Phase 3 V7, Area 1. Bare repository wrapper only — no
 * lifecycle or state-machine logic (that is Area 2's CompanyRegistryService,
 * which uses this class as its persistence layer rather than duplicating
 * it). Exists so Area 1's own Verification requirement ("unit tests on the
 * entity/service") has a service to test without pre-empting Area 2's
 * design. `update` was added for Area 2's use (it did not exist in Area 1's
 * original scope, which had no writer for an existing row) — still a plain
 * persistence primitive, no transition validation of its own.
 */
@Injectable()
export class CompanyService {
  constructor(@InjectRepository(Company) private readonly companies: Repository<Company>) {}

  async create(data: Pick<Company, 'installationId' | 'name' | 'status'>): Promise<Company> {
    const company = this.companies.create(data);
    return this.companies.save(company);
  }

  async findById(id: string): Promise<Company | null> {
    return this.companies.findOne({ where: { id } });
  }

  async findByInstallationId(installationId: string): Promise<Company[]> {
    return this.companies.find({ where: { installationId } });
  }

  /** Backend Integration Dependency (2026-09-25, `GET /memberships/mine`) — enriches a set of Membership rows with each Company's existing `name`/`status`, no new fields invented. Empty array in, empty array out (no `IN ()` query against zero ids). */
  async findByIds(ids: string[]): Promise<Company[]> {
    if (ids.length === 0) return [];
    return this.companies.find({ where: { id: In(ids) } });
  }

  async update(id: string, data: Partial<Pick<Company, 'name' | 'status'>>): Promise<Company> {
    await this.companies.update({ id }, data);
    const updated = await this.findById(id);
    if (!updated) {
      throw new Error(`Company not found after update: ${id}`);
    }
    return updated;
  }
}
