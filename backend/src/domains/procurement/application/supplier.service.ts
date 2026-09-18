import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Supplier, SupplierType } from '../infrastructure/supplier.entity';
import { SupplierContact } from '../infrastructure/supplier-contact.entity';
import { SupplierAddress } from '../infrastructure/supplier-address.entity';
import { SupplierBankAccount } from '../infrastructure/supplier-bank-account.entity';
import { canTransitionSupplierStatus, SupplierStatus } from '../domain/supplier-status';
import { AuditService } from '../../../foundation/audit/audit.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export interface CreateSupplierInput {
  code: string;
  legalName: string;
  tradingName?: string | null;
  supplierType?: SupplierType;
  taxRegistrationNumber?: string | null;
  vatRegistrationNumber?: string | null;
  commercialRegistrationNumber?: string | null;
  paymentTermsDays?: number;
  creditLimitBase?: string | null;
  orgUnitId?: string | null;
}

const BANK_ACCOUNT_REQUEST_TYPE = 'procurement.bank_account_change';

/**
 * ADR-048 — Procurement's Supplier Master. A real aggregate root:
 * Contacts/Addresses/BankAccounts are child tables loaded alongside it,
 * never denormalized onto Supplier itself. Bank-account changes route
 * through the existing generic Approval Engine (ADR-033) rather than a
 * bespoke second approval mechanism — see `SupplierBankAccount`'s class
 * doc comment.
 *
 * P0 correction (OP-Procurement/AP Blueprint, CTO ratification Decision 6,
 * applied 2026-09-18) — `procurement.bank_account_change` is registered
 * with a matrix rule of `minApprovers: 2` at bootstrap (`onModuleInit`,
 * same pattern `ApAdjustmentService` already uses for `AP_ADJUSTMENT_META`):
 * the Approval Engine's own unique-decision-per-approver constraint
 * (`ApprovalEngineService.decide`) already rejects a second decision from
 * the SAME approver, so `minApprovers: 2` is exactly "two distinct
 * checkers" — no separate sequencing flag exists or is needed. Previously
 * this request type was registered with no matrix rule at all, silently
 * falling back to `minApprovers: 1` — a single approver could unilaterally
 * approve a bank-account change despite the ratified 2-person requirement.
 */
@Injectable()
export class SupplierService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalEngineService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.approvals.registerRequestType(BANK_ACCOUNT_REQUEST_TYPE, 'action.supplier_bank_account_change');
    await this.approvals
      .upsertMatrixRule(
        {
          requestTypeCode: BANK_ACCOUNT_REQUEST_TYPE,
          minApprovers: 2,
          requiredPermissionNode: 'procurement.bank_account.edit',
          valueThreshold: null, // CTO ratification Decision 6 — always gated, no exception
          orgUnitId: null,
        },
        SYSTEM_ACTOR,
      )
      .catch(() => undefined); // idempotent-ish; a concurrent init is harmless
  }

  async list(status?: SupplierStatus): Promise<Supplier[]> {
    const repo = this.dataSource.getRepository(Supplier);
    return repo.find({ where: status ? { status } : {}, order: { legalName: 'ASC' } });
  }

  /** Name-primary lookup for a searchable combobox — mirrors `/products/all`'s shape and usage. */
  async listAllActive(): Promise<Array<{ id: string; code: string; legalName: string }>> {
    const repo = this.dataSource.getRepository(Supplier);
    const rows = await repo.find({ where: { status: 'active' }, order: { legalName: 'ASC' } });
    return rows.map((s) => ({ id: s.id, code: s.code, legalName: s.legalName }));
  }

  async getById(id: string): Promise<{ supplier: Supplier; contacts: SupplierContact[]; addresses: SupplierAddress[]; bankAccounts: SupplierBankAccount[] }> {
    const supplier = await this.dataSource.getRepository(Supplier).findOne({ where: { id } });
    if (!supplier) throw new NotFoundException(`Supplier "${id}" not found.`);
    const [contacts, addresses, bankAccounts] = await Promise.all([
      this.dataSource.getRepository(SupplierContact).find({ where: { supplierId: id }, order: { createdAt: 'ASC' } }),
      this.dataSource.getRepository(SupplierAddress).find({ where: { supplierId: id }, order: { createdAt: 'ASC' } }),
      this.dataSource.getRepository(SupplierBankAccount).find({ where: { supplierId: id }, order: { createdAt: 'ASC' } }),
    ]);
    await Promise.all(bankAccounts.map((b) => this.syncBankAccountApproval(b)));
    return { supplier, contacts, addresses, bankAccounts };
  }

  async create(input: CreateSupplierInput, actorUserId: string): Promise<Supplier> {
    const repo = this.dataSource.getRepository(Supplier);
    if (await repo.findOne({ where: { code: input.code } })) {
      throw new ConflictException(`Supplier code "${input.code}" is already in use.`);
    }
    const saved = await repo.save(
      repo.create({
        code: input.code,
        legalName: input.legalName,
        tradingName: input.tradingName ?? null,
        supplierType: input.supplierType ?? 'company',
        taxRegistrationNumber: input.taxRegistrationNumber ?? null,
        vatRegistrationNumber: input.vatRegistrationNumber ?? null,
        commercialRegistrationNumber: input.commercialRegistrationNumber ?? null,
        paymentTermsDays: input.paymentTermsDays ?? 0,
        creditLimitBase: input.creditLimitBase ?? null,
        status: 'active',
        orgUnitId: input.orgUnitId ?? null,
        createdByUserId: actorUserId,
      }),
    );
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'supplier.created',
      resource: 'supplier',
      resourceId: saved.id,
      result: 'success',
      correlationId: saved.id,
      after: { code: saved.code, legalName: saved.legalName },
    });
    return saved;
  }

  async setStatus(id: string, status: SupplierStatus, actorUserId: string): Promise<Supplier> {
    const repo = this.dataSource.getRepository(Supplier);
    const supplier = await repo.findOne({ where: { id } });
    if (!supplier) throw new NotFoundException(`Supplier "${id}" not found.`);
    if (!canTransitionSupplierStatus(supplier.status, status)) {
      throw new ConflictException(`Cannot transition supplier from "${supplier.status}" to "${status}".`);
    }
    const before = supplier.status;
    supplier.status = status;
    await repo.save(supplier);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'supplier.status_changed',
      resource: 'supplier',
      resourceId: id,
      result: 'success',
      correlationId: id,
      before: { status: before },
      after: { status },
    });
    return supplier;
  }

  async addContact(supplierId: string, input: { name: string; title?: string | null; phone?: string | null; email?: string | null; isPrimary?: boolean }): Promise<SupplierContact> {
    await this.requireSupplier(supplierId);
    const repo = this.dataSource.getRepository(SupplierContact);
    return repo.save(repo.create({ supplierId, name: input.name, title: input.title ?? null, phone: input.phone ?? null, email: input.email ?? null, isPrimary: input.isPrimary ?? false }));
  }

  async addAddress(supplierId: string, input: { label?: string | null; addressLine: string; city?: string | null; governorate?: string | null; isDefault?: boolean }): Promise<SupplierAddress> {
    await this.requireSupplier(supplierId);
    const repo = this.dataSource.getRepository(SupplierAddress);
    return repo.save(repo.create({ supplierId, label: input.label ?? null, addressLine: input.addressLine, city: input.city ?? null, governorate: input.governorate ?? null, isDefault: input.isDefault ?? false }));
  }

  /**
   * Submits the change to the Approval Engine and creates the row as
   * `pending` — it becomes usable for a Supplier Payment only once
   * `syncBankAccountApproval` observes the request decided `approved`.
   */
  async addBankAccount(
    supplierId: string,
    input: { bankName: string; accountNumber: string; iban?: string | null; swift?: string | null; isPrimary?: boolean },
    actorUserId: string,
  ): Promise<SupplierBankAccount> {
    await this.requireSupplier(supplierId);

    const repo = this.dataSource.getRepository(SupplierBankAccount);
    const saved = await repo.save(
      repo.create({
        supplierId,
        bankName: input.bankName,
        accountNumber: input.accountNumber,
        iban: input.iban ?? null,
        swift: input.swift ?? null,
        isPrimary: input.isPrimary ?? false,
        approvalStatus: 'pending',
        createdByUserId: actorUserId,
      }),
    );

    const request = await this.approvals.submit({
      requestTypeCode: BANK_ACCOUNT_REQUEST_TYPE,
      resourceType: 'supplier_bank_account',
      resourceId: saved.id,
      requestedAction: 'add',
      payload: { supplierId, bankName: input.bankName, accountNumber: input.accountNumber, iban: input.iban ?? null },
      makerUserId: actorUserId,
    });
    saved.approvalRequestId = request.id;
    await repo.save(saved);
    return saved;
  }

  /** Read-repair: reflects the Approval Engine's current decision onto the local cache column. */
  private async syncBankAccountApproval(bankAccount: SupplierBankAccount): Promise<void> {
    if (!bankAccount.approvalRequestId || bankAccount.approvalStatus !== 'pending') return;
    const request = await this.approvals.getRequest(bankAccount.approvalRequestId);
    if (request.state === 'approved') {
      bankAccount.approvalStatus = 'approved';
      await this.dataSource.getRepository(SupplierBankAccount).save(bankAccount);
    } else if (request.state === 'rejected') {
      bankAccount.approvalStatus = 'rejected';
      await this.dataSource.getRepository(SupplierBankAccount).save(bankAccount);
    }
  }

  private async requireSupplier(id: string): Promise<void> {
    const exists = await this.dataSource.getRepository(Supplier).findOne({ where: { id } });
    if (!exists) throw new NotFoundException(`Supplier "${id}" not found.`);
  }
}
