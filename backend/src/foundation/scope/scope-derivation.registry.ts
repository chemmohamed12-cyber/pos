/**
 * ADR-031 — Scope Derivation Architecture (closes AUDIT-SEC-03).
 *
 * Declarative, single source of truth for how each resource type's access
 * is decided — never per-domain bespoke logic. One line to add a 9th
 * resource type; zero domain-specific code duplicated.
 */
export type ScopeStrategy = 'direct' | 'org_unit' | 'parent' | 'unscoped';

export interface ScopeDerivationEntry {
  strategy: ScopeStrategy;
  /** Required when strategy === 'parent': the resourceType to recurse into. */
  parentType?: string;
}

export const SCOPE_DERIVATION_REGISTRY: Readonly<Record<string, ScopeDerivationEntry>> = {
  // Direct assignment — unchanged, pre-existing behaviour (ScopeAssignment rows).
  customer: { strategy: 'direct' },
  sales_order: { strategy: 'direct' },

  // Org-unit derivation (NEW, ADR-031). The resource carries (or the caller
  // supplies, having already loaded the record) an owning org unit; access
  // requires the caller's own org-unit membership to cover it (self or an
  // ancestor). A null org unit = the resource predates/opts out of
  // branch-siloing = accessible to everyone, which is exactly today's
  // behaviour on every existing single-branch installation (ADR-031 §3 —
  // zero behaviour change by construction).
  treasury_account: { strategy: 'org_unit' },

  // ADR-048 — Supplier follows the same nullable-orgUnitId convention as
  // treasury_account: null = unscoped = accessible to everyone, today's
  // behaviour, multi-branch supplier scoping is a later additive step.
  supplier: { strategy: 'org_unit' },

  // Parent derivation (NEW, ADR-031 §1.4). A resource with no scope row and
  // no org unit of its own inherits the access decision of its declared
  // parent, resolved via the SAME registry (recursion, not duplication) —
  // e.g. an invoice inherits its sales order's direct-assignment check. FK
  // names verified against each entity file, not assumed. A missing/null
  // parent id (e.g. `shipment.salesOrderId` is nullable for ad hoc
  // shipments) defers to "no scope info recorded" = accessible, same
  // zero-change-by-default posture as the org_unit branch.
  //
  // `parentType` must always name a 'direct' or 'org_unit' entry (a single
  // hop the resolver can check with the id the caller passes) — never
  // another 'parent' entry, since ScopeResolver has no repository access to
  // walk a second hop itself (ADR-031 §4: derivation stays app-service-side).
  // `collection`/`delivery_outcome` only carry `shipmentId`, one hop short
  // of `sales_order` — DeliveryService loads the parent Shipment itself and
  // passes ITS `salesOrderId` as the derivationRef, same pattern as Treasury
  // passing an already-loaded `orgUnitId`.
  sales_invoice: { strategy: 'parent', parentType: 'sales_order' },
  payment: { strategy: 'parent', parentType: 'customer' },
  customer_ledger_entry: { strategy: 'parent', parentType: 'customer' },
  deposit: { strategy: 'parent', parentType: 'sales_order' },
  shipment: { strategy: 'parent', parentType: 'sales_order' },
  collection: { strategy: 'parent', parentType: 'sales_order' },
  delivery_outcome: { strategy: 'parent', parentType: 'sales_order' },
  return_request: { strategy: 'parent', parentType: 'sales_order' },
  fulfillment_order: { strategy: 'parent', parentType: 'sales_order' },

  // Explicit, reviewable "installation-wide, not an oversight" declarations
  // (ADR-031 §2) — the audit's own point was that "no check" and "correctly
  // unscoped" look identical without this registry.
  product: { strategy: 'unscoped' },
  price_list: { strategy: 'unscoped' },
  bom: { strategy: 'unscoped' },
} as const;
