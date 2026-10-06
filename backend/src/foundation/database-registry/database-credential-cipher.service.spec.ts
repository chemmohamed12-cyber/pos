import { DatabaseCredentialCipherService } from './database-credential-cipher.service';
import { AppConfigService } from '../configuration/app-config.service';

describe('DatabaseCredentialCipherService', () => {
  let cipher: DatabaseCredentialCipherService;

  beforeEach(() => {
    const configMock = { databaseCredentialEncryptionKey: 'a'.repeat(32) };
    cipher = new DatabaseCredentialCipherService(configMock as unknown as AppConfigService);
  });

  it('round-trips a plaintext value', () => {
    const encrypted = cipher.encrypt('super-secret-db-password');
    expect(encrypted).not.toContain('super-secret-db-password');
    expect(cipher.decrypt(encrypted)).toBe('super-secret-db-password');
  });

  it('produces a different ciphertext each time (random IV) for the same plaintext', () => {
    const first = cipher.encrypt('same-password');
    const second = cipher.encrypt('same-password');
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe('same-password');
    expect(cipher.decrypt(second)).toBe('same-password');
  });

  it('fails to decrypt a tampered ciphertext (AEAD auth tag check)', () => {
    const encrypted = cipher.encrypt('super-secret-db-password');
    const [iv, authTag, ciphertext] = encrypted.split(':');
    const tampered = `${iv}:${authTag}:${ciphertext.slice(0, -2)}00`;
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('a different encryption key cannot decrypt a value encrypted under this one (key-domain separation)', () => {
    const encrypted = cipher.encrypt('super-secret-db-password');
    const otherKeyCipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'b'.repeat(32) } as unknown as AppConfigService);
    expect(() => otherKeyCipher.decrypt(encrypted)).toThrow();
  });
});
