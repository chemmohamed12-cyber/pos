import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { FinancialEventHandlerRegistry, HandlerResult } from './handler-registry';
import { INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../../foundation/module-registry/contracts/inventory-events.contract';

const COGS_ACCOUNT_CONFIG_KEY = 'accounting.inventory_cogs_account_code';
const MOVEMENT_TOPIC = 'inventory.movement.recorded';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}

/**
 * F08 — Inventory Valuation (ADR-041 D18/D18a/D18b). Supersedes F07's
 * `inventory-movement.handler.ts` (deleted) — that file's handler is
 * registered in the stateless `V1_FINANCE_HANDLERS` map and reads cost
 * only from `event.payload`, which can never work for a real mutating
 * cost source. This service self-registers instead (the SAME pattern
 * `InventoryAdjustmentService` already uses for its own internal event),
 * because IT needs a real dependency (`INVENTORY_VALUATION_CONTRACT`) the
 * stateless map has no way to inject.
 *
 * **Depends on the INTERFACE ONLY** — `INVENTORY_VALUATION_CONTRACT`, a
 * DI token. Never imports a concrete class from `domains/inventory-valuation`.
 * `F07 → InventoryValuationContract → F08` stays a real interface
 * boundary (CTO ruling, 2026-09-11).
 *
 * Calls `consumeIssueCost` — the ONE mutating contract method — with
 * `ctx.manager`, so the valuation mutation commits or rolls back together
 * with the GL journal this handler's own draft feeds (ADR-041 D18a: the
 * whole handler-through-posting span is one shared transaction).
 *
 * Account resolution and the Dr COGS / Cr Inventory-Asset draft shape are
 * unchanged from F07's original handler — no hard-coded account codes,
 * fail-closed on every missing input.
 */
@Injectable()
export class InventoryCostingHandlerService implements OnModuleInit {
  constructor(
    private readonly registry: FinancialEventHandlerRegistry,
    @Inject(INVENTORY_VALUATION_CONTRACT) private readonly valuation: InventoryValuationContract,
  ) {}

  onModuleInit(): void {
    if (this.registry.get(MOVEMENT_TOPIC)) return;
    this.registry.register(MOVEMENT_TOPIC, async (event, ctx): Promise<HandlerResult> => {
      const p = event.payload;
      const productId = str(p.productId);
      const warehouseId = str(p.warehouseId);
      const quantity = typeof p.quantity === 'number' ? p.quantity : Number(p.quantity ?? 0);
      const idempotencyKey = str(p.idempotencyKey) ?? event.idempotencyKey;

      if (!productId || !warehouseId || !Number.isFinite(quantity) || quantity === 0) {
        return { kind: 'rejected', reason: 'inventory movement: missing/invalid productId, warehouseId, or quantity' };
      }

      // ADR-041 D3/D8 — this is the ONLY place a cost is resolved: never event.payload, never a
      // selling price, never an inference. `consumeIssueCost` mutates atomically with GL posting
      // (ctx.manager) and fails closed (`null`) when no valuation state exists yet.
      const consumed = await this.valuation.consumeIssueCost(productId, warehouseId, Math.abs(quantity), idempotencyKey, ctx.manager);
      if (!consumed) return { kind: 'rejected', reason: 'no_valuation_source' };
      if ('rejected' in consumed) return { kind: 'rejected', reason: consumed.rejected }; // 'negative_on_hand'

      const inventoryAccount = await ctx.resolveControlAccount('inventory');
      if (!inventoryAccount) {
        return {
          kind: 'rejected',
          reason: 'inventory movement: no `inventory` control account in the chart — assign controlFunction "inventory" to an account first',
        };
      }
      const cogs = await ctx.resolveConfiguredPostableAccount(COGS_ACCOUNT_CONFIG_KEY);
      if (!cogs.ok) {
        return {
          kind: 'rejected',
          reason: `inventory movement: COGS account is ${cogs.reason} — set ${COGS_ACCOUNT_CONFIG_KEY} to a postable non-control GL account`,
        };
      }

      // dispatch (negative quantity) = the sale leaving the warehouse: Dr COGS / Cr Inventory Asset.
      const lines =
        quantity < 0
          ? [
              { accountId: cogs.id, debit: consumed.totalCostBase, description: 'Cost of goods sold' },
              { accountId: inventoryAccount, credit: consumed.totalCostBase, description: 'Inventory asset' },
            ]
          : [
              { accountId: inventoryAccount, debit: consumed.totalCostBase, description: 'Inventory asset' },
              { accountId: cogs.id, credit: consumed.totalCostBase, description: 'Cost of goods sold' },
            ];

      return {
        kind: 'draft',
        draft: {
          businessDate: event.businessDate,
          description: `Inventory movement ${str(p.referenceId) ?? event.sourceEntityId} (${str(p.movementType) ?? 'movement'})`,
          transactionCurrencyCode: event.transactionCurrencyCode,
          orgUnitId: event.orgUnitId,
          lines,
        },
      };
    });
  }
}
