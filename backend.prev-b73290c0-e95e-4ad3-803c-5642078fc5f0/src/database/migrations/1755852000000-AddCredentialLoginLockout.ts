import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Security review (master continuation directive) — per-account login
 * lockout, the second half of the brute-force gap rate limiting alone
 * doesn't cover. `failedLoginAttempts` resets to 0 on any successful
 * login or password change; `lockedUntil` is set once it crosses
 * MAX_FAILED_LOGIN_ATTEMPTS (AuthService.login) and cleared on success.
 * Existing rows default to 0/null — no account is retroactively locked.
 */
export class AddCredentialLoginLockout1755852000000 implements MigrationInterface {
  name = 'AddCredentialLoginLockout1755852000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "credentials" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "credentials" ADD COLUMN "lockedUntil" TIMESTAMPTZ`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "credentials" DROP COLUMN "lockedUntil"`);
    await queryRunner.query(`ALTER TABLE "credentials" DROP COLUMN "failedLoginAttempts"`);
  }
}
