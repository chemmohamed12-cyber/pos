import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export interface ClosingAuditException {
  /** 'blocking' hard-blocks `FiscalPeriodService.submitPeriodClose` (ADR-050); 'informational' never does. */
  severity: 'blocking' | 'informational';
  domain: 'ap' | 'ar' | 'cash_bank' | 'inventory' | 'fixed_asset' | 'financial_events';
  code: string;
  message: string;
  refId: string | null;
}

/**
 * ADR-050 — Period Closing Audit Engine. One aggregation run over the five
 * existing reconciliation services plus in-period REJECTED financial events,
 * for a single `FiscalPeriod`. Read-only, like every reconciliation run this
 * mirrors — it never posts a correcting entry and never mutates a source
 * record.
 */
@Entity('accounting_closing_audit_runs')
export class ClosingAuditRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  fiscalPeriodId!: string;

  @Column({ type: 'date' })
  asOfDate!: string;

  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'varchar', length: 24 })
  status!: 'clean' | 'exceptions_found';

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  exceptions!: ClosingAuditException[];

  @Column({ type: 'uuid' })
  runByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
