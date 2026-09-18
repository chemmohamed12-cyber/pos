import { canonicalizeJson } from './canonical-json';

describe('canonicalizeJson (ADR-051 Phase 1)', () => {
  it('produces identical output regardless of input key order', () => {
    const a = canonicalizeJson({ b: 1, a: 2, z: 3 });
    const b = canonicalizeJson({ z: 3, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('sorts nested object keys recursively', () => {
    const out = canonicalizeJson({ outer: { z: 1, a: 2 }, first: 1 });
    expect(out).toBe('{"first":1,"outer":{"a":2,"z":1}}');
  });

  it('preserves array order (arrays are not sorted)', () => {
    const out = canonicalizeJson({ list: [3, 1, 2] });
    expect(out).toBe('{"list":[3,1,2]}');
  });

  it('reproduces the exact jsonb round-trip case documented in audit-hash.ts', () => {
    // The same case that broke plain JSON.stringify hashing against a
    // PostgreSQL jsonb read-back (Commercial Release Gate finding SEC-10).
    const written = { modulesRemoved: ['hr'], dataRetained: true, zzz: 1, a: 2 };
    const readBack = { a: 2, zzz: 1, dataRetained: true, modulesRemoved: ['hr'] };
    expect(canonicalizeJson(written)).toBe(canonicalizeJson(readBack));
  });

  it('is sensitive to any actual value change', () => {
    const a = canonicalizeJson({ amount: '100.00' });
    const b = canonicalizeJson({ amount: '100.01' });
    expect(a).not.toBe(b);
  });
});
