import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-Company Phase 3 V7, Area 5 (Company Context in Authentication).
 * Nullable — most sessions still have no Company context (the great
 * majority of routes are not yet Company-scoped). When set, it is the
 * Company a `selectCompany`-issued token pair was scoped to, preserved
 * across `refresh()` rotations so a refreshed access token keeps the same
 * Company claim as the one it replaces. It is a carried CLAIM only — never
 * trusted as authorization proof by itself; `CompanyContextGuard`
 * re-validates `Membership` against the database on every request
 * regardless of what a token claims. No FK to `companies`: `RefreshToken`
 * is a Control-Plane/platform table like `Membership`, and Company
 * deletion/decommission is not this migration's concern.
 */
export class AddCompanyIdToRefreshTokens1789810000000 implements MigrationInterface {
  name = 'AddCompanyIdToRefreshTokens1789810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "refresh_tokens" ADD COLUMN "companyId" UUID`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP COLUMN "companyId"`);
  }
}
