import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CustomerStatementController } from './customer-statement.controller';
import { PaymentsController } from './payments.controller';
import { PermissionGuard } from '../../../foundation/permission/permission.guard';
import { JwtAuthGuard } from '../../../foundation/authentication/jwt-auth.guard';
import { CompanyContextGuard } from '../../../foundation/company/company-context.guard';
import { PERMISSION_METADATA_KEY, RequiredPermission } from '../../../foundation/permission/require-permission.decorator';
import { MODULE_REGISTRY } from '../../../foundation/module-registry/module-registry';

/**
 * D3 — the statement, the indicators, the movement-details panel and the exports are gated ON THE SERVER by `accounting.ar.view` (read-only), after the JWT and the
 * Company context; the repair action keeps its own destructive node. Route metadata is the contract the HTTP layer enforces, so it is asserted here without a database.
 */
describe('Customer statement — server-side authorization contract', () => {
  const proto = CustomerStatementController.prototype as unknown as Record<string, object>;
  const required = (obj: Record<string, object>, method: string): RequiredPermission | undefined => Reflect.getMetadata(PERMISSION_METADATA_KEY, obj[method]) as RequiredPermission | undefined;

  it.each(['statement', 'export', 'summary', 'details'])('route %s requires accounting.ar.view (read-only)', (method) => {
    const r = required(proto, method);
    expect(r).toBeDefined();
    expect(r!.nodeKey).toBe('accounting.ar.view');
    expect(r!.access).toBe('read-only');
  });

  it('the controller is guarded by JWT, the Company context and the permission engine at class level, in that order', () => {
    const guards = Reflect.getMetadata('__guards__', CustomerStatementController) as unknown[];
    expect(guards.slice(0, 2)).toEqual([JwtAuthGuard, CompanyContextGuard]);
    expect(guards).toContain(PermissionGuard);
  });

  it('every route on the controller carries a permission (no ungated read can be added unnoticed)', () => {
    const methods = Object.getOwnPropertyNames(CustomerStatementController.prototype).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['details', 'export', 'statement', 'summary']);
    for (const m of methods) expect(required(proto, m)).toBeDefined();
  });

  it('accounting.ar.view is a declared node of the accounting module', () => {
    expect(new Set(MODULE_REGISTRY.nodesForModule('accounting')).has('accounting.ar.view')).toBe(true);
  });

  it('the repair action (complete the document side of a raw-reversed payment) uses the destructive payment-reversal node, not a read node', () => {
    const r = required(PaymentsController.prototype as unknown as Record<string, object>, 'completeReversal');
    expect(r?.nodeKey).toBe('finance.payment.reverse');
    expect(r?.access).toBe('editable');
  });
  describe('the permission guard actually enforces it on these handlers (denial is a 404, never data)', () => {
    const ctxFor = (method: string) =>
      ({
        getHandler: () => (CustomerStatementController.prototype as unknown as Record<string, () => void>)[method],
        getClass: () => CustomerStatementController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1' }, companyContext: { dataSource: { manager: {} } } }) }),
      }) as never;
    const guardWith = (allowed: boolean, seen: Array<[string, string]>) =>
      new PermissionGuard(new Reflector(), { hasAtLeast: async (_u: string, node: string, access: string) => (seen.push([node, access]), allowed) } as never);

    it.each(['statement', 'export', 'summary', 'details'])('%s: a caller without accounting.ar.view is refused before the handler runs', async (method) => {
      const seen: Array<[string, string]> = [];
      await expect(guardWith(false, seen).canActivate(ctxFor(method))).rejects.toBeInstanceOf(NotFoundException);
      expect(seen).toEqual([['accounting.ar.view', 'read-only']]);
    });

    it('a caller holding accounting.ar.view passes', async () => {
      await expect(guardWith(true, []).canActivate(ctxFor('statement'))).resolves.toBe(true);
    });
  });
});
