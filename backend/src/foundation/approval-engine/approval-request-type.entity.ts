import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * FA-01 (contract §3). One registered class of approvable action —
 * analogous to `NumberingService.registerDocumentType`. A consuming
 * module registers it once at init:
 *   ApprovalEngineService.registerRequestType(
 *     'accounting.fiscal_period.reopen', 'action.reopen_fiscal_period')
 *
 * `requestTypeCode` is a permission-node-shaped string and IS the key —
 * a request type has no separate surrogate id.
 */
@Entity('approval_request_types')
export class ApprovalRequestType {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  requestTypeCode!: string;

  @Column({ type: 'varchar', length: 128 })
  titleCode!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
