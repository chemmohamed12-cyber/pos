import { InventoryValuationMovement } from './infrastructure/inventory-valuation-movement.entity';
import { InventoryValuationState } from './infrastructure/inventory-valuation-state.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). Inventory Valuation's own
 * Company-connection-capable entities (`MovingAverageCostEngine`, reached
 * via `InventoryValuationService`).
 */
export const INVENTORY_VALUATION_COMPANY_ENTITIES = [InventoryValuationMovement, InventoryValuationState];
