import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'crypto';

/**
 * ADR-051 (Month-End Closing / Black Box, Phase 1). Ed25519 sign/verify for
 * the Closing Snapshot signing key — native Node `crypto`, no dependency,
 * DER/base64 key encoding, mirroring the exact verification mechanics
 * already proven in `foundation/entitlement/manifest-verify.ts` (SPKI for
 * the public key, `verify(null, data, keyObject, signature)` for Ed25519 —
 * the `null` digest algorithm is correct and required: EdDSA has the hash
 * built into the scheme, unlike RSA/ECDSA). Signing is the one primitive
 * `manifest-verify.ts` never needed (entitlement manifests are vendor-signed
 * outside this application) and is added here for the first time.
 */
export interface Ed25519KeyPairB64 {
  /** SPKI, DER, base64 — same encoding convention as `EntitlementPublicKeyConfig.spki_b64`. */
  publicKeyB64: string;
  /** PKCS8, DER, base64. Never persisted to the database — env-var only (ADR-051 §9). */
  privateKeyB64: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPairB64 {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyB64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Derives the SPKI public key from a PKCS8 private key — used to self-check a `kid`'s registered public key against the operator-supplied private key at startup (ADR-051 §9). */
export function derivePublicKeyB64(privateKeyB64: string): string {
  const priv = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv);
  return pub.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function signEd25519(privateKeyB64: string, data: string): string {
  const priv = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return cryptoSign(null, Buffer.from(data, 'utf8'), priv).toString('base64');
}

export function verifyEd25519(publicKeyB64: string, data: string, signatureB64: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(data, 'utf8'), pub, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
