import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { FinancialEventHandlerRegistry, HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';
import { INVENTORY_VALUATION_CONTRACT, InventoryValuationContract } from '../../../../foundation/module-registry/contracts/inventory-events.contract';
import { AP_EVENT_TOPICS } from '../../../../foundation/module-registry/contracts/ap-events.contract';

const COST_DIFFERENCE_KEY = 'accounting.purchase_cost_difference_after_receipt_account_code';
const OTHER_CHARGES_KEY = 'accounting.purchase_other_charges_account_code';

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(typeof v === 'string' ? v : 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);

interface PayloadLine {
  invoiceLineId: string;
  productId: string;
  warehouseId: string;
  quantity: string;
  discountShare: string;
  freightShare: string;
}
/** The decided split of one invoice line, recorded on the event so a void mirrors it exactly. */
interface SplitLine {
  invoiceLineId: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  onHandUnits: number;
  discountOnHand: number;
  discountConsumed: number;
  freightOnHand: number;
  freightConsumed: number;
  /** the signed valuation change applied (freightOnHand - discountOnHand) */
  valuationDelta: number;
}

/**
 * Phase C-2 (owner decisions D3 / E1, 2026-10-20) - GL + valuation effect of the discount, freight and other charges of a posted supplier invoice. Self-registering (it needs the valuation
 * contract), like the inventory costing handler. The main `finance.supplier_invoice.posted` journal is untouched; this separate, idempotent journal carries:
 *   - the ON-HAND share of a discount / capitalised freight: Cr / Dr Inventory and the position's valuation is revalued by the same amount, atomically with the journal;
 *   - the share belonging to units already SOLD OR CONSUMED: Cr / Dr the separate "purchase cost differences after receipt" account (never the PPV account);
 *   - non-capitalised charges (other charges, expensed freight): Dr the configured purchase-charges expense account;
 *   - Accounts payable: the net of discount, freight and charges (so AP = net + VAT - discount + freight + charges, equal to the Supplier Ledger).
 * The split per line: units on hand = min(invoiced quantity, current on-hand of that product in that warehouse); moving-average costing has no lots, so the invoiced units are assumed to be the
 * ones still on hand first (disclosed assumption). Every account is resolved and every valuation change is pre-validated BEFORE anything is mutated; an unexpected failure THROWS so the whole
 * posting transaction rolls back (a rejected result does not roll back).
 */
@Injectable()
export class SupplierInvoiceCostAdjustmentHandlerService implements OnModuleInit {
  constructor(
    private readonly registry: FinancialEventHandlerRegistry,
    @Inject(INVENTORY_VALUATION_CONTRACT) private readonly valuation: InventoryValuationContract,
  ) {}

  onModuleInit(): void {
    if (!this.registry.get(AP_EVENT_TOPICS.supplierInvoiceCostAdjusted)) this.registry.register(AP_EVENT_TOPICS.supplierInvoiceCostAdjusted, (e, c) => this.handleAdjusted(e, c));
    if (!this.registry.get(AP_EVENT_TOPICS.supplierInvoiceCostAdjustmentVoided)) this.registry.register(AP_EVENT_TOPICS.supplierInvoiceCostAdjustmentVoided, (e, c) => this.handleVoided(e, c));
  }

  private async accounts(ctx: HandlerContext, discount: number, freightCap: number, expensed: number) {
    const inventory = await ctx.resolveControlAccount('inventory');
    const ap = await ctx.resolveControlAccount('ap');
    if (!ap) return { ok: false, error: 'cost adjustment: no AP control account in the chart' } as const;
    let costDifference: string | null = null;
    if (discount > 0 || freightCap > 0) {
      if (!inventory) return { ok: false, error: 'cost adjustment: no `inventory` control account in the chart' } as const;
      const r = await ctx.resolveConfiguredPostableAccount(COST_DIFFERENCE_KEY);
      if (!r.ok) return { ok: false, error: `cost adjustment: the purchase cost differences after receipt account is ${r.reason} — the finance owner must set ${COST_DIFFERENCE_KEY} to a postable non-control GL account` } as const;
      costDifference = r.id;
    }
    let charges: string | null = null;
    if (expensed > 0) {
      const r = await ctx.resolveConfiguredPostableAccount(OTHER_CHARGES_KEY);
      if (!r.ok) return { ok: false, error: `cost adjustment: the purchase charges expense account is ${r.reason} — the finance owner must set ${OTHER_CHARGES_KEY} to a postable non-control GL account` } as const;
      charges = r.id;
    }
    return { ok: true, inventory, ap, costDifference, charges } as const;
  }

  /** Journal lines of a decided split (shared by the posting and its exact mirror). */
  private buildLines(split: SplitLine[], expensed: number, a: { inventory: string | null; ap: string; costDifference: string | null; charges: string | null }): JournalDraftLine[] {
    const lines: JournalDraftLine[] = [];
    const push = (accountId: string, signed: number, description: string) => {
      const v = r4(Math.abs(signed));
      if (v === 0) return;
      lines.push(signed > 0 ? { accountId, debit: v.toFixed(4), description } : { accountId, credit: v.toFixed(4), description });
    };
    let apNet = expensed;
    for (const s of split) {
      const onHand = r4(s.freightOnHand - s.discountOnHand);
      const consumed = r4(s.freightConsumed - s.discountConsumed);
      if (a.inventory) push(a.inventory, onHand, `Inventory - share on hand (${s.onHandUnits} of ${s.quantity} units): freight +${s.freightOnHand.toFixed(4)} / discount -${s.discountOnHand.toFixed(4)} [line ${s.invoiceLineId}]`);
      if (a.costDifference) push(a.costDifference, consumed, `Purchase cost differences after receipt - share sold/consumed: freight +${s.freightConsumed.toFixed(4)} / discount -${s.discountConsumed.toFixed(4)} [line ${s.invoiceLineId}]`);
      apNet = r4(apNet + onHand + consumed);
    }
    if (a.charges) push(a.charges, expensed, 'Purchase charges expensed (not capitalised)');
    push(a.ap, -apNet, 'Accounts payable - charges net of discount');
    return lines;
  }

  async handleAdjusted(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
    const p = event.payload;
    const discount = num(p.discountAmount);
    const freightCap = num(p.freightCapitalizedAmount);
    const expensed = num(p.expensedChargesAmount);
    const payloadLines = Array.isArray(p.lines) ? (p.lines as PayloadLine[]) : [];
    if (discount < 0 || freightCap < 0 || expensed < 0 || discount + freightCap + expensed <= 0) return { kind: 'rejected', reason: 'cost adjustment: nothing to adjust or invalid amounts' };
    if (payloadLines.length === 0) return { kind: 'rejected', reason: 'cost adjustment: no invoice lines' };

    const accts = await this.accounts(ctx, discount, freightCap, expensed);
    if (!accts.ok) return { kind: 'rejected', reason: accts.error };

    const m = ctx.manager;
    const getPositions = this.valuation.getValuedPositions;
    if (!getPositions || !this.valuation.applyRevaluation) return { kind: 'rejected', reason: 'cost adjustment: the valuation engine is not available' };

    // ---- decide the split (read only) ----
    const onHandLeft = new Map<string, { quantity: number; value: number }>();
    const split: SplitLine[] = [];
    for (const l of payloadLines) {
      const key = `${l.warehouseId}:${l.productId}`;
      if (!onHandLeft.has(key)) {
        const pos = (await getPositions.call(this.valuation, undefined, { warehouseIds: [l.warehouseId], productId: l.productId }, m)).find((x) => x.productId === l.productId && x.warehouseId === l.warehouseId);
        onHandLeft.set(key, { quantity: Math.max(pos?.quantity ?? 0, 0), value: Number(pos?.totalValueBase ?? 0) });
      }
      const state = onHandLeft.get(key)!;
      const qty = num(l.quantity);
      const onHandUnits = qty > 0 ? Math.min(qty, state.quantity) : 0;
      state.quantity = r4(state.quantity - onHandUnits);
      const ratio = qty > 0 ? onHandUnits / qty : 0;
      const d = r4(num(l.discountShare));
      const f = r4(num(l.freightShare));
      const dOn = r4(d * ratio);
      const fOn = r4(f * ratio);
      split.push({ invoiceLineId: l.invoiceLineId, productId: l.productId, warehouseId: l.warehouseId, quantity: qty, onHandUnits, discountOnHand: dOn, discountConsumed: r4(d - dOn), freightOnHand: fOn, freightConsumed: r4(f - fOn), valuationDelta: r4(fOn - dOn) });
    }

    // ---- pre-validate every valuation change before the first mutation ----
    const projected = new Map<string, number>();
    for (const s of split) {
      if (s.valuationDelta === 0) continue;
      const key = `${s.warehouseId}:${s.productId}`;
      const st = onHandLeft.get(key);
      const base = projected.get(key) ?? (st ? st.value : 0);
      if (s.onHandUnits <= 0) return { kind: 'rejected', reason: `cost adjustment: line ${s.invoiceLineId} has an on-hand share but no stock to revalue` };
      if (base + s.valuationDelta < 0) return { kind: 'rejected', reason: `cost adjustment: the discount would take the inventory value of line ${s.invoiceLineId} below zero` };
      projected.set(key, base + s.valuationDelta);
    }

    const lines = this.buildLines(split, expensed, accts);
    const dr = lines.reduce((t, x) => t + Number(x.debit ?? 0), 0);
    const cr = lines.reduce((t, x) => t + Number(x.credit ?? 0), 0);
    if (lines.length < 2 || Math.abs(dr - cr) > 0.00005) return { kind: 'rejected', reason: `cost adjustment: unbalanced draft (Dr ${dr.toFixed(4)} / Cr ${cr.toFixed(4)})` };

    // ---- mutate: valuation (same transaction as the journal), then record the decided split on the event for an exact void ----
    for (const s of split) {
      if (s.valuationDelta === 0) continue;
      const done = await this.valuation.applyRevaluation!(s.productId, s.warehouseId, s.valuationDelta.toFixed(4), `${event.idempotencyKey}:reval:${s.invoiceLineId}`, m, event.businessDate);
      if ('rejected' in done) throw new Error(`cost adjustment: valuation change refused after validation (${done.rejected}) - the posting is rolled back`);
    }
    await m.query(`UPDATE "accounting_financial_events" SET "payload" = "payload" || $1::jsonb WHERE "id" = $2`, [JSON.stringify({ decidedSplit: split, expensed }), event.id]);

    return {
      kind: 'draft',
      draft: {
        businessDate: event.businessDate,
        description: `Supplier invoice ${str(p.invoiceNumber) ?? event.sourceEntityId} - discount / freight / charges`,
        transactionCurrencyCode: event.transactionCurrencyCode,
        orgUnitId: event.orgUnitId,
        lines,
      },
    };
  }

  async handleVoided(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
    const originals: Array<{ id: string; idempotencyKey: string; payload: Record<string, unknown> }> = await ctx.manager.query(
      `SELECT "id", "idempotencyKey", "payload" FROM "accounting_financial_events"
        WHERE "eventType" = $1 AND "sourceEntityId" = $2 AND "status" = 'POSTED' ORDER BY "receivedAt" DESC LIMIT 1`,
      [AP_EVENT_TOPICS.supplierInvoiceCostAdjusted, event.sourceEntityId],
    );
    if (originals.length === 0) return { kind: 'rejected', reason: 'cost adjustment void: the original cost-adjustment posting is not POSTED - nothing to mirror' };
    const original = originals[0];
    const split = Array.isArray(original.payload.decidedSplit) ? (original.payload.decidedSplit as SplitLine[]) : [];
    const expensed = num(original.payload.expensed ?? original.payload.expensedChargesAmount);
    const discount = num(original.payload.discountAmount);
    const freightCap = num(original.payload.freightCapitalizedAmount);
    if (split.length === 0) return { kind: 'rejected', reason: 'cost adjustment void: the original posting recorded no split' };

    const accts = await this.accounts(ctx, discount, freightCap, expensed);
    if (!accts.ok) return { kind: 'rejected', reason: accts.error };
    if (!this.valuation.applyRevaluation) return { kind: 'rejected', reason: 'cost adjustment void: the valuation engine is not available' };

    // pre-validate: the reversal must not take a position's value below zero
    const getPositions = this.valuation.getValuedPositions;
    if (getPositions) {
      const projected = new Map<string, number>();
      for (const s of split) {
        if (s.valuationDelta === 0) continue;
        const key = `${s.warehouseId}:${s.productId}`;
        if (!projected.has(key)) {
          const pos = (await getPositions.call(this.valuation, undefined, { warehouseIds: [s.warehouseId], productId: s.productId }, ctx.manager)).find((x) => x.productId === s.productId && x.warehouseId === s.warehouseId);
          if (!pos || pos.quantity <= 0) return { kind: 'rejected', reason: `cost adjustment void: no stock left to reverse the revaluation of line ${s.invoiceLineId}` };
          projected.set(key, Number(pos.totalValueBase));
        }
        const next = projected.get(key)! - s.valuationDelta;
        if (next < 0) return { kind: 'rejected', reason: `cost adjustment void: reversing line ${s.invoiceLineId} would take the inventory value below zero` };
        projected.set(key, next);
      }
    }

    const posted = this.buildLines(split, expensed, accts);
    for (const s of split) {
      if (s.valuationDelta === 0) continue;
      const done = await this.valuation.applyRevaluation(s.productId, s.warehouseId, (-s.valuationDelta).toFixed(4), `${event.idempotencyKey}:reval:${s.invoiceLineId}`, ctx.manager, event.businessDate);
      if ('rejected' in done) throw new Error(`cost adjustment void: valuation reversal refused after validation (${done.rejected}) - the void is rolled back`);
    }
    return {
      kind: 'draft',
      draft: {
        businessDate: event.businessDate,
        description: `Supplier invoice ${str(event.payload.invoiceNumber) ?? event.sourceEntityId} - discount / freight / charges voided`,
        transactionCurrencyCode: event.transactionCurrencyCode,
        orgUnitId: event.orgUnitId,
        lines: posted.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, description: l.description })),
      },
    };
  }
}
