/**
 * Release Center — Controlled Data Repair. Lifecycle of one
 * `DataRepairRun`, mirroring the deploy/restore "deliberate multi-step,
 * never one-click" shape:
 *
 *   audited        -> created + read-only audit captured, nothing changed
 *   planned        -> reviewable old->new mapping generated, still nothing changed
 *   backup_linked  -> a VERIFIED pre-repair backup is tied to this run (the gate)
 *   running        -> the repair transaction is in progress
 *   verifying      -> repair committed, integrity verification in progress
 *   completed      -> repair + integrity verification both passed
 *   failed         -> stopped at some step; see errorMessage (nothing partially committed —
 *                     the repair itself runs in ONE transaction)
 */
export type DataRepairRunStatus =
  | 'audited'
  | 'planned'
  | 'backup_linked'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed';

export type DataRepairKind = 'uuid_rfc4122';
