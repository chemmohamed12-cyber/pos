import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { FinancialEventHandlerRegistry, HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';
import { INVENTORY_VALUATION_CONTRACT, InventoryGlKind, InventoryValuationContract } from '../../../../foundation/module-registry/contracts/inventory-events.contract';

const COGS_ACCOUNT_CONFIG_KEY = 'accounting.inventory_cogs_account_code';
const OPENING_BALANCE_ACCOUNT_CONFIG_KEY = 'accounting.inventory_opening_balance_account_code';
const ADJUSTMENT_GAIN_ACCOUNT_CONFIG_KEY = 'accounting.inventory_adjustment_gain_account_code';
const ADJUSTMENT_LOSS_ACCOUNT_CONFIG_KEY = 'accounting.inventory_adjustment_loss_account_code';
const MANUAL_RECEIPT_REASON_ACCOUNTS_CONFIG_KEY = 'accounting.inventory_manual_receipt_reason_accounts';
const MOVEMENT_TOPIC ='inventory.movement.recorded';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
}

type ConfiguredAccount = Awaited<ReturnType<HandlerContext['resolveConfiguredPostableAccount']>>;

function configReason(label: string, key: string, r: Extract<ConfiguredAccount, { ok: false }>): HandlerResult {
  return { kind: 'rejected', reason: `inventory movement: ${label} account is ${r.reason} — set ${key} to a postable non-control GL account` };
}

/**
 * F08 — Inventory Valuation (ADR-041 D18/D18a/D18b), extended by D3 (2026-10-04, CTO-approved posting policy —
 * `D3-INVENTORY-POSTING-POLICY-2026-10-04.md`). Supersedes F07's `inventory-movement.handler.ts` (deleted) — that
 * handler is registered in the stateless `V1_FINANCE_HANDLERS` map and reads cost only from `event.payload`, which
 * can never work for a real mutating cost source. This service self-registers instead (the SAME pattern
 * `InventoryAdjustmentService` already uses for its own internal event), because IT needs a real dependency
 * (`INVENTORY_VALUATION_CONTRACT`) the stateless map has no way to inject.
 *
 * **Depends on the INTERFACE ONLY** — `INVENTORY_VALUATION_CONTRACT`, a DI token. Never imports a concrete class from
 * `domains/inventory-valuation`.
 *
 * Routes on the event's `glKind` (absent ⇒ `'dispatch'`, the pre-D3 behavior):
 *  - `dispatch`       Dr COGS / Cr Inventory at the moving-average cost (unchanged policy).
 *  - `opening_stock`  Dr Inventory / Cr the CONFIGURED opening-balance account, for the maker-supplied cost.
 *  - `adjustment`     increase: Dr Inventory / Cr configured Gain at the warehouse's moving-average cost (valuation
 *                     increased at that cost); decrease: Dr configured Loss / Cr Inventory at the consumed average cost.
 *  - `return_in`      D4 (2026-10-05): a Sales/Shipment Return of a costed sale — valuation was restored at the ORIGINAL cost carried in
 *                     the payload; GL: Dr Inventory / Cr configured COGS. Without a carried cost (legacy ReturnRequest restock) it stays
 *                     REJECTED with an explicit reason — never a guessed cost.
 *
 * **Every account is resolved BEFORE any valuation mutation.** A handler that returns `rejected` does NOT roll the
 * transaction back (only a throw does), so mutating valuation first and then failing to resolve an account would leave
 * valuation changed with no journal — a valuation↔GL divergence. No hard-coded account codes; fail-closed on every
 * missing input (unset/invalid config ⇒ REJECTED, visible and re-drivable).
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
      const glKind = (str(p.glKind) ?? 'dispatch') as InventoryGlKind;
      const productId = str(p.productId);
      const warehouseId = str(p.warehouseId);
      const quantity = typeof p.quantity === 'number' ? p.quantity : Number(p.quantity ?? 0);
      const idempotencyKey = str(p.idempotencyKey) ?? event.idempotencyKey;

      if (!productId || !warehouseId || !Number.isFinite(quantity) || quantity === 0) {
        return { kind: 'rejected', reason: 'inventory movement: missing/invalid productId, warehouseId, or quantity' };
      }

      // return_in WITHOUT a resolved original cost (the legacy ReturnRequest restock, or any caller that did not go through the
      // D4 sale-return path) has no deterministic accounting treatment — REJECTED visibly, never guessed.
      if (glKind === 'return_in' && !(Number(str(p.totalCostBase)) > 0)) {
        return { kind: 'rejected', reason: 'return_in: no original sale cost supplied — only a Sales Return / Shipment Return of a costed sale (D4) has an accounting treatment' };
      }

      const inventoryAccount = await ctx.resolveControlAccount('inventory');
      if (!inventoryAccount) {
        return {
          kind: 'rejected',
          reason: 'inventory movement: no `inventory` control account in the chart — assign controlFunction "inventory" to an account first',
        };
      }

      const description = `Inventory movement ${str(p.referenceId) ?? event.sourceEntityId} (${str(p.movementType) ?? 'movement'})`;
      const draft = (lines: JournalDraftLine[], text = description): HandlerResult => ({
        kind: 'draft',
        draft: { businessDate: event.businessDate, description: text, transactionCurrencyCode: event.transactionCurrencyCode, orgUnitId: event.orgUnitId, lines },
      });

      // ---- opening stock: valuation was already bootstrapped at movement time with the supplied cost — GL only ----
      if (glKind === 'opening_stock') {
        const total = str(p.totalCostBase);
        if (!total || !(Number(total) > 0)) return { kind: 'rejected', reason: 'opening stock: missing/invalid totalCostBase' };
        const opening = await ctx.resolveConfiguredPostableAccount(OPENING_BALANCE_ACCOUNT_CONFIG_KEY);
        if (!opening.ok) return configReason('opening-balance', OPENING_BALANCE_ACCOUNT_CONFIG_KEY, opening);
        return draft(
          [
            { accountId: inventoryAccount, debit: total, description: 'Inventory asset (opening stock)' },
            { accountId: opening.id, credit: total, description: 'Opening balance' },
          ],
          `Opening stock ${str(p.referenceId) ?? event.sourceEntityId}`,
        );
      }

      // ---- return_in (D4): valuation was restored at movement time at the ORIGINAL cost carried in the payload — GL only.
      //      Dr Inventory / Cr COGS (configured). ----
      if (glKind === 'return_in') {
        const total = str(p.totalCostBase)!;
        const cogs = await ctx.resolveConfiguredPostableAccount(COGS_ACCOUNT_CONFIG_KEY);
        if (!cogs.ok) return configReason('COGS', COGS_ACCOUNT_CONFIG_KEY, cogs);
        return draft(
          [
            { accountId: inventoryAccount, debit: total, description: 'Inventory asset (returned stock at original cost)' },
            { accountId: cogs.id, credit: total, description: 'Cost of goods sold reversal' },
          ],
          `Sales return stock ${str(p.referenceId) ?? event.sourceEntityId} at original cost`,
        );
      }

      // ---- manual receipt (D3-B): valuation was bootstrapped at movement time with the maker-supplied cost — GL only.
      //      Dr Inventory / Cr the account CONFIGURED for the receipt's reason code; no generic fallback. ----
      if (glKind === 'manual_receipt') {
        const total = str(p.totalCostBase);
        if (!total || !(Number(total) > 0)) return { kind: 'rejected', reason: 'manual receipt: missing/invalid totalCostBase' };
        const reasonCode = str(p.reasonCode);
        if (!reasonCode) return { kind: 'rejected', reason: 'manual receipt: missing reasonCode' };
        const offset = await ctx.resolveConfiguredMappedAccount(MANUAL_RECEIPT_REASON_ACCOUNTS_CONFIG_KEY, reasonCode);
        if (!offset.ok) {
          return {
            kind: 'rejected',
            reason: `manual receipt: offset account for reason "${reasonCode}" is ${offset.reason} — map it in ${MANUAL_RECEIPT_REASON_ACCOUNTS_CONFIG_KEY} to a postable non-control GL account`,
          };
        }
        return draft(
          [
            { accountId: inventoryAccount, debit: total, description: 'Inventory asset (manual receipt)' },
            { accountId: offset.id, credit: total, description: `Manual receipt — ${reasonCode}` },
          ],
          `Manual receipt ${str(p.referenceId) ?? event.sourceEntityId} (${reasonCode})`,
        );
      }

      // ---- adjustment ----
      if (glKind === 'adjustment') {
        const increase = quantity > 0;
        const counter = await ctx.resolveConfiguredPostableAccount(increase ? ADJUSTMENT_GAIN_ACCOUNT_CONFIG_KEY : ADJUSTMENT_LOSS_ACCOUNT_CONFIG_KEY);
        if (!counter.ok) return increase ? configReason('adjustment-gain', ADJUSTMENT_GAIN_ACCOUNT_CONFIG_KEY, counter) : configReason('adjustment-loss', ADJUSTMENT_LOSS_ACCOUNT_CONFIG_KEY, counter);

        if (increase) {
          // The ONLY authorised cost source is the valuation engine (ADR-041 D3/D8): the warehouse's current moving average. No state ⇒ fail closed.
          const unit = await this.valuation.getUnitCost(productId, warehouseId, undefined, ctx.manager);
          if (!unit) return { kind: 'rejected', reason: 'no_valuation_source' };
          const total = (quantity * Number(unit.unitCostBase)).toFixed(4);
          await this.valuation.recordReceiptCost(productId, warehouseId, quantity, unit.unitCostBase, idempotencyKey, ctx.manager, event.businessDate);
          return draft([
            { accountId: inventoryAccount, debit: total, description: 'Inventory asset' },
            { accountId: counter.id, credit: total, description: 'Inventory adjustment gain' },
          ]);
        }
        const consumed = await this.valuation.consumeIssueCost(productId, warehouseId, Math.abs(quantity), idempotencyKey, ctx.manager, event.businessDate);
        if (!consumed) return { kind: 'rejected', reason: 'no_valuation_source' };
        if ('rejected' in consumed) return { kind: 'rejected', reason: consumed.rejected };
        return draft([
          { accountId: counter.id, debit: consumed.totalCostBase, description: 'Inventory adjustment loss' },
          { accountId: inventoryAccount, credit: consumed.totalCostBase, description: 'Inventory asset' },
        ]);
      }

      // ---- dispatch (unchanged policy: Dr COGS / Cr Inventory at the moving-average cost) ----
      const cogs = await ctx.resolveConfiguredPostableAccount(COGS_ACCOUNT_CONFIG_KEY);
      if (!cogs.ok) return configReason('COGS', COGS_ACCOUNT_CONFIG_KEY, cogs);

      // ADR-041 D3/D8 — this is the ONLY place a dispatch cost is resolved: never event.payload, never a selling
      // price, never an inference. `consumeIssueCost` mutates atomically with GL posting (ctx.manager) and fails
      // closed (`null`) when no valuation state exists yet.
      const consumed = await this.valuation.consumeIssueCost(productId, warehouseId, Math.abs(quantity), idempotencyKey, ctx.manager, event.businessDate);
      if (!consumed) return { kind: 'rejected', reason: 'no_valuation_source' };
      if ('rejected' in consumed) return { kind: 'rejected', reason: consumed.rejected }; // 'negative_on_hand'

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
      return draft(lines);
    });
  }
}
