import { computeAuditHash, GENESIS_HASH, AuditHashInput } from './audit-hash';

/**
 * The invariant that matters per CTO Execution Policy §5: tamper and
 * chain-splice detection. Pure logic, no database needed — this is the
 * part of the Audit Engine fully verifiable in this sandbox.
 */
describe('computeAuditHash', () => {
  const base: AuditHashInput = {
    seq: 1,
    timestamp: '2026-08-22T00:00:00.000Z',
    actorUserId: 'user-1',
    organizationId: null,
    action: 'sales_order.approved',
    resource: 'sales_order',
    resourceId: 'so-1',
    result: 'success',
    correlationId: 'corr-1',
    before: { status: 'submitted' },
    after: { status: 'approved' },
    prevHash: GENESIS_HASH,
  };

  it('produces a deterministic hash for identical input', () => {
    expect(computeAuditHash(base)).toBe(computeAuditHash({ ...base }));
  });

  it('changes the hash if any content field is tampered with', () => {
    const original = computeAuditHash(base);
    const tampered = computeAuditHash({ ...base, after: { status: 'rejected' } });
    expect(tampered).not.toBe(original);
  });

  it('changes the hash if prevHash changes — detects chain splicing', () => {
    const withGenesis = computeAuditHash(base);
    const withDifferentPrev = computeAuditHash({ ...base, prevHash: 'a'.repeat(64) });
    expect(withDifferentPrev).not.toBe(withGenesis);
  });

  it('produces a 64-character hex SHA-256 digest', () => {
    const hash = computeAuditHash(base);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
