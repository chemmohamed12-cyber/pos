import { createHash } from 'crypto';

/** Fixed genesis hash so chain-splicing at position 0 is also detectable (RMS pattern, Class B extraction). */
export const GENESIS_HASH = '0'.repeat(64);

export interface AuditHashInput {
  seq: number;
  timestamp: string; // ISO string — stable, unlike a Date object's serialization
  actorUserId: string | null;
  organizationId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  result: 'success' | 'failure' | 'denied';
  correlationId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  prevHash: string;
}

/**
 * Audit Engine — Stage 2 build-order item 11.
 * Daii/architecture/DAII_EVENT_ARCHITECTURE.md §3, ADR-012, ADR-017.
 * Adapted from XNEXUS RMS's kernel/audit (Class B, the one module its
 * own audit called "fully real, not a stub" —
 * Daii/_source-audits/rms-step30/): each record's hash commits to its
 * own content plus the previous record's hash, so both tampering with a
 * record and splicing the chain are detectable. Pure function, no I/O —
 * kept separate from AuditService so the hash math is directly testable
 * without a database.
 */
export function computeAuditHash(input: AuditHashInput): string {
  const payload = JSON.stringify(input);
  return createHash('sha256').update(payload).digest('hex');
}
