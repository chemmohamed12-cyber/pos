/**
 * Entitlement Engine — ERP Foundation P3. Deterministic JSON canonicalization
 * for signing/verifying the Entitlement Manifest (P3_BLUEPRINT.md §2, D3C-2).
 *
 * Pure. Recursively sorts object keys and emits compact JSON (no whitespace).
 * Arrays keep their order. This is the exact byte sequence the Ed25519
 * signature covers. (RFC 8785 / JCS is the eventual target — a small
 * key-sorted stringify is sufficient and dependency-free for V1; the P6
 * blueprint may upgrade it, which only requires re-issuing manifests.)
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
