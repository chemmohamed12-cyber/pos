import type { DataSource, EntityManager } from 'typeorm';
import { ProductLifecycleGate } from '../application/product-lifecycle-gate.service';

/**
 * Test wiring for `ProductLifecycleGate` (D7). Production resolves the Sales product contract through DI; specs that construct the
 * procurement services by hand use this gate backed by the REAL `products` rows of the manager they are handed (same read the
 * contract's `getProductSnapshot` does — a `findOne` by id), so the lifecycle gate is exercised, never stubbed away.
 */
export function makeProductLifecycleGate(fallback: DataSource): ProductLifecycleGate {
  const contract = {
    getProductSnapshot: async (id: string, manager?: EntityManager) => {
      const rows: Array<{ id: string; sku: string; name: string; unitPrice: string; status: 'draft' | 'active' | 'discontinued' }> = await (manager ?? fallback.manager).query(
        `SELECT id, sku, name, "unitPrice", status FROM products WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    },
  };
  return new ProductLifecycleGate(contract as never);
}
