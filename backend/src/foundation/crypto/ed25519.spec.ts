import { derivePublicKeyB64, generateEd25519KeyPair, signEd25519, verifyEd25519 } from './ed25519';

describe('Ed25519 sign/verify (ADR-051 Phase 1)', () => {
  it('a signature verifies against the matching public key', () => {
    const { publicKeyB64, privateKeyB64 } = generateEd25519KeyPair();
    const signature = signEd25519(privateKeyB64, 'closing-snapshot-manifest-content');
    expect(verifyEd25519(publicKeyB64, 'closing-snapshot-manifest-content', signature)).toBe(true);
  });

  it('rejects a signature if the signed data changes (tamper detection)', () => {
    const { publicKeyB64, privateKeyB64 } = generateEd25519KeyPair();
    const signature = signEd25519(privateKeyB64, 'original content');
    expect(verifyEd25519(publicKeyB64, 'tampered content', signature)).toBe(false);
  });

  it('rejects a signature verified against the wrong public key', () => {
    const pair1 = generateEd25519KeyPair();
    const pair2 = generateEd25519KeyPair();
    const signature = signEd25519(pair1.privateKeyB64, 'data');
    expect(verifyEd25519(pair2.publicKeyB64, 'data', signature)).toBe(false);
  });

  it('never throws on malformed input — fails closed as false', () => {
    expect(verifyEd25519('not-a-valid-key', 'data', 'not-a-valid-signature')).toBe(false);
  });

  it('derivePublicKeyB64 recovers the exact public key from its private key', () => {
    const { publicKeyB64, privateKeyB64 } = generateEd25519KeyPair();
    expect(derivePublicKeyB64(privateKeyB64)).toBe(publicKeyB64);
  });
});
