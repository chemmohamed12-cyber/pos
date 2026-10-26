import { computeDeliveryProgress } from './line-delivery-progress';

describe('computeDeliveryProgress (C2, pure)', () => {
  const lines = [
    { id: 'a', productId: 'p1', quantity: 5 },
    { id: 'b', productId: 'p2', quantity: 2 },
  ];
  it('no events -> none, everything outstanding', () => {
    const p = computeDeliveryProgress(lines, []);
    expect(p.status).toBe('none');
    expect(p.lines.map((l) => l.outstanding)).toEqual([5, 2]);
  });
  it('some outstanding -> in_progress', () => {
    expect(computeDeliveryProgress(lines, [{ shipmentLineId: 'a', kind: 'delivered', quantity: 5 }]).status).toBe('in_progress');
  });
  it('all delivered -> complete', () => {
    const p = computeDeliveryProgress(lines, [
      { shipmentLineId: 'a', kind: 'delivered', quantity: 5 },
      { shipmentLineId: 'b', kind: 'delivered', quantity: 2 },
    ]);
    expect(p.status).toBe('complete');
  });
  it('all accounted but some returned -> partial', () => {
    const p = computeDeliveryProgress(lines, [
      { shipmentLineId: 'a', kind: 'delivered', quantity: 3 },
      { shipmentLineId: 'a', kind: 'returned', quantity: 2 },
      { shipmentLineId: 'b', kind: 'delivered', quantity: 2 },
    ]);
    expect(p.status).toBe('partial');
    expect(p.lines[0]).toMatchObject({ delivered: 3, returned: 2, outstanding: 0 });
  });
});
