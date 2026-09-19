import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { InventoryValuationContract } from '../../../foundation/module-registry/contracts/inventory-events.contract';
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

  async getUnitCost(productId: string, warehouseId: string, _asOfDate?: string, manager?: EntityManager): Promise<{ unitCostBase: string } | null> {
    return this.costEngine.resolveIssueCost(productId, warehouseId, manager);
  }

  async consumeIssueCost(
    productId: string,
    warehouseId: string,
    quantity: number,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<{ unitCostBase: string; totalCostBase: string } | { rejected: 'negative_on_hand' } | null> {
    return this.costEngine.applyIssue(productId, warehouseId, quantity, idempotencyKey, manager);
  }

  async recordReceiptCost(
    productId: string,
    warehouseId: string,
    quantity: number,
    unitCostBase: string,
    idempotencyKey: string,
    manager?: EntityManager,
  ): Promise<void> {
    return this.costEngine.applyReceipt(productId, warehouseId, quantity, unitCostBase, idempotencyKey, manager);
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
