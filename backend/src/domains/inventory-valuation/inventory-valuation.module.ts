import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryValuationState } from './infrastructure/inventory-valuation-state.entity';
import { InventoryValuationMovement } from './infrastructure/inventory-valuation-movement.entity';
import { COST_ENGINE } from './domain/cost-engine';
import { MovingAverageCostEngine } from './application/moving-average-cost-engine.service';
import { InventoryValuationService } from './application/inventory-valuation.service';
import { InventoryValuationController } from './interface/inventory-valuation.controller';
import { INVENTORY_VALUATION_CONTRACT } from '../../foundation/module-registry/contracts/inventory-events.contract';
import { AuthenticationModule } from '../../foundation/authentication/authentication.module';
import { PermissionModule } from '../../foundation/permission/permission.module';

/**
 * F08 — Inventory Valuation (ADR-041 D1). Ships under the EXISTING
 * `module_code: 'inventory'` manifest — no new licensable module. Code-
 * level separate from `inventory-warehouse` (imports nothing from it) and
 * from `accounting` (imports nothing from it either) — the only thing
 * this module exposes outward is the `INVENTORY_VALUATION_CONTRACT`
 * binding, consumed via DI token, never a direct class import (D18/D18a).
 */
@Module({
  imports: [TypeOrmModule.forFeature([InventoryValuationState, InventoryValuationMovement]), AuthenticationModule, PermissionModule],
  controllers: [InventoryValuationController],
  providers: [
    { provide: COST_ENGINE, useClass: MovingAverageCostEngine },
    InventoryValuationService,
    { provide: INVENTORY_VALUATION_CONTRACT, useExisting: InventoryValuationService },
  ],
  exports: [INVENTORY_VALUATION_CONTRACT],
})
export class InventoryValuationModule {}
