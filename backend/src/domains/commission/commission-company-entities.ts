import { CommissionAdjustment } from './infrastructure/commission-adjustment.entity';
import { CommissionApprovalBatch } from './infrastructure/commission-approval-batch.entity';
import { CommissionPolicy } from './infrastructure/commission-policy.entity';
import { CommissionResult } from './infrastructure/commission-result.entity';
import { CommissionTier } from './infrastructure/commission-tier.entity';

/**
 * ADR-074 (Hybrid B). commission's own Company-connection-capable entities — added 2026-10-05 (Area 21, CTO-authorized).
 */
export const COMMISSION_COMPANY_ENTITIES = [CommissionAdjustment, CommissionApprovalBatch, CommissionPolicy, CommissionResult, CommissionTier];
