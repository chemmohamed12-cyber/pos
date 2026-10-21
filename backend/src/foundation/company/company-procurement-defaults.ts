import { DataSource } from 'typeorm';
import { DatabaseConfig } from '../configuration/app-config.service';

export interface CompanyProcurementDefaultsResult {
  /** true when this call created the policy row (a genuinely new Company); false when the Company has no procurement tables or already had a row (its administrator's choice is never overwritten) */
  policySeeded: boolean;
}

/**
 * Owner decision 2026-10-20 (D5 / default): a NEW Company starts with the supplier-invoice approval workflow ON; an existing Company keeps it OFF until its administrator turns it on.
 * Called once by Company provisioning, after the Company's migrations. It only INSERTs the policy row when none exists (`ON CONFLICT DO NOTHING` on the singleton key), so it can never change
 * an existing Company's setting, a choice made by an administrator, or any document. A Company without the procurement tables (module not entitled) is skipped.
 * Existing Companies are never passed through this function, so they stay on the legacy behaviour (no row = approval off).
 */
export async function seedCompanyProcurementDefaults(database: DatabaseConfig): Promise<CompanyProcurementDefaultsResult> {
  const dataSource = new DataSource({ type: 'postgres', ...database, entities: [], synchronize: false, logging: false });
  await dataSource.initialize();
  try {
    const table = await dataSource.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'procurement_invoice_policies' AND table_schema = current_schema()`);
    if (!Array.isArray(table) || table.length === 0) return { policySeeded: false };
    const inserted = await dataSource.query(`INSERT INTO "procurement_invoice_policies" ("approvalRequired") VALUES (true) ON CONFLICT DO NOTHING RETURNING "id"`);
    return { policySeeded: Array.isArray(inserted) && inserted.length > 0 };
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}
