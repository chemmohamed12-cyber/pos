import { NAVIGATION_REGISTRY } from './navigation-registry';
import { SeedPendingWorkTerminology1789996000000 } from '../../database/migrations/core/1789996000000-SeedPendingWorkTerminology';
import { SeedSetupGuideTerminology1789997000000 } from '../../database/migrations/core/1789997000000-SeedSetupGuideTerminology';
import { SeedCommonTasksTerminology1789998000000 } from '../../database/migrations/core/1789998000000-SeedCommonTasksTerminology';
import { SeedFinancialTraceTerminology1789999000000 } from '../../database/migrations/core/1789999000000-SeedFinancialTraceTerminology';
import { SeedNavClosureTerminology1790000000000 } from '../../database/migrations/core/1790000000000-SeedNavClosureTerminology';
import { RefineCommonTasksHints1790001000000 } from '../../database/migrations/core/1790001000000-RefineCommonTasksHints';

/**
 * Navigation & Operational Workflow Gap Closure (NAV-01 … NAV-14) — registry invariants and terminology-seed safety. Pure unit spec (no database):
 * the registry is static data and the seeds only need to respect the shared control-plane limits.
 */
const items = NAVIGATION_REGISTRY.flatMap((g) => g.items.map((i) => ({ group: g.code, ...i })));
const group = (code: string) => NAVIGATION_REGISTRY.find((g) => g.code === code)!;

describe('NAV closure — registry', () => {
  it('lists each route at most once per group, and /customers only once overall (NAV-06)', () => {
    for (const g of NAVIGATION_REGISTRY) {
      const tos = g.items.map((i) => i.to);
      expect(new Set(tos).size).toBe(tos.length);
    }
    expect(items.filter((i) => i.to === '/customers')).toHaveLength(1);
    expect(items.find((i) => i.to === '/customers')!.group).toBe('nav_group.sales');
  });

  it('puts Pending work and the Setup guide in the top-level group, ungated (every authenticated user) (NAV-03 / NAV-01)', () => {
    const top = NAVIGATION_REGISTRY[0];
    expect(top.code).toBe('');
    expect(top.items.map((i) => i.to)).toEqual(['/', '/pending-work', '/guide']);
    for (const i of top.items) {
      expect(i).not.toHaveProperty('module');
      expect(i).not.toHaveProperty('roles');
      expect(i).not.toHaveProperty('permissionNode');
    }
  });

  it('keeps every Procurement item and orders them request -> RFQ -> order (NAV-01), unchanged gating', () => {
    const tos = group('nav_group.procurement').items.map((i) => i.to);
    expect(tos.slice(0, 5)).toEqual(['/suppliers', '/purchase-requests', '/rfqs', '/purchase-orders', '/supplier-invoices']);
    const po = group('nav_group.procurement').items.find((i) => i.to === '/purchase-orders')!;
    expect(po.permissionNode).toBe('procurement.purchase_order');
  });

  it('surfaces Dimensions and Accounting Settings in the Accounting group, each gated on the node its own API enforces (NAV-10)', () => {
    const accounting = group('nav_group.accounting').items;
    const dimensions = accounting.find((i) => i.to === '/accounting/dimensions');
    const settings = accounting.find((i) => i.to === '/accounting/settings');
    expect(dimensions).toMatchObject({ module: 'accounting', permissionNode: 'accounting.dimension' });
    expect(settings).toMatchObject({ module: 'accounting', permissionNode: 'accounting.currency' });
  });

  it('does not touch the returns placement or any other item gating that earlier closures fixed (Protected Baseline)', () => {
    expect(group('nav_group.sales').items.some((i) => i.to === '/sales-returns' && i.permissionNode === 'logistics.sales_return')).toBe(true);
    expect(group('nav_group.shipping').items.some((i) => i.to === '/shipment-returns' && i.permissionNode === 'logistics.shipment_return')).toBe(true);
    expect(items.find((i) => i.to === '/accounting/policy')).toMatchObject({ permissionNode: 'accounting.account' });
    expect(items.find((i) => i.to === '/approvals')).toMatchObject({ permissionNode: 'core.approval' });
  });
});

describe('NAV closure — terminology seeds', () => {
  const seeds = [
    new SeedPendingWorkTerminology1789996000000(),
    new SeedSetupGuideTerminology1789997000000(),
    new SeedCommonTasksTerminology1789998000000(),
    new SeedFinancialTraceTerminology1789999000000(),
    new SeedNavClosureTerminology1790000000000(),
  ];
  const refine = new RefineCommonTasksHints1790001000000() as unknown as { rows: Array<[string, string, string, string]> };
  const rows = seeds.flatMap((s) => (s as unknown as { rows: Array<[string, string, string, string]> }).rows);

  it('every text fits the 255-character limit of terminology_entries (a longer one breaks the shared control-plane migration)', () => {
    for (const [code, , ar, en] of rows) {
      expect(ar.length).toBeLessThanOrEqual(255);
      expect(en.length).toBeLessThanOrEqual(255);
      expect(code.length).toBeLessThanOrEqual(128);
      expect(ar.trim()).not.toBe('');
      expect(en.trim()).not.toBe('');
    }
  });

  it('the hint refinement only overrides keys the Common-tasks seed owns, within the length limit (NAV-05)', () => {
    const owned = new Set(rows.map(([c]) => c));
    for (const [code, , ar, en] of refine.rows) {
      expect(owned.has(code)).toBe(true);
      expect(ar.length).toBeLessThanOrEqual(255);
      expect(en.length).toBeLessThanOrEqual(255);
    }
  });

  it('has no duplicate code across the five seeds, and does not re-seed a key another migration owns (field.financial_status)', () => {
    const codes = rows.map(([c]) => c);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain('field.financial_status');
  });

  it('relabels only the English name of the Fulfilment group (NAV-12): Arabic stays "التجهيز", Manufacturing stays a separate group', () => {
    const production = rows.find(([c]) => c === 'nav_group.production')!;
    expect(production[2]).toBe('التجهيز');
    expect(production[3]).toBe('Fulfilment');
    expect(NAVIGATION_REGISTRY.some((g) => g.code === 'nav_group.manufacturing')).toBe(true);
  });

  it('seeds the six approval request types that displayed a raw key (NAV-14)', () => {
    const codes = rows.map(([c]) => c);
    for (const k of ['attendance_submit_approval_batch', 'attendance_correction', 'commission_submit_approval', 'payroll_submit_approval', 'targets_submit_approval', 'fiscal_period_reclose']) {
      expect(codes).toContain(`action.${k}`);
    }
  });
});
