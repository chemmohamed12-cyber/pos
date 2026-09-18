import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditRecord } from './audit-record.entity';
import { computeAuditHash, GENESIS_HASH } from './audit-hash';

/**
 * verifyChain() is the code path Backup/Recovery integrity verification
 * (ADR-020 §3) depends on — proportional coverage per CTO Execution
 * Policy §5: a valid chain passes, and a tampered record is detected.
 * Record creation itself (transaction + row lock) needs live-Postgres
 * integration verification (documented limitation, same as every
 * DB-dependent milestone so far).
 */
describe('AuditService.verifyChain', () => {
  let service: AuditService;
  let records: AuditRecord[];

  function buildValidChain(): AuditRecord[] {
    const chain: AuditRecord[] = [];
    let prevHash = GENESIS_HASH;
    for (let seq = 1; seq <= 3; seq++) {
      const timestamp = new Date(`2026-08-22T00:0${seq}:00.000Z`);
      const record: Partial<AuditRecord> = {
        seq,
        timestamp,
        actorUserId: 'user-1',
        organizationId: null,
        action: 'test.action',
        resource: 'test_resource',
        resourceId: `res-${seq}`,
        result: 'success',
        correlationId: null,
        before: null,
        after: null,
        prevHash,
      };
      const hash = computeAuditHash({
        seq,
        timestamp: timestamp.toISOString(),
        actorUserId: record.actorUserId!,
        organizationId: record.organizationId!,
        action: record.action!,
        resource: record.resource!,
        resourceId: record.resourceId!,
        result: record.result!,
        correlationId: record.correlationId!,
        before: record.before!,
        after: record.after!,
        prevHash,
      });
      record.hash = hash;
      chain.push(record as AuditRecord);
      prevHash = hash;
    }
    return chain;
  }

  const dataSourceMock = {
    getRepository: jest.fn(() => ({
      find: jest.fn(async () => records),
    })),
  };

  beforeEach(async () => {
    records = buildValidChain();
    const moduleRef = await Test.createTestingModule({
      providers: [AuditService, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    service = moduleRef.get(AuditService);
  });

  it('validates an untampered chain', async () => {
    const result = await service.verifyChain();
    expect(result).toEqual({ valid: true, brokenAtSeq: null });
  });

  it('detects a tampered record', async () => {
    records[1].action = 'tampered.action'; // mutate seq 2's content without recomputing its hash
    const result = await service.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });

  it('detects a spliced chain (prevHash pointing to the wrong predecessor)', async () => {
    records[2].prevHash = 'f'.repeat(64);
    const result = await service.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(3);
  });
});
