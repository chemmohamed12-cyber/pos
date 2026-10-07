import { HttpStatus } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DaiiException } from '../error-contract/daii-exception';
import { AuthorizationContext } from '../authorization/authorization-context';

/**
 * Authorization Foundation F2 — pure helpers and Company-DB primitives shared by the Company Users services.
 * The Company database's `user_roles` is the AUTHORITY for a member's roles; `user_company_memberships.roleKey` is only a compatibility mirror.
 */

/** Role keys that carry Company administration. `company_admin` is the F3 key; today every Company's administrator role is `admin`. */
export const ADMIN_ROLE_KEYS: readonly string[] = ['admin', 'company_admin'];

type CompanyUserErrorCode = 'LAST_ADMIN' | 'SELF_ROLE_CHANGE' | 'ROLE_EXCEEDS_GRANTOR' | 'UNKNOWN_ROLE' | 'NOT_A_MEMBER' | 'ALREADY_MEMBER' | 'INVITATION_INVALID' | 'ACCOUNT_EXISTS_SIGN_IN' | 'INVALID_INPUT';

const STATUS: Record<CompanyUserErrorCode, HttpStatus> = {
  LAST_ADMIN: HttpStatus.CONFLICT,
  SELF_ROLE_CHANGE: HttpStatus.FORBIDDEN,
  ROLE_EXCEEDS_GRANTOR: HttpStatus.FORBIDDEN,
  UNKNOWN_ROLE: HttpStatus.BAD_REQUEST,
  NOT_A_MEMBER: HttpStatus.NOT_FOUND,
  ALREADY_MEMBER: HttpStatus.CONFLICT,
  INVITATION_INVALID: HttpStatus.NOT_FOUND,
  ACCOUNT_EXISTS_SIGN_IN: HttpStatus.CONFLICT,
  INVALID_INPUT: HttpStatus.BAD_REQUEST,
};

/** Domain errors of the Company Users surface: a `DaiiException` (stable `code`, mapped HTTP status) so the error contract renders them uniformly. */
export class CompanyUserError extends DaiiException {
  constructor(code: CompanyUserErrorCode, message: string, detail?: Record<string, unknown>) {
    super(code, message, STATUS[code], detail);
  }
}

/** The primary role mirrored into `membership.roleKey`: an administrator role first, else the previous primary if still held, else alphabetical; `'none'`-free: an empty set mirrors the empty string-safe value `'-'`. */
export function primaryRoleKey(roleKeys: readonly string[], previousPrimary?: string | null): string {
  if (roleKeys.length === 0) return '-';
  const admin = ADMIN_ROLE_KEYS.find((k) => roleKeys.includes(k));
  if (admin) return admin;
  if (previousPrimary && roleKeys.includes(previousPrimary)) return previousPrimary;
  return [...roleKeys].sort()[0];
}

export function normalizeRoleKeys(input: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const k of input) {
    if (typeof k !== 'string' || !/^[a-z0-9_.-]{1,64}$/i.test(k.trim())) throw new CompanyUserError('INVALID_INPUT', 'Role keys must be non-empty identifiers.');
    const v = k.trim();
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export interface CompanyRoleRow {
  id: string;
  key: string;
}

export async function loadRolesByKeys(manager: EntityManager, keys: readonly string[]): Promise<CompanyRoleRow[]> {
  if (keys.length === 0) return [];
  return manager.query(`SELECT "id", "key" FROM "roles" WHERE "key" = ANY($1::text[])`, [keys as string[]]);
}

export async function currentRoleKeys(manager: EntityManager, userId: string): Promise<string[]> {
  const rows: Array<{ key: string }> = await manager.query(
    `SELECT r."key" AS "key" FROM "user_roles" ur INNER JOIN "roles" r ON r."id" = ur."roleId" WHERE ur."userId" = $1 ORDER BY r."key"`,
    [userId],
  );
  return rows.map((r) => r.key);
}

/** Every user id that holds an administrator role in THIS Company database (distinct). */
export async function adminHolderUserIds(manager: EntityManager): Promise<string[]> {
  const rows: Array<{ userId: string }> = await manager.query(
    `SELECT DISTINCT ur."userId" AS "userId" FROM "user_roles" ur INNER JOIN "roles" r ON r."id" = ur."roleId" WHERE r."key" = ANY($1::text[])`,
    [ADMIN_ROLE_KEYS as string[]],
  );
  return rows.map((r) => r.userId);
}

/** Serialises every operation that can remove an administrator in one Company (held until the surrounding Company transaction ends). */
export async function lockAdministration(manager: EntityManager, companyId: string): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`company-admin-set:${companyId}`]);
}

/** Replaces the user's role set in the Company DB with exactly `roleIds` (idempotent). */
export async function replaceUserRoles(manager: EntityManager, userId: string, roleIds: readonly string[]): Promise<void> {
  await manager.query(`DELETE FROM "user_roles" WHERE "userId" = $1 AND NOT ("roleId" = ANY($2::uuid[]))`, [userId, roleIds as string[]]);
  for (const roleId of roleIds) {
    await manager.query(`INSERT INTO "user_roles" ("userId", "roleId") VALUES ($1, $2) ON CONFLICT ("userId", "roleId") DO NOTHING`, [userId, roleId]);
  }
}

export interface GrantRow {
  roleKey: string;
  nodeKey: string;
  access: 'hidden' | 'read-only' | 'editable';
}

/**
 * Anti-self-elevation (Blueprint §6.2, F2 rule): an actor may add or remove a role only if THEY hold every grant that role carries — a role is
 * never assignable beyond the grantor's own authority. Returns the (role, node, level) triples the actor lacks; empty = allowed.
 * Evaluated on the actor's request-scoped AuthorizationContext (the same grants the guards used), never on client input.
 */
export async function grantsBeyondActor(manager: EntityManager, actor: AuthorizationContext, roleKeys: readonly string[]): Promise<GrantRow[]> {
  if (roleKeys.length === 0) return [];
  const rows: GrantRow[] = await manager.query(
    `SELECT r."key" AS "roleKey", rp."nodeKey" AS "nodeKey", rp."access" AS "access"
       FROM "roles" r INNER JOIN "role_permissions" rp ON rp."roleId" = r."id"
      WHERE r."key" = ANY($1::text[])`,
    [roleKeys as string[]],
  );
  return rows.filter((g) => g.access !== 'hidden' && !actor.hasAtLeast(g.nodeKey, g.access));
}
