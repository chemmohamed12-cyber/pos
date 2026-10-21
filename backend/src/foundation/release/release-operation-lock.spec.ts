import { ConflictException } from '@nestjs/common';
import { ReleaseOperationLock, releaseOperationLock } from './release-operation-lock';
import { ReleaseExecutionService } from './release-execution.service';

/** Deploy and Company catch-up never run together (1.1.13): both change Company databases. */
describe('ReleaseOperationLock', () => {
  it('counts deploys and tracks one catch-up', () => {
    const l = new ReleaseOperationLock();
    expect(l.deployInProgress).toBe(false);
    l.beginDeploy();
    l.beginDeploy();
    l.endDeploy();
    expect(l.deployInProgress).toBe(true);
    l.endDeploy();
    l.endDeploy(); // never below zero
    expect(l.deployInProgress).toBe(false);
    l.beginCatchUp();
    expect(l.catchUpRunning).toBe(true);
    l.endCatchUp();
    expect(l.catchUpRunning).toBe(false);
  });
});

describe('ReleaseExecutionService.deployRelease x catch-up lock', () => {
  afterEach(() => {
    releaseOperationLock.endCatchUp();
    while (releaseOperationLock.deployInProgress) releaseOperationLock.endDeploy();
  });
  const svc = (inner: () => Promise<unknown>) => {
    const s = Object.create(ReleaseExecutionService.prototype) as { deployRelease: (a: string, b: string) => Promise<unknown>; deployReleaseUnlocked: () => Promise<unknown> };
    s.deployReleaseUnlocked = jest.fn(inner);
    return s;
  };

  it('a deploy is REFUSED while a catch-up runs, before anything is touched', async () => {
    const s = svc(async () => 'deployed');
    releaseOperationLock.beginCatchUp();
    await expect(s.deployRelease('r', 'a')).rejects.toBeInstanceOf(ConflictException);
    expect(s.deployReleaseUnlocked).not.toHaveBeenCalled();
  });

  it('while a deploy runs the lock says so, and it is released when the deploy ends - also when it throws', async () => {
    let seen = false;
    const ok = svc(async () => {
      seen = releaseOperationLock.deployInProgress;
      return 'deployed';
    });
    await expect(ok.deployRelease('r', 'a')).resolves.toBe('deployed');
    expect(seen).toBe(true);
    expect(releaseOperationLock.deployInProgress).toBe(false);
    const bad = svc(async () => {
      throw new Error('boom');
    });
    await expect(bad.deployRelease('r', 'a')).rejects.toThrow('boom');
    expect(releaseOperationLock.deployInProgress).toBe(false);
  });
});
