import { ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ClosingSnapshotSigningKey } from '../infrastructure/closing-snapshot-signing-key.entity';
import { AppConfigService } from '../../../foundation/configuration/app-config.service';
import { derivePublicKeyB64, signEd25519, verifyEd25519 } from '../../../foundation/crypto/ed25519';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000'; // matches this codebase's existing convention (FiscalPeriodService et al.)

/**
 * ADR-051 §9/§10 (Month-End Closing / Black Box, Phase 1). Owns the one
 * operator-provisioned Ed25519 signing key (env-var custody, never the
 * database — ADR-051 §9) and the append-only public-key registry used to
 * verify a snapshot signed under ANY `kid` this installation has ever used,
 * including a retired one after rotation (ADR-051 §10).
 *
 * Deliberately does NOT generate a key on its own — exactly like
 * `AuthConfig`'s `JWT_ACCESS_SECRET`, provisioning a value is an operator
 * action outside the application's own runtime (ADR-051 §9). The app boots
 * fine with neither env var set; only an actual attempt to sign a snapshot
 * fails closed with a clear error.
 */
@Injectable()
export class ClosingSnapshotSigningKeyService implements OnModuleInit {
  private readonly logger = new Logger(ClosingSnapshotSigningKeyService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Self-check (ADR-051 §9): if the configured `kid` has no registry row
   * yet, this is the FIRST time this operator-provisioned key has been
   * seen — register it (mirrors `SeedDefaultBaseCurrency`'s idempotent
   * bootstrap pattern). If a row already exists for that `kid`, the
   * derived public key must match EXACTLY — a mismatch means the `kid` was
   * reused with different key material, which is startup-fatal, never
   * silently trusted.
   */
  async onModuleInit(): Promise<void> {
    const { privateKeyB64, kid } = this.config.closingSnapshotSigning;
    if (!privateKeyB64 || !kid) {
      this.logger.warn(
        'CLOSING_SNAPSHOT_SIGNING_PRIVATE_KEY / CLOSING_SNAPSHOT_SIGNING_KID not configured — Closing Snapshot generation will fail closed until an operator provisions a signing key (ADR-051 §9).',
      );
      return;
    }

    const derivedPublicKey = derivePublicKeyB64(privateKeyB64);
    const repo = this.dataSource.getRepository(ClosingSnapshotSigningKey);
    const existing = await repo.findOne({ where: { kid } });

    if (!existing) {
      await repo.save(
        repo.create({
          kid,
          publicKey: derivedPublicKey,
          validFrom: new Date(),
          validUntil: null,
          createdByUserId: SYSTEM_ACTOR_ID,
          reason: 'initial registration on startup (ADR-051 §9)',
        }),
      );
      this.logger.log(`Registered Closing Snapshot signing key kid="${kid}".`);
      return;
    }

    if (existing.publicKey !== derivedPublicKey) {
      throw new ConflictException(
        `Closing Snapshot signing key kid="${kid}" is already registered with a DIFFERENT public key. ` +
          'Reusing a kid with different key material is not permitted — provision a new, distinct kid instead (ADR-051 §10).',
      );
    }
  }

  /** Signs `data` with the currently-configured private key. Fails closed if none is configured. */
  sign(data: string): { kid: string; signature: string } {
    const { privateKeyB64, kid } = this.config.closingSnapshotSigning;
    if (!privateKeyB64 || !kid) {
      throw new ConflictException(
        'No Closing Snapshot signing key is configured (CLOSING_SNAPSHOT_SIGNING_PRIVATE_KEY / CLOSING_SNAPSHOT_SIGNING_KID) — cannot generate a signed snapshot.',
      );
    }
    return { kid, signature: signEd25519(privateKeyB64, data) };
  }

  /** Verifies `data`/`signature` against the registry's record for `kid` — works for any `kid` ever used, including a retired one (ADR-051 §10). */
  async verify(data: string, signature: string, kid: string): Promise<{ ok: boolean; reason?: 'unknown_kid' | 'bad_signature' }> {
    const key = await this.dataSource.getRepository(ClosingSnapshotSigningKey).findOne({ where: { kid } });
    if (!key) return { ok: false, reason: 'unknown_kid' };
    const ok = verifyEd25519(key.publicKey, data, signature);
    return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
  }
}
