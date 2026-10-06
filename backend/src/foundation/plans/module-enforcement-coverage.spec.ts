/* eslint-disable @typescript-eslint/no-require-imports */
import { MODULE_REGISTRY } from '../module-registry/module-registry';

// Plain-JS tool shared with `npm`-less CI use; see tools/validation/module-enforcement-coverage.js.
const coverage = require('../../../tools/validation/module-enforcement-coverage.js') as {
  scan: () => { file: string; domain: string; routes: string; modules: string[]; companyScoped: boolean }[];
  violations: (rows: ReturnType<typeof coverage.scan>) => { file: string }[];
};

/**
 * Package enforcement can only be applied on a route that is BOTH company-scoped
 * (`CompanyContextGuard` validated the Membership) and module-guarded
 * (`@RequireModule`). A company-scoped controller without `@RequireModule` would
 * skip entitlement entirely — a Company's package could never restrict it — so a
 * new one must not be added silently. Hiding a menu item or returning 404 on
 * some other route is not protection for this one.
 */
describe('module enforcement coverage', () => {
  const rows = coverage.scan();

  it('scans the domain controllers', () => {
    expect(rows.length).toBeGreaterThan(30);
  });

  it('every company-scoped domain controller carries @RequireModule', () => {
    expect(coverage.violations(rows).map((r) => r.file)).toEqual([]);
  });

  it('every @RequireModule code is a real authored module', () => {
    const authored = new Set<string>(MODULE_REGISTRY.authoredModuleCodes());
    const unknown = rows.flatMap((r) => r.modules.filter((m) => !authored.has(m)).map((m) => `${r.file}:${m}`));
    expect(unknown).toEqual([]);
  });

  it('the three controllers that used to bypass entitlement are now guarded', () => {
    const byFile = (f: string) => rows.find((r) => r.file.endsWith(f));
    expect(byFile('sales-orders.controller.ts')?.modules).toEqual(['sales']);
    expect(byFile('customer-ledger.controller.ts')?.modules).toEqual(['finance']);
    expect(byFile('fulfillment.controller.ts')?.modules).toEqual(['inventory']);
  });
});
