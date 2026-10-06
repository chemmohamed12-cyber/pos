import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SALES_PRODUCTS_CONTRACT, SalesProductsContract } from '../../../foundation/module-registry/contracts/sales.contract';

/**
 * D7 (2026-10-05, CTO) — the Product lifecycle gate for the procurement chain. A product is `draft` until its New Item Request is
 * approved (Approval Engine, `sales.catalog.edit`) and it becomes `active`; the chain must never carry an item that was not approved:
 *   - Purchase Request APPROVAL requires every line's product to be `active` (the earliest gate — an approved PR never points at an
 *     unapproved item), re-checked when the RFQ is raised;
 *   - PO creation and Goods Receipt refuse a `draft` product (defence in depth for any path that reaches them: direct PO, RFQ award,
 *     legacy documents) — a later `discontinued` product on an already-issued PO is NOT blocked (in-flight orders keep working).
 * Every check runs BEFORE any mutation (fail closed). The Product is reached only through the published Sales contract.
 */
@Injectable()
export class ProductLifecycleGate {
  constructor(@Inject(SALES_PRODUCTS_CONTRACT) private readonly products: SalesProductsContract) {}

  private async load(productIds: string[], manager?: EntityManager) {
    const unique = [...new Set(productIds)];
    return Promise.all(unique.map(async (id) => ({ id, snapshot: await this.products.getProductSnapshot(id, manager) })));
  }

  /** Every product must be `active` (PR approval / RFQ creation). */
  async assertAllActive(productIds: string[], context: string, manager?: EntityManager): Promise<void> {
    const bad = (await this.load(productIds, manager)).filter((p) => p.snapshot?.status !== 'active');
    if (bad.length === 0) return;
    throw new ConflictException(
      `${context}: ${bad.map((p) => (p.snapshot ? `"${p.snapshot.sku} — ${p.snapshot.name}" is ${p.snapshot.status}` : `item ${p.id} does not exist`)).join('; ')}. ` +
        'Only approved (active) items can move through procurement — a new item must have its New Item Request approved first.',
    );
  }

  /** No product may still be `draft` (PO creation / Goods Receipt). */
  async assertNoneDraft(productIds: string[], context: string, manager?: EntityManager): Promise<void> {
    const drafts = (await this.load(productIds, manager)).filter((p) => p.snapshot?.status === 'draft');
    if (drafts.length === 0) return;
    throw new ConflictException(
      `${context}: ${drafts.map((p) => `"${p.snapshot!.sku} — ${p.snapshot!.name}"`).join(', ')} is a draft item whose New Item Request has not been approved.`,
    );
  }
}
