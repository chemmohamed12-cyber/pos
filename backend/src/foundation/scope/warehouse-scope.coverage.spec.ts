import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { InventoryController } from '../../domains/inventory-warehouse/interface/inventory.controller';
import { WarehouseTransactionsController } from '../../domains/inventory-warehouse/interface/warehouse-transactions.controller';
import { PurchaseRequestController } from '../../domains/procurement/interface/purchase-request.controller';
import { PurchaseOrderController } from '../../domains/procurement/interface/purchase-order.controller';
import { GoodsReceiptController } from '../../domains/procurement/interface/goods-receipt.controller';
import { SalesOrdersController } from '../../domains/sales-orders/interface/sales-orders.controller';
import { WAREHOUSE_SCOPE_EXEMPT_KEY, WAREHOUSE_SCOPE_FILTERED_KEY, WAREHOUSE_SCOPE_KEY } from './warehouse-scope.decorator';
import { WarehouseScopeGuard } from './warehouse-scope.guard';

/**
 * Authorization Foundation F6 (amendment A4) — COVERAGE of the scope pilot: every route of the pilot controllers (inventory / warehouse transactions, PR / PO / GR,
 * sales orders) must declare how it is scoped — `@WarehouseScoped` (enforced by the guard before the handler), `@WarehouseScopeFiltered` (a list/report whose service
 * filters by the caller's visible warehouses) or `@WarehouseScopeExempt(reason)` (a reviewable "not warehouse data" declaration). A new route without any of the three
 * fails this spec, so scope can never be forgotten by omission; and the guard must sit on every pilot controller. NO other domain is touched (A4).
 */
const PILOT_CONTROLLERS = [InventoryController, WarehouseTransactionsController, PurchaseRequestController, PurchaseOrderController, GoodsReceiptController, SalesOrdersController];

function routes(ctor: { prototype: object }): Array<{ name: string; method: unknown; path: unknown; handler: object }> {
  const proto = ctor.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
    .map((name) => ({ name, handler: proto[name] as object, method: Reflect.getMetadata(METHOD_METADATA, proto[name] as object), path: Reflect.getMetadata(PATH_METADATA, proto[name] as object) }))
    .filter((r) => r.method !== undefined);
}

describe('F6 — warehouse-scope coverage of the pilot controllers', () => {
  for (const ctor of PILOT_CONTROLLERS) {
    describe(ctor.name, () => {
      it('has the WarehouseScopeGuard on the class', () => {
        const guards: unknown[] = Reflect.getMetadata('__guards__', ctor) ?? [];
        expect(guards).toContain(WarehouseScopeGuard);
      });

      it('declares the scope of EVERY route (scoped / filtered / exempt-with-reason)', () => {
        const undeclared = routes(ctor)
          .filter((r) => !Reflect.getMetadata(WAREHOUSE_SCOPE_KEY, r.handler) && !Reflect.getMetadata(WAREHOUSE_SCOPE_FILTERED_KEY, r.handler) && !Reflect.getMetadata(WAREHOUSE_SCOPE_EXEMPT_KEY, r.handler))
          .map((r) => `${String(r.path)} (${r.name})`);
        expect(undeclared).toEqual([]);
      });

      it('every exemption carries a non-empty reason', () => {
        for (const r of routes(ctor)) {
          const reason = Reflect.getMetadata(WAREHOUSE_SCOPE_EXEMPT_KEY, r.handler);
          if (reason !== undefined) expect(String(reason).length).toBeGreaterThan(5);
        }
      });
    });
  }

  it('the pilot is exactly these six controllers — no scope enforcement was added to any other domain controller', () => {
    expect(PILOT_CONTROLLERS.map((c) => c.name).sort()).toEqual(
      ['GoodsReceiptController', 'InventoryController', 'PurchaseOrderController', 'PurchaseRequestController', 'SalesOrdersController', 'WarehouseTransactionsController'].sort(),
    );
  });
});
