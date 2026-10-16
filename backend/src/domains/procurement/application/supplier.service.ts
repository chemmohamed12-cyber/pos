import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Supplier, SupplierType } from '../infrastructure/supplier.entity';
import { SupplierContact } from '../infrastructure/supplier-contact.entity';
import { SupplierAddress } from '../infrastructure/supplier-address.entity';
import { SupplierBankAccount } from '../infrastructure/supplier-bank-account.entity';
import { canTransitionSupplierStatus, SupplierStatus } from '../domain/supplier-status';
import { AuditService } from '../../../foundation/audit/audit.service';
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { PROFILE_LANGUAGES, profileEmail, profileOneOf, profileText, profileWebsite } from '../../../foundation/profile/profile-validation';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

/** D9 — supplier codes are issued by the numbering engine ("SUP-000001"); no year segment (a supplier is not a yearly document). */
export const SUPPLIER_DOCUMENT_TYPE = 'supplier';
const SUPPLIER_PREFIX = 'SUP';

export interface CreateSupplierInput {
  /** D9 — optional: omitted = auto-numbered. An explicit code is still accepted (data migration) and must be unique. */
  code?: string | null;
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

/** D9 — editable master data. `code` is deliberately absent (immutable once issued); status has its own transition route; bank accounts stay approval-gated. */
export interface UpdateSupplierInput {
  legalName?: string;
  tradingName?: string | null;
  supplierType?: SupplierType;
  taxRegistrationNumber?: string | null;
  vatRegistrationNumber?: string | null;
  commercialRegistrationNumber?: string | null;
  paymentTermsDays?: number;
  creditLimitBase?: string | null;
  // Supplier profile (gap matrix §5.3): nullable descriptive fields; blank clears, undefined leaves untouched.
  email?: string | null;
  website?: string | null;
  language?: string | null;
  internalNotes?: string | null;
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
    private readonly numbering: NumberingService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

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

  async list(status?: SupplierStatus, manager?: EntityManager): Promise<Supplier[]> {
    const repo = this.em(manager).getRepository(Supplier);
    return repo.find({ where: status ? { status } : {}, order: { legalName: 'ASC' } });
  }

  /** Name-primary lookup for a searchable combobox — mirrors `/products/all`'s shape and usage. */
  async listAllActive(manager?: EntityManager): Promise<Array<{ id: string; code: string; legalName: string }>> {
    const repo = this.em(manager).getRepository(Supplier);
    const rows = await repo.find({ where: { status: 'active' }, order: { legalName: 'ASC' } });
    return rows.map((s) => ({ id: s.id, code: s.code, legalName: s.legalName }));
  }

  async getById(id: string, manager?: EntityManager): Promise<{ supplier: Supplier; contacts: SupplierContact[]; addresses: SupplierAddress[]; bankAccounts: SupplierBankAccount[] }> {
    const supplier = await this.em(manager).getRepository(Supplier).findOne({ where: { id } });
    if (!supplier) throw new NotFoundException(`Supplier "${id}" not found.`);
    const [contacts, addresses, bankAccounts] = await Promise.all([
      this.em(manager).getRepository(SupplierContact).find({ where: { supplierId: id }, order: { createdAt: 'ASC' } }),
      this.em(manager).getRepository(SupplierAddress).find({ where: { supplierId: id }, order: { createdAt: 'ASC' } }),
      this.em(manager).getRepository(SupplierBankAccount).find({ where: { supplierId: id }, order: { createdAt: 'ASC' } }),
    ]);
    await Promise.all(bankAccounts.map((b) => this.syncBankAccountApproval(b, manager)));
    return { supplier, contacts, addresses, bankAccounts };
  }

  async create(input: CreateSupplierInput, actorUserId: string, manager?: EntityManager): Promise<Supplier> {
    const repo = this.em(manager).getRepository(Supplier);
    const explicit = input.code?.trim();
    let code: string;
    if (explicit) {
      if (await repo.findOne({ where: { code: explicit } })) {
        throw new ConflictException(`Supplier code "${explicit}" is already in use.`);
      }
      code = explicit;
    } else {
      await this.numbering.registerDocumentType(SUPPLIER_DOCUMENT_TYPE, SUPPLIER_PREFIX, false, manager);
      // A hand-typed legacy code may collide with the sequence — skip forward (bounded), never reuse.
      code = '';
      for (let i = 0; i < 20 && !code; i++) {
        const candidate = await this.numbering.getNextNumber(SUPPLIER_DOCUMENT_TYPE, manager);
        if (!(await repo.findOne({ where: { code: candidate } }))) code = candidate;
      }
      if (!code) throw new ConflictException('Could not issue a unique supplier code; contact an administrator.');
    }
    const saved = await repo.save(
      repo.create({
        code,
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
    }, manager);
    return saved;
  }

  /**
   * D9 — edit supplier master data. Allowed at any time (a legal-name correction or a late VAT registration number must not be
   * blocked by history): documents already issued keep their own snapshots/ids, and the ledger keys on supplierId, never on the
   * name. `code` is immutable. The VAT registration number is read live by the D5 supplier-invoice VAT rule (VAT > 0 requires it),
   * so editing it takes effect on the next invoice posting. Bank accounts are NOT edited here (approval-gated, maker-checker).
   */
  async updateSupplier(id: string, input: UpdateSupplierInput, actorUserId: string, manager?: EntityManager): Promise<Supplier> {
    const repo = this.em(manager).getRepository(Supplier);
    const supplier = await repo.findOne({ where: { id } });
    if (!supplier) throw new NotFoundException(`Supplier "${id}" not found.`);
    // The four profile fields are validated up front (a clear 400 before anything is written); the existing fields keep their own rules below.
    const normalized: UpdateSupplierInput = {
      ...input,
      email: profileEmail(input.email),
      website: profileWebsite(input.website),
      language: profileOneOf('language', input.language, PROFILE_LANGUAGES),
      internalNotes: profileText('internalNotes', input.internalNotes, 4000),
    };
    const fields: Array<keyof UpdateSupplierInput> = [
      'legalName', 'tradingName', 'supplierType', 'taxRegistrationNumber', 'vatRegistrationNumber',
      'commercialRegistrationNumber', 'paymentTermsDays', 'creditLimitBase', 'email', 'website', 'language', 'internalNotes',
    ];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const f of fields) {
      if (normalized[f] === undefined) continue;
      let next: unknown = normalized[f];
      if (typeof next === 'string' && f !== 'creditLimitBase') next = next.trim() === '' ? null : next.trim();
      if (f === 'legalName' && !next) throw new ConflictException('Supplier legal name cannot be empty.');
      if (f === 'supplierType' && !next) continue;
      if (f === 'paymentTermsDays' && next === null) next = 0;
      const current = (supplier as unknown as Record<string, unknown>)[f];
      if (String(current ?? '') === String(next ?? '')) continue; // unchanged
      before[f] = current ?? null;
      after[f] = next;
      (supplier as unknown as Record<string, unknown>)[f] = next;
    }
    if (Object.keys(after).length === 0) return supplier; // nothing to change — no write, no audit noise
    const saved = await repo.save(supplier);
    await this.audit.record({
      actorUserId,
      organizationId: null,
      action: 'supplier.updated',
      resource: 'supplier',
      resourceId: id,
      result: 'success',
      correlationId: id,
      before,
      after,
    }, manager);
    return saved;
  }

  async setStatus(id: string, status: SupplierStatus, actorUserId: string, manager?: EntityManager): Promise<Supplier> {
    const repo = this.em(manager).getRepository(Supplier);
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
    }, manager);
    return supplier;
  }

  async addContact(supplierId: string, input: { name: string; title?: string | null; phone?: string | null; email?: string | null; isPrimary?: boolean }, manager?: EntityManager): Promise<SupplierContact> {
    await this.requireSupplier(supplierId, manager);
    const em = this.em(manager);
    const run = async (tx: EntityManager): Promise<SupplierContact> => {
      const repo = tx.getRepository(SupplierContact);
      if (input.isPrimary) await repo.update({ supplierId }, { isPrimary: false }); // one primary contact at a time
      return repo.save(repo.create({ supplierId, name: input.name, title: input.title ?? null, phone: input.phone ?? null, email: input.email ?? null, isPrimary: input.isPrimary ?? false }));
    };
    return em.queryRunner?.isTransactionActive ? run(em) : em.transaction(run);
  }

  async addAddress(supplierId: string, input: { label?: string | null; addressLine: string; city?: string | null; governorate?: string | null; isDefault?: boolean }, manager?: EntityManager): Promise<SupplierAddress> {
    await this.requireSupplier(supplierId, manager);
    const em = this.em(manager);
    const run = async (tx: EntityManager): Promise<SupplierAddress> => {
      const repo = tx.getRepository(SupplierAddress);
      if (input.isDefault) await repo.update({ supplierId }, { isDefault: false }); // one default address at a time
      return repo.save(repo.create({ supplierId, label: input.label ?? null, addressLine: input.addressLine, city: input.city ?? null, governorate: input.governorate ?? null, isDefault: input.isDefault ?? false }));
    };
    return em.queryRunner?.isTransactionActive ? run(em) : em.transaction(run);
  }

  /**
   * Submits the change to the Approval Engine and creates the row as
   * `pending` — it becomes usable for a Supplier Payment only once
   * `syncBankAccountApproval` observes the request decided `approved`.
   */
  async addBankAccount(
    supplierId: string,
    input: { bankName: string; accountNumber: string; iban?: string | null; swift?: string | null; isPrimary?: boolean },
    actorUserId: string, manager?: EntityManager): Promise<SupplierBankAccount> {
    await this.requireSupplier(supplierId, manager);

    const repo = this.em(manager).getRepository(SupplierBankAccount);
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
    }, manager);
    saved.approvalRequestId = request.id;
    await repo.save(saved);
    return saved;
  }

  /** Read-repair: reflects the Approval Engine's current decision onto the local cache column. */
  private async syncBankAccountApproval(bankAccount: SupplierBankAccount, manager?: EntityManager): Promise<void> {
    if (!bankAccount.approvalRequestId || bankAccount.approvalStatus !== 'pending') return;
    const request = await this.approvals.getRequest(bankAccount.approvalRequestId, manager);
    if (request.state === 'approved') {
      bankAccount.approvalStatus = 'approved';
      await this.em(manager).getRepository(SupplierBankAccount).save(bankAccount);
    } else if (request.state === 'rejected') {
      bankAccount.approvalStatus = 'rejected';
      await this.em(manager).getRepository(SupplierBankAccount).save(bankAccount);
    }
  }

  private async requireSupplier(id: string, manager?: EntityManager): Promise<void> {
    const exists = await this.em(manager).getRepository(Supplier).findOne({ where: { id } });
    if (!exists) throw new NotFoundException(`Supplier "${id}" not found.`);
  }
}
