import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { AppConfigService } from '../configuration/app-config.service';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Multi-Company Phase 3 V7, Area 3 (Database Registry). Same AES-256-GCM
 * scheme as `CredentialCipherService` (external integrations), but keyed
 * from `DATABASE_CREDENTIAL_ENCRYPTION_KEY` — a deliberately separate key
 * so this secret domain (per-Company database credentials) is not
 * exposed by a compromise of the integration-credential domain, or vice
 * versa. Deliberately NOT a shared/generic cipher utility: V7 leaves the
 * secrets-storage "backend" choice open, and collapsing these into one
 * shared service would quietly force that decision before it's been made.
 */
@Injectable()
export class DatabaseCredentialCipherService {
  constructor(private readonly config: AppConfigService) {}

  private key(): Buffer {
    return scryptSync(this.config.databaseCredentialEncryptionKey, 'daii-database-credential-salt', 32);
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
