import { NavigationService } from './navigation.service';
import { NAVIGATION_REGISTRY } from './navigation-registry';
import { EntitlementService } from '../entitlement/entitlement.service';
import { PermissionService } from '../permission/permission.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { AuthorizationContext } from '../authorization/authorization-context';
import { WorkflowAccess } from '../authorization/workflow-access';

/**
 * Navigation Root-Cause Fix (2026-09-26, CTO-authorized —
 * NAVIGATION-REGISTRY-VERIFICATION-2026-09-26.md). No test existed for
 * `NavigationService`/`NAVIGATION_REGISTRY` before this change; this
 * covers the fix directly against the real registry (not a synthetic
 * one) so a future edit to either file breaks a real test, not silence.
 */
describe('NavigationService.resolveFor — Navigation Root-Cause Fix (2026-09-26)', () => {
  function buildService(opts: { modules?: string[]; features?: string[]; roles?: string[]; permissionNodes?: string[] }) {
    const modules = new Set(
      opts.modules ?? ['sales', 'logistics', 'finance', 'inventory', 'hr', 'accounting', 'reporting', 'procurement', 'attendance', 'payroll', 'targets', 'commission', 'manufacturing'],
    );
    const features = new Set(opts.features ?? ['accounting.chart_of_accounts', 'accounting.general_ledger', 'accounting.accounts_receivable', 'accounting.accounts_payable', 'accounting.cash_bank']);
    const roles = opts.roles ?? [];
    const grantedNodes = new Set(opts.permissionNodes ?? []);

    const entitlement = { resolve: () => ({ modules, features }) } as unknown as EntitlementService;
    const permission = { hasAtLeast: async (_userId: string, node: string) => grantedNodes.has(node) } as unknown as PermissionService;
    // F5: workflow rules are answered under the LEGACY decision here (these specs pin which menu items each ROLE sees; the capability == legacy equivalence is proven in workflow-rules.spec.ts).
    const authorization = { getRoleKeysForUser: async () => roles, workflowAccess: async () => new WorkflowAccess(new AuthorizationContext('u', null, roles.map((k) => ({ id: k, key: k })), []), 'legacy') } as unknown as AuthorizationService;

    return new NavigationService(entitlement, permission, authorization);
  }

  function findItem(groups: Awaited<ReturnType<NavigationService['resolveFor']>>, to: string) {
    for (const g of groups) {
      const item = g.items.find((i) => i.to === to);
      if (item) return item;
    }
    return undefined;
  }

  describe('Part A — role-array gaps (admin previously missing)', () => {
    it('an admin-only user now sees the 4 Warehouses child items, Fulfillment, and Shipments', async () => {
      const service = buildService({ roles: ['admin'] });
      const groups = await service.resolveFor('admin-user');

      for (const to of ['/warehouses', '/movement-center', '/inventory', '/stock-count', '/fulfillment', '/shipments']) {
        expect(findItem(groups, to)).toBeDefined();
      }
    });

    it('Production/Fulfillment group is no longer entirely absent for an admin-only user', async () => {
      const service = buildService({ roles: ['admin'] });
      const groups = await service.resolveFor('admin-user');
      expect(groups.find((g) => g.code === 'nav_group.production')).toBeDefined();
    });

    it('does NOT regress non-admin roles — a plain warehouse_worker still sees exactly the warehouse items it did before', async () => {
      const service = buildService({ roles: ['warehouse_worker'] });
      const groups = await service.resolveFor('worker-user');
      for (const to of ['/warehouses', '/movement-center', '/inventory', '/stock-count', '/fulfillment']) {
        expect(findItem(groups, to)).toBeDefined();
      }
      // still correctly excluded from a role it never had
      expect(findItem(groups, '/shipments')).toBeUndefined();
    });

    it('a plain driver still sees /shipments and nothing else added by this fix', async () => {
      const service = buildService({ roles: ['driver'] });
      const groups = await service.resolveFor('driver-user');
      expect(findItem(groups, '/shipments')).toBeDefined();
      expect(findItem(groups, '/warehouses')).toBeUndefined();
    });

    it('a user with NO relevant role sees none of the 6 fixed items', async () => {
      const service = buildService({ roles: [] });
      const groups = await service.resolveFor('nobody');
      for (const to of ['/warehouses', '/movement-center', '/inventory', '/stock-count', '/fulfillment', '/shipments']) {
        expect(findItem(groups, to)).toBeUndefined();
      }
    });
  });

  describe('Part C — new permission-gated items', () => {
    it('/hr/leave-requests resolves for a user granted hr.leave_request, gated on that exact node', async () => {
      const withNode = buildService({ permissionNodes: ['hr.leave_request'] });
      expect(findItem(await withNode.resolveFor('u1'), '/hr/leave-requests')).toBeDefined();

      const without = buildService({ permissionNodes: [] });
      expect(findItem(await without.resolveFor('u2'), '/hr/leave-requests')).toBeUndefined();
    });

    it('/accounting/ledger resolves for accounting.ledger, same node as the existing /accounting/trial-balance sibling', async () => {
      const withNode = buildService({ permissionNodes: ['accounting.ledger'] });
      const groups = await withNode.resolveFor('u1');
      expect(findItem(groups, '/accounting/ledger')).toBeDefined();
      expect(findItem(groups, '/accounting/trial-balance')).toBeDefined();

      const without = buildService({ permissionNodes: [] });
      expect(findItem(await without.resolveFor('u2'), '/accounting/ledger')).toBeUndefined();
    });

    it('/accounting/fixed-assets, /accounting/inventory, /accounting/grni, /accounting/fiscal-periods each gate on their own distinct node', async () => {
      const nodeByPath: Record<string, string> = {
        '/accounting/fixed-assets': 'accounting.fixed_asset',
        '/accounting/inventory': 'accounting.inventory',
        '/accounting/grni': 'accounting.grni',
        '/accounting/fiscal-periods': 'accounting.fiscal_year',
      };
      for (const [to, node] of Object.entries(nodeByPath)) {
        const withNode = buildService({ permissionNodes: [node] });
        expect(findItem(await withNode.resolveFor('u1'), to)).toBeDefined();

        const withoutNode = buildService({ permissionNodes: [] });
        expect(findItem(await withoutNode.resolveFor('u2'), to)).toBeUndefined();
      }
    });

    it('these 4 accounting items carry no `feature` gate (verified: their GET routes carry no @RequireFeature)', () => {
      const registryItems = NAVIGATION_REGISTRY.flatMap((g) => g.items);
      for (const to of ['/accounting/fixed-assets', '/accounting/inventory', '/accounting/grni', '/accounting/fiscal-periods']) {
        const item = registryItems.find((i) => i.to === to);
        expect(item?.feature).toBeUndefined();
      }
    });
  });

  describe('Part C12 — coverTo correction', () => {
    it('nav_group.accounting now covers to /accounting, not a child business item', () => {
      const group = NAVIGATION_REGISTRY.find((g) => g.code === 'nav_group.accounting');
      expect(group?.coverTo).toBe('/accounting');
    });
  });

  describe('Full Navigation Closure batch (2026-09-26) — Procurement/Attendance/Payroll/Targets/Commission/Manufacturing/Sales-Returns/Shipment-Returns/Approvals', () => {
    it('Procurement — all 7 items gate on their own verified permission node, module-only is NOT sufficient (contradicts an earlier unverified peer claim)', async () => {
      const nodeByPath: Record<string, string> = {
        '/suppliers': 'procurement.supplier',
        '/purchase-orders': 'procurement.purchase_order',
        '/purchase-requests': 'procurement.purchase_request',
        '/rfqs': 'procurement.rfq',
        '/supplier-invoices': 'procurement.supplier_invoice',
        '/supplier-statement': 'procurement.supplier',
        '/ap-aging': 'procurement.supplier_invoice',
      };
      for (const [to, node] of Object.entries(nodeByPath)) {
        expect(findItem(await buildService({ permissionNodes: [node] }).resolveFor('u1'), to)).toBeDefined();
        expect(findItem(await buildService({ permissionNodes: [] }).resolveFor('u2'), to)).toBeUndefined();
      }
    });

    it('Attendance — 5 items, /import and /biometric-import share attendance.import, /facts and /days share attendance.day', async () => {
      const withImport = await buildService({ permissionNodes: ['attendance.import'] }).resolveFor('u1');
      expect(findItem(withImport, '/attendance/import')).toBeDefined();
      expect(findItem(withImport, '/attendance/biometric-import')).toBeDefined();
      expect(findItem(withImport, '/attendance/connectors')).toBeUndefined();

      const withDay = await buildService({ permissionNodes: ['attendance.day'] }).resolveFor('u2');
      expect(findItem(withDay, '/attendance/facts')).toBeDefined();
      expect(findItem(withDay, '/attendance/days')).toBeDefined();

      const withConnector = await buildService({ permissionNodes: ['attendance.connector'] }).resolveFor('u3');
      expect(findItem(withConnector, '/attendance/connectors')).toBeDefined();
      expect(findItem(withConnector, '/attendance/import')).toBeUndefined();
    });

    it('Payroll — 3 items each gate on their own distinct node', async () => {
      const nodeByPath: Record<string, string> = {
        '/payroll/periods': 'payroll.period',
        '/payroll/compensation': 'payroll.compensation',
        '/payroll/runs': 'payroll.run',
      };
      for (const [to, node] of Object.entries(nodeByPath)) {
        expect(findItem(await buildService({ permissionNodes: [node] }).resolveFor('u1'), to)).toBeDefined();
        expect(findItem(await buildService({ permissionNodes: [] }).resolveFor('u2'), to)).toBeUndefined();
      }
    });

    it('Targets — single item gates on targets.target', async () => {
      expect(findItem(await buildService({ permissionNodes: ['targets.target'] }).resolveFor('u1'), '/targets/targets')).toBeDefined();
      expect(findItem(await buildService({ permissionNodes: [] }).resolveFor('u2'), '/targets/targets')).toBeUndefined();
    });

    it('Commission — /batches gates on commission.batch (its real node, despite being literally named "...submit")', async () => {
      const nodeByPath: Record<string, string> = {
        '/commission/policies': 'commission.policy',
        '/commission/results': 'commission.result',
        '/commission/batches': 'commission.batch',
      };
      for (const [to, node] of Object.entries(nodeByPath)) {
        expect(findItem(await buildService({ permissionNodes: [node] }).resolveFor('u1'), to)).toBeDefined();
        expect(findItem(await buildService({ permissionNodes: [] }).resolveFor('u2'), to)).toBeUndefined();
      }
    });

    it('Manufacturing — gated on BOTH the feature (off by default) and the permission node; either alone is not enough', async () => {
      const neitherGranted = await buildService({ permissionNodes: [] }).resolveFor('u1');
      expect(findItem(neitherGranted, '/manufacturing/work-orders')).toBeUndefined();

      const permissionOnlyNoFeature = await buildService({ permissionNodes: ['manufacturing.work_order'] }).resolveFor('u2');
      expect(findItem(permissionOnlyNoFeature, '/manufacturing/work-orders')).toBeUndefined();

      const featureOnlyNoPermission = await buildService({
        features: ['manufacturing.work_orders'],
        permissionNodes: [],
      }).resolveFor('u3');
      expect(findItem(featureOnlyNoPermission, '/manufacturing/work-orders')).toBeUndefined();

      const both = await buildService({ features: ['manufacturing.work_orders'], permissionNodes: ['manufacturing.work_order'] }).resolveFor('u4');
      expect(findItem(both, '/manufacturing/work-orders')).toBeDefined();
    });

    it('Sales Returns and Shipment Returns gate on their own logistics.* node, placed alongside their sibling returns items', async () => {
      const groups = await buildService({ permissionNodes: ['logistics.sales_return', 'logistics.shipment_return'] }).resolveFor('u1');
      expect(findItem(groups, '/sales-returns')).toBeDefined();
      expect(findItem(groups, '/shipment-returns')).toBeDefined();
      expect(groups.find((g) => g.code === 'nav_group.sales')?.items.some((i) => i.to === '/sales-returns')).toBe(true);
      expect(groups.find((g) => g.code === 'nav_group.shipping')?.items.some((i) => i.to === '/shipment-returns')).toBe(true);
    });

    it('Approvals gates on core.approval only — NOT on roles:[admin] (the rejected proposal)', async () => {
      const registryItem = NAVIGATION_REGISTRY.flatMap((g) => g.items).find((i) => i.to === '/approvals');
      expect(registryItem?.roles).toBeUndefined();
      expect(registryItem?.permissionNode).toBe('core.approval');

      expect(findItem(await buildService({ permissionNodes: ['core.approval'] }).resolveFor('u1'), '/approvals')).toBeDefined();
      // an admin-labelled role alone (no permission grant) must NOT reveal it — proves this is not a role gate
      expect(findItem(await buildService({ roles: ['admin'], permissionNodes: [] }).resolveFor('u2'), '/approvals')).toBeUndefined();
    });
  });

  describe('regression — untouched groups/items are unaffected', () => {
    it('nav_group.hr still resolves employees/departments for their existing permission nodes, unaffected by the new leave-requests item', async () => {
      const service = buildService({ permissionNodes: ['hr.employee', 'hr.department'] });
      const groups = await service.resolveFor('u1');
      expect(findItem(groups, '/hr/employees')).toBeDefined();
      expect(findItem(groups, '/hr/departments')).toBeDefined();
      expect(findItem(groups, '/hr/leave-requests')).toBeUndefined();
    });

    it('dashboard (module/role-free item) is always visible regardless of roles/permissions', async () => {
      const service = buildService({ roles: [], permissionNodes: [] });
      const groups = await service.resolveFor('anyone');
      expect(findItem(groups, '/')).toBeDefined();
    });
  });
});
