/**
 * ADR-051 (Month-End Closing / Black Box, Phase 1). Deterministic JSON
 * canonicalization for the Closing Snapshot manifest's content hash and
 * Ed25519 signature — recursively sorts object keys, compact output, arrays
 * keep their order.
 *
 * This is deliberately the SAME algorithm already proven correct in two
 * other places in this codebase (`foundation/audit/audit-hash.ts`'s
 * `sortDeep`, `foundation/entitlement/canonicalize.ts`) — both exist
 * specifically because PostgreSQL `jsonb` storage does not preserve object
 * key order, so hashing/signing with plain `JSON.stringify` against a
 * read-back row fails non-deterministically. A third, independent copy is
 * created here rather than importing either existing one, to avoid wiring
 * the `accounting` domain to `foundation/entitlement` (a licensing concern)
 * or to `foundation/audit` (whose hash-chain has a different, global scope
 * — Study §3.5) merely to reach a 10-line pure function. Consolidating all
 * three into one shared utility remains a deliberate, disclosed future
 * cleanup (Revision 1 §M.1) — not done here to avoid touching two other
 * already-shipped, security-sensitive call sites as a side effect of this
 * unrelated feature.
 */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

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
