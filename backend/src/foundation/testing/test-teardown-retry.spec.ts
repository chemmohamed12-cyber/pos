import { TEARDOWN_DELAYS_MS, TEARDOWN_MAX_ATTEMPTS, dropWithBoundedRetry, isTransientDropFailure, resetTeardownDropRecords, teardownDropRecords } from './test-teardown-retry';

/** Database-free unit proof of the bounded teardown retry (test infrastructure; CTO closeout directive 2026-10-13, phase 2.2). */
const denied = () => Object.assign(new Error('permission denied to terminate process'), { code: '42501' });
const inUse = () => Object.assign(new Error('database "x" is being accessed by other users'), { code: '55006' });

describe('dropWithBoundedRetry', () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  let warn: jest.SpyInstance;

  beforeEach(() => {
    sleeps.length = 0;
    resetTeardownDropRecords();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('the bound is fixed in advance: 5 attempts, waits 250/500/1000/2000 ms (3.75 s at most)', () => {
    expect(TEARDOWN_MAX_ATTEMPTS).toBe(5);
    expect([...TEARDOWN_DELAYS_MS]).toEqual([250, 500, 1000, 2000]);
  });

  it('a clean drop is one attempt, no wait, no log', async () => {
    const drop = jest.fn(async () => undefined);
    const rec = await dropWithBoundedRetry('daii_test_biz_t90_x', drop, sleep);
    expect(rec).toMatchObject({ attempts: 1, outcome: 'dropped', originalError: null });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the observed race (42501 permission denied to terminate process) is retried with escalating waits, then succeeds; the ORIGINAL error, the attempt count and the outcome are recorded and logged', async () => {
    const drop = jest.fn().mockRejectedValueOnce(denied()).mockRejectedValueOnce(inUse()).mockResolvedValueOnce(undefined);
    const rec = await dropWithBoundedRetry('daii_test_biz_t90_x', drop, sleep);
    expect(rec).toMatchObject({ attempts: 3, outcome: 'dropped-after-retry', originalError: 'permission denied to terminate process', finalError: null, waitedMs: 750 });
    expect(sleeps).toEqual([250, 500]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('permission denied to terminate process');
    expect(teardownDropRecords()).toHaveLength(1);
  });

  it('after the last attempt the failure is raised as a TEST-INFRASTRUCTURE error (never swallowed), with exactly 5 attempts and the original error', async () => {
    const drop = jest.fn(async () => {
      throw denied();
    });
    await expect(dropWithBoundedRetry('daii_test_biz_t90_x', drop, sleep)).rejects.toThrow(/TEST-INFRASTRUCTURE: could not drop disposable database "daii_test_biz_t90_x" after 5 attempts/);
    expect(drop).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([250, 500, 1000, 2000]);
    expect(teardownDropRecords()[0]).toMatchObject({ outcome: 'failed-after-retries', attempts: 5, originalError: 'permission denied to terminate process' });
  });

  it('any other error is NOT retried: re-thrown on the first attempt, unchanged', async () => {
    const boom = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const drop = jest.fn(async () => {
      throw boom;
    });
    await expect(dropWithBoundedRetry('daii_test_biz_t90_x', drop, sleep)).rejects.toBe(boom);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(teardownDropRecords()[0]).toMatchObject({ outcome: 'failed-non-transient', attempts: 1 });
  });

  it('classification: only 55006, and 42501 with the terminate-process message, are transient (TypeORM driverError shape included)', () => {
    expect(isTransientDropFailure(denied())).toBe(true);
    expect(isTransientDropFailure(inUse())).toBe(true);
    expect(isTransientDropFailure({ driverError: { code: '42501', message: 'permission denied to terminate process' } })).toBe(true);
    expect(isTransientDropFailure(Object.assign(new Error('permission denied for database x'), { code: '42501' }))).toBe(false);
    expect(isTransientDropFailure(Object.assign(new Error('syntax error'), { code: '42601' }))).toBe(false);
    expect(isTransientDropFailure(null)).toBe(false);
  });
});
