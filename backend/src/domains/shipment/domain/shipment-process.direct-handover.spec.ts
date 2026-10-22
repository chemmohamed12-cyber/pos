import { SHIPMENT_PROCESS } from './shipment-process';
import { SHIPPING_METHODS, isDirectSale, isValidShippingMethod } from '../../sales-orders/domain/shipping-method';

/** Direct sale from the company: ready for hand-over right after preparation, one hand-over step, the normal shipping cycle unchanged. */
describe('direct sale shipping method and the shipment process', () => {
  const t = SHIPMENT_PROCESS.transitions;

  it('direct_sale is a valid shipping method next to the two shipping ones, and only it is a direct sale', () => {
    expect(SHIPPING_METHODS).toEqual(['company_vehicles', 'shipping_company', 'direct_sale']);
    expect(isValidShippingMethod('direct_sale')).toBe(true);
    expect(isDirectSale('direct_sale')).toBe(true);
    for (const other of ['company_vehicles', 'shipping_company', '', null, undefined]) expect(isDirectSale(other as never)).toBe(false);
  });

  it('a created shipment (= ready for hand-over) goes straight to delivered by ONE action', () => {
    expect(t.filter((x) => x.action === 'direct_handover')).toEqual([{ from: 'created', to: 'delivered', action: 'direct_handover' }]);
  });

  it('the normal shipping cycle is untouched: assign, pickup, depart, arrive, deliver, fail, retry, return are all still there', () => {
    const actions = t.map((x) => x.action);
    for (const a of ['assign_driver', 'pickup', 'depart', 'arrive_for_delivery', 'deliver', 'fail_delivery', 'retry', 'return_to_sender']) expect(actions).toContain(a);
    expect(t.find((x) => x.action === 'deliver')?.to).toBe('delivered');
  });
});
