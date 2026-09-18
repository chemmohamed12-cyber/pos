import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SupplierBankAccountApprovalStatus = 'pending' | 'approved' | 'rejected';

/**
 * CTO directive (2026-09-17): a supplier bank-account change gets the
 * "stronger approval/audit treatment" every other financially-sensitive
 * change in this codebase gets — routed through the existing generic
 * Approval/Maker-Checker Engine (`foundation/approval-engine`, ADR-033),
 * never a bespoke second approval mechanism. `approvalRequestId` is the
 * real `ApprovalRequest.id`; `approvalStatus` is a local read-repair
 * cache synced from `ApprovalEngineService.getRequest` on read (see
 * `SupplierBankAccountsService.syncApprovalStatus`) — never authoritative
 * on its own. A bank account is usable for a Supplier Payment only once
 * `approvalStatus === 'approved'`.
 */
@Entity('supplier_bank_accounts')
export class SupplierBankAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  supplierId!: string;

  @Column({ type: 'varchar', length: 255 })
  bankName!: string;

  @Column({ type: 'varchar', length: 64 })
  accountNumber!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  iban!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  swift!: string | null;

  @Column({ type: 'boolean', default: false })
  isPrimary!: boolean;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  approvalStatus!: SupplierBankAccountApprovalStatus;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  approvalRequestId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
