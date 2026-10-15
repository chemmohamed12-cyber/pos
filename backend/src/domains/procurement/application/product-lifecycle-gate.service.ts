import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SALES_PRODUCTS_CONTRACT, SalesProductsContract } from '../../../foundation/module-registry/contracts/sales.contract';

/**
 * D7 (2026-10-05, CTO) — the Product lifecycle gate for the procurement chain. A product is `draft` until its New Item Request is
 * approved (Approval Engine, `sales.catalog.edit`) and it becomes `active`; the chain must never carry an item that was not approved:
 *   - Purchase Request APPROVAL requires every line's product to be `active` (the earliest gate — an approved PR never points at an
 *     unapproved item), re-checked when the RFQ is raised;
 *   - Goods Receipt refuses a `draft` product (defence in depth for legacy documents) — a later `discontinued` product on an
 *     already-APPROVED PO is NOT blocked (in-flight orders keep working);
 *   - CR-2026-10-15 amends D7 for PO creation and PO approval: both require every product to exist and be `active` (direct PO and
 *     RFQ award alike), and PR creation refuses a missing or `discontinued` product (`draft` stays allowed for the New Item flow).
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

  /**
   * CR-2026-10-15 — every product must exist and be in one of `allowed` (PO creation and approval: `active`; PR creation: `active` or
   * `draft`). Rejects the whole document with one controlled 409 that lists EVERY ineligible line — a missing id never reaches the
   * database as a raw foreign-key error.
   */
  async assertEligible(productIds: string[], allowed: ReadonlyArray<'draft' | 'active' | 'discontinued'>, context: string, manager?: EntityManager): Promise<void> {
    const bad = (await this.load(productIds, manager)).filter((p) => !p.snapshot || !allowed.includes(p.snapshot.status));
    if (bad.length === 0) return;
    // `draft` keeps the D7 wording users already see ("a draft item whose New Item Request has not been approved").
    const reason = (s: NonNullable<(typeof bad)[number]['snapshot']>) =>
      s.status === 'draft' ? 'is a draft item whose New Item Request has not been approved' : `is ${s.status}`;
    throw new ConflictException(
      `${context}: ${bad.map((p) => (p.snapshot ? `"${p.snapshot.sku} — ${p.snapshot.name}" ${reason(p.snapshot)}` : `item ${p.id} does not exist`)).join('; ')}. ` +
        'Fix or remove these lines and try again — nothing was saved.',
    );
  }

  /** No product may still be `draft` (Goods Receipt). */
  async assertNoneDraft(productIds: string[], context: string, manager?: EntityManager): Promise<void> {
    const drafts = (await this.load(productIds, manager)).filter((p) => p.snapshot?.status === 'draft');
    if (drafts.length === 0) return;
    throw new ConflictException(
      `${context}: ${drafts.map((p) => `"${p.snapshot!.sku} — ${p.snapshot!.name}"`).join(', ')} is a draft item whose New Item Request has not been approved.`,
    );
  }
}
