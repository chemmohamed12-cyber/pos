import { Target } from './infrastructure/target.entity';

/**
 * ADR-074 (Hybrid B). Targets' own Company-connection-capable entities — added 2026-10-05
 * (Area 21, CTO-authorized: `target.controller.ts`).
 */
export const TARGETS_COMPANY_ENTITIES = [Target];
