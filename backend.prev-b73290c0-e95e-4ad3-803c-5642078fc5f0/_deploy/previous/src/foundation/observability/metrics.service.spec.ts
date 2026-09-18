import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('accumulates counter increments', () => {
    const metrics = new MetricsService();
    metrics.increment('orders.created');
    metrics.increment('orders.created');
    metrics.increment('orders.created', 3);
    expect(metrics.getCounter('orders.created')).toBe(5);
  });

  it('returns 0 for a counter that was never incremented', () => {
    const metrics = new MetricsService();
    expect(metrics.getCounter('never.touched')).toBe(0);
  });

  it('records durations for later inspection', () => {
    const metrics = new MetricsService();
    metrics.recordDuration('db.query', 12);
    metrics.recordDuration('db.query', 34);
    expect(metrics.getDurations('db.query')).toEqual([12, 34]);
  });
});
