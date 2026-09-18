import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { AppConfigService } from '../../configuration/app-config.service';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * External Integrations — CTO directive §11: pairing credentials "must
 * be encrypted at rest... never stored in source code... never
 * committed to Git." AES-256-GCM with a per-value random IV; the key is
 * derived (scrypt, fixed app-level salt — this derives a symmetric key
 * from a high-entropy app secret, not a user password, so a fixed salt
 * is the correct tradeoff here) from `INTEGRATION_ENCRYPTION_KEY`
 * (`AppConfigService`), which itself has a startup-time hard-failure
 * guard against the dev-only default in production
 * (`configuration.schema.ts`) — directly acting on the lesson
 * `_source-audits/xnexus-website`'s own capability audit §5 flags
 * (per-domain auth secrets silently defaulting to a well-known dev
 * string in production).
 */
@Injectable()
export class CredentialCipherService {
  constructor(private readonly config: AppConfigService) {}

  private key(): Buffer {
    return scryptSync(this.config.integrationEncryptionKey, 'daii-integration-credential-salt', 32);
  }

  /** Format: `<ivHex>:<authTagHex>:<ciphertextHex>` — self-contained, no external state needed to decrypt. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
  }

  decrypt(encoded: string): string {
    const [ivHex, authTagHex, ciphertextHex] = encoded.split(':');
    const decipher = createDecipheriv(ALGORITHM, this.key(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
    return plaintext.toString('utf8');
  }
}
