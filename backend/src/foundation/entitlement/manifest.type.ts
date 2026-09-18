/**
 * Entitlement Engine — ERP Foundation P3.
 * The signed Entitlement Manifest = ADR-028 `InstallationState`. ONE shape,
 * shared with Team B's LICENSING_SECURITY_ARCHITECTURE.md §2. P3_BLUEPRINT.md §2.
 */
export interface EntitlementManifest {
  schema_version: 1;
  installation_id: string;
  customer_name: string;
  edition_code: string;
  edition_version: string;
  /** subset of the 5 module_codes; the resolver expands to the depends_on closure (F-MOD-2). */
  module_codes: string[];
  /** enabled toggleable feature_codes. */
  feature_codes: string[];
  /** limit_key -> value; null = unlimited. Overrides the edition defaults. */
  limits: Record<string, number | null>;
  /** edition-scoped config_values seed (feeds the P2 EDITION precedence layer). */
  config_overrides?: Record<string, unknown>;
  issued_at: string;
  term_start?: string;
  term_end?: string | null;
  grace_days?: number;
  license_id: string;
  license_version: number;
  /** which configured public key verifies the signature. */
  kid: string;
  /**
   * Commercial Release Gate — Installation Binding / Anti-Clone
   * (`architecture/LICENSE_BINDING_AND_ANTI_CLONE_ASSESSMENT.md` §2).
   * The SHA-256 hex digest from `computeInstallationFingerprint()`, run on
   * the CUSTOMER's own machine at issuance time and supplied to Daii
   * out-of-band (`tools/release/print-installation-fingerprint.js`) — never
   * computed by the issuer. Signed as part of this manifest like every
   * other field; `EntitlementService` re-computes its own current value on
   * every `reload()`/`applyManifest()` and fail-closes to Core-only on any
   * mismatch, exactly like a bad signature. Required — every manifest
   * issued from now on must carry it (this product has no live commercial
   * customers yet, so there is no legacy-manifest compatibility burden).
   */
  installation_fingerprint: string;
}

export type ManifestVerifyReason = 'no_signature' | 'no_keys' | 'unknown_kid' | 'bad_signature' | 'malformed' | 'expired' | 'fingerprint_mismatch';

export type ManifestVerifyResult =
  | { ok: true; manifest: EntitlementManifest }
  | { ok: false; reason: ManifestVerifyReason; detail?: string };

export interface EntitlementPublicKey {
  kid: string;
  /** base64 of the SPKI DER form of the Ed25519 public key. */
  spki_b64: string;
}

export const DAII_STANDARD_EDITION = 'DAII_STANDARD';
