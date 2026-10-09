import { InventoryController } from './inventory.controller';

/**
 * Authorization Foundation closure — HTTP-proven bypass: `GET /inventory/reports/stock/export` ignored the caller's warehouse scope (a scoped user exported out-of-scope
 * warehouses' stock; the JSON twin returned 0 rows). The export must filter exactly like `stockReport`.
 */
describe('InventoryController.stockReportExport — warehouse scope', () => {
  function build(visible: 'ALL' | string[]) {
    const manager = {};
    const inventory = {
      getStockReport: jest.fn(async () => [{ warehouseId: 'w1', productId: 'p1', onHand: 5, reserved: 1, available: 4 }]),
      listWarehouses: jest.fn(async () => [{ id: 'w1', code: 'W1', name: 'One' }]),
    };
    const excel = { buildExport: jest.fn(async () => Buffer.from('x')) };
    const products = { getProductSnapshot: jest.fn(async () => ({ sku: 'S', name: 'N' })) };
    const scopes = { forRequest: jest.fn(async () => ({})), visibleWarehouseIds: jest.fn(async () => visible) };
    const controller = new InventoryController(inventory as never, excel as never, products as never, scopes as never);
    const req = { companyContext: { dataSource: { manager } } };
    const res = { set: jest.fn().mockReturnThis(), send: jest.fn() };
    return { controller, inventory, req, res };
  }

  it('a scoped caller: the visible-warehouse set is passed to the report BEFORE aggregation', async () => {
    const { controller, inventory, req, res } = build(['w1']);
    await controller.stockReportExport(req as never, res as never, undefined);
    expect(inventory.getStockReport).toHaveBeenCalledWith(undefined, expect.anything(), ['w1']);
  });

  it('an unrestricted caller: no filter is applied (unchanged behaviour)', async () => {
    const { controller, inventory, req, res } = build('ALL');
    await controller.stockReportExport(req as never, res as never, undefined);
    expect(inventory.getStockReport).toHaveBeenCalledWith(undefined, expect.anything(), undefined);
  });
});
