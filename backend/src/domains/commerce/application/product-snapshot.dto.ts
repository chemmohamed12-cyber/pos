/**
 * Commerce's published contract for other domains (DAII_DOMAIN_BOUNDARIES.md
 * Cross-Domain Rule: compose via published queries only, never another
 * domain's persistence layer). A consuming domain (e.g. Sales Orders)
 * imports this DTO, never Commerce's `infrastructure/product.entity.ts`
 * TypeORM entity directly.
 */
export interface ProductSnapshot {
  id: string;
  sku: string;
  name: string;
  unitPrice: string;
  status: 'draft' | 'active' | 'discontinued';
}
