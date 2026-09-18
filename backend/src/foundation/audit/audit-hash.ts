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
/**
 * Deterministic, key-sorted serialization — Commercial Release Gate finding
 * SEC-10.
 *
 * `before`/`after` are **`jsonb`** columns. PostgreSQL does not preserve
 * object key order in `jsonb`: it normalizes keys (shortest first, then
 * bytewise). Proven directly against this project's own PostgreSQL 18:
 *
 *   written : {"modulesRemoved":["hr"],"dataRetained":true,"zzz":1,"a":2}
 *   read back: {"a":2,"zzz":1,"dataRetained":true,"modulesRemoved":["hr"]}
 *
 * So a hash computed with plain `JSON.stringify` at WRITE time could never
 * match the hash recomputed from the READ-BACK row — every record carrying a
 * multi-key payload failed verification, on completely untampered data. The
 * tamper-evidence chain reported "broken" 100% of the time, which is worse
 * than having no verifier at all: a control that always cries wolf gets
 * ignored, and real tampering hides in the noise.
 *
 * Sorting keys recursively before hashing makes the hash invariant to the
 * storage layer's normalization. Same technique, same reason, as
 * `foundation/entitlement/canonicalize.ts` (which solved this for manifest
 * signatures). Consolidating the two into one shared canonical-JSON utility
 * is a deliberate Cleanup-phase candidate, recorded rather than done here as
 * an unplanned refactor mid-security-fix.
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function computeAuditHash(input: AuditHashInput): string {
  const payload = JSON.stringify(sortDeep(input));
  return createHash('sha256').update(payload).digest('hex');
}
