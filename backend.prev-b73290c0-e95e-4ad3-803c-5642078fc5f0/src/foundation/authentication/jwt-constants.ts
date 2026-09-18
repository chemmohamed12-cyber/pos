/**
 * Security Assurance Gate — Track S9 (Secrets/Cryptography). Closes
 * AUDIT-SEC-05 (JWT: no explicit `algorithms` allowlist on verify).
 *
 * `@nestjs/jwt` (backed by `jsonwebtoken`) infers an acceptable algorithm
 * set from the key type when `algorithms` is omitted, which for a plain
 * string secret already excludes asymmetric algorithms in current library
 * versions — this is why the RT03-7 `alg:none` forged-token attack was
 * already rejected before this fix. That is an implicit, version-dependent
 * default, not a declared contract: OWASP ASVS 5.0 (6.2.x) and NIST SSDF
 * both call for algorithm selection to be an explicit application-level
 * decision, not inherited from a library default that could change on an
 * upgrade. One shared constant, one place, both `sign` and `verify` call
 * sites reference it — never re-typed per call site (the exact drift risk
 * this fix removes).
 */
import type { Algorithm } from 'jsonwebtoken';

export const JWT_ALGORITHM: Algorithm = 'HS256';
export const JWT_SIGN_OPTIONS = { algorithm: JWT_ALGORITHM };
export const JWT_VERIFY_OPTIONS: { algorithms: Algorithm[] } = { algorithms: [JWT_ALGORITHM] };
