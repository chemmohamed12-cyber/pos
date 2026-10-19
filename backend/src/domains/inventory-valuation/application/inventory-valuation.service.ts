import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { HistoryInconsistency, InventoryValuationContract, ValuedPosition, ValuedPositionFilter } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { COST_ENGINE, CostEngine } from '../domain/cost-engine';

/**
 * F08 — Inventory Valuation (ADR-041 D18/D18b). Implements the EXTERNAL
 * `InventoryValuationContract` — the ONLY thing `accounting` (F07's
 * handler bridge, F07's reconciliation service) is allowed to depend on;
 * neither the `CostEngine` interface nor `MovingAverageCostEngine`'s
 * concrete class is ever imported outside this domain.
 *
 * `getUnitCost` stays genuinely pure (composes `CostEngine.resolveIssueCost`
 * only). `consumeIssueCost` is the mutating method (composes
 * `resolveIssueCost` + `applyIssue`) — the ONLY method F07's handler
 * bridge calls, always inside the shared GL-posting transaction.
 */
@Injectable()
export class InventoryValuationService implements InventoryValuationContract {
  constructor(@Inject(COST_ENGINE) private readonly costEngine: CostEngine) {}

  async getValuedOnHandTotal(asOfDate?: string, manager?: EntityManager): Promise<Array<{ warehouseId: string; totalValueBase: string }>> {
    return this.costEngine.getValuedOnHandTotal(asOfDate, manager);
  }

  async getValuedPositions(asOfDate?: string, filter?: ValuedPositionFilter, manager?: EntityManager): Promise<ValuedPosition[]> {
    return this.costEngine.getValuedPositions(asOfDate, filter, manager);
  }

  async checkHistoryConsistency(manager?: EntityManager): Promise<HistoryInconsistency[]> {
    return this.costEngine.checkHistoryConsistency(manager);
  }

  async getUnitCost(productId: string, warehouseId: string, _asOfDate?: string, manager?: EntityManager): Promise<{ unitCostBase: string } | null> {
    return this.costEngine.resolveIssueCost(productId, warehouseId, manager);
  }

  async consumeIssueCost(
    productId: string,
    warehouseId: string,
    quantity: number,
    idempotencyKey: string,
    manager?: EntityManager,
    businessDate?: string,
  ): Promise<{ unitCostBase: string; totalCostBase: string } | { rejected: 'negative_on_hand' } | null> {
    return this.costEngine.applyIssue(productId, warehouseId, quantity, idempotencyKey, manager, businessDate);
  }

  async getIssueCostsByKeys(idempotencyKeys: string[], manager?: EntityManager): Promise<Array<{ idempotencyKey: string; quantity: number; valueBase: string }>> {
    return this.costEngine.getIssueCostsByKeys(idempotencyKeys, manager);
  }

  /** C4 - the offsetting history row of a recorded receipt (see the contract); returns the value that was reversed. */
  async reverseReceiptCost(originalIdempotencyKey: string, reversalIdempotencyKey: string, manager?: EntityManager, businessDate?: string): Promise<{ valueBase: string } | null> {
    return this.costEngine.applyReversal(originalIdempotencyKey, reversalIdempotencyKey, manager, businessDate);
  }

  async recordReceiptCost(
    productId: string,
    warehouseId: string,
    quantity: number,
    unitCostBase: string,
    idempotencyKey: string,
    manager?: EntityManager,
    businessDate?: string,
  ): Promise<void> {
    return this.costEngine.applyReceipt(productId, warehouseId, quantity, unitCostBase, idempotencyKey, manager, businessDate);
  }

  async consumeManufacturingPooledCost(
    productId: string,
    warehouseId: string,
    quantity: number,
    appliedValueBase: string,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<{ appliedValueBase: string } | { rejected: 'negative_on_hand' | 'value_exceeds_on_hand' } | null> {
    return this.costEngine.applyPolicyValuedIssue(productId, warehouseId, quantity, appliedValueBase, idempotencyKey, manager);
  }
}
