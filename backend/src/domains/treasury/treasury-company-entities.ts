import { TreasuryAccount } from './infrastructure/treasury-account.entity';
import { TreasuryAccountType } from './infrastructure/treasury-account-type.entity';
import { TreasuryTransaction } from './infrastructure/treasury-transaction.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Treasury's own
 * Company-connection-capable entities (`TreasuryService`, reached
 * transitively today via `ClosingSnapshotService`'s injected
 * `FINANCE_TREASURY_CONTRACT`).
 */
export const TREASURY_COMPANY_ENTITIES = [TreasuryAccount, TreasuryAccountType, TreasuryTransaction];
