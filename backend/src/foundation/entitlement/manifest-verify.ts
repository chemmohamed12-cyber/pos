import { createPublicKey, verify as cryptoVerify } from 'crypto';
import { canonicalize } from './canonicalize';
import { EntitlementManifest, EntitlementPublicKey, ManifestVerifyResult } from './manifest.type';

/**
 * Entitlement Engine — ERP Foundation P3. PURE, OFFLINE manifest verification
 * (ADR-026 runtime-context independence; Team B LICENSING_SECURITY_ARCHITECTURE.md §3).
 * No network, no DB, no NestJS. Ed25519 via Node native crypto — no dependency.
 *
 * A tampered / unparseable / unsigned / unknown-kid / expired manifest all
 * return `ok:false` — the caller (EntitlementService) then fails closed to
 * Core-only + alarm (ADR-023 §5).
 */
export interface VerifyOptions {
  publicKeys: readonly EntitlementPublicKey[];
  /** ms since epoch; injected for testability. Defaults to Date.now(). */
  now?: number;
  /** minutes; a clock reading earlier than last_trusted_at - tolerance is suspicious. */
  clockToleranceMinutes?: number;
  /** the installation's monotonic last-trusted timestamp (ms), if any (D3C-4). */
  lastTrustedAtMs?: number | null;
  /**
   * Commercial Release Gate — Installation Binding. This machine/deployment's
   * OWN current fingerprint (`computeInstallationFingerprint()`), injected
   * by the caller rather than computed here — keeps this function's I/O
   * surface identical to the existing `now`/`lastTrustedAtMs` pattern
   * (testable with a fixed value, no hidden `fs`/registry access inside the
   * "pure, offline" verifier). Required in production; tests that don't
   * care about the binding check can pass the same value the manifest was
   * signed with.
   */
  currentFingerprint: string;
}

export function verifyManifest(rawManifestJson: string, signatureB64: string | null | undefined, opts: VerifyOptions): ManifestVerifyResult {
  if (!signatureB64) return { ok: false, reason: 'no_signature' };
  if (!opts.publicKeys.length) return { ok: false, reason: 'no_keys' };

  let manifest: EntitlementManifest;
  try {
    manifest = JSON.parse(rawManifestJson) as EntitlementManifest;
  } catch {
    return { ok: false, reason: 'malformed', detail: 'manifest is not valid JSON' };
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.schema_version !== 1 ||
    !Array.isArray(manifest.module_codes) ||
    !manifest.kid ||
    !manifest.installation_fingerprint
  ) {
    return { ok: false, reason: 'malformed', detail: 'manifest missing required fields' };
  }

  const key = opts.publicKeys.find((k) => k.kid === manifest.kid);
  if (!key) return { ok: false, reason: 'unknown_kid', detail: manifest.kid };

  let sigOk = false;
  try {
    const pub = createPublicKey({ key: Buffer.from(key.spki_b64, 'base64'), format: 'der', type: 'spki' });
    sigOk = cryptoVerify(null, Buffer.from(canonicalize(manifest), 'utf8'), pub, Buffer.from(signatureB64, 'base64'));
  } catch (e) {
    return { ok: false, reason: 'bad_signature', detail: e instanceof Error ? e.message : String(e) };
  }
  if (!sigOk) return { ok: false, reason: 'bad_signature' };

  // --- Installation Binding / Anti-Clone (Commercial Release Gate) ---
  // The signature proves the manifest's CONTENT is authentic; it says
  // nothing about WHERE it's running. A byte-for-byte copy of a valid,
  // signed manifest onto a different machine passes every check above —
  // this is the one that actually detects the clone.
  if (manifest.installation_fingerprint !== opts.currentFingerprint) {
    return { ok: false, reason: 'fingerprint_mismatch', detail: 'signed manifest does not match this installation' };
  }

  // --- term / expiry (D3C-4) ---
  const now = opts.now ?? Date.now();
  const toleranceMs = (opts.clockToleranceMinutes ?? 10) * 60_000;
  if (opts.lastTrustedAtMs != null && now < opts.lastTrustedAtMs - toleranceMs) {
    // suspected clock rollback: be conservative — treat as expired
    return { ok: false, reason: 'expired', detail: 'clock reads earlier than last trusted validation' };
  }
  if (manifest.term_end) {
    const graceMs = (manifest.grace_days ?? 0) * 86_400_000;
    const end = Date.parse(manifest.term_end);
    if (Number.isFinite(end) && now > end + graceMs) {
      return { ok: false, reason: 'expired', detail: `term ended ${manifest.term_end}` };
    }
  }

  return { ok: true, manifest };
}
