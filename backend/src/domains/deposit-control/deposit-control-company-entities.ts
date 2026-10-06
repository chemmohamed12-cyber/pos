import { Deposit } from './infrastructure/deposit.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Deposit Control's own
 * Company-connection-capable entities — added 2026-09-28 (Area 21
 * Operational Company Scoping Retrofit, `deposits.controller.ts`'s own
 * turn). Found missing entirely (not merely unguarded) by the real-PG
 * isolation spec's first run (`EntityMetadataNotFoundError`) — a genuine
 * production gap, same shape as Delivery's (§34).
 */
export const DEPOSIT_CONTROL_COMPANY_ENTITIES = [Deposit];
