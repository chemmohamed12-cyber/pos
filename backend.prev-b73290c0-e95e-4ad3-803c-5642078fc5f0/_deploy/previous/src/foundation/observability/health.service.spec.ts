import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { HealthService } from './health.service';

/**
 * The invariant that matters per RMS's own discipline (adopted here):
 * a real failing dependency must be reported as unhealthy, not masked
 * by a hardcoded "ok".
 */
describe('HealthService', () => {
  it('reports healthy when the database round-trip succeeds', async () => {
    const dataSourceMock = { query: jest.fn(async () => [{ '?column?': 1 }]) };
    const moduleRef = await Test.createTestingModule({
      providers: [HealthService, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    const service = moduleRef.get(HealthService);

    const result = await service.checkAll();
    expect(result.status).toBe('ok');
    expect(result.components).toEqual([{ name: 'database', healthy: true }]);
  });

  it('reports degraded, with the real error detail, when the database round-trip fails', async () => {
    const dataSourceMock = { query: jest.fn(async () => { throw new Error('connection refused'); }) };
    const moduleRef = await Test.createTestingModule({
      providers: [HealthService, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    const service = moduleRef.get(HealthService);

    const result = await service.checkAll();
    expect(result.status).toBe('degraded');
    expect(result.components[0].healthy).toBe(false);
    expect(result.components[0].detail).toContain('connection refused');
  });
});
