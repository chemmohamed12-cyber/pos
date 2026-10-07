import { HttpStatus } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DaiiException } from '../error-contract/daii-exception';
import { criticalNodesCovered, Grant } from '../permission/role-grant-math';
import { AuthorizationContext } from '../authorization/authorization-context';

/**
 * Authorization Foundation F2 — pure helpers and Company-DB primitives shared by the Company Users services.
 * The Company database's `user_roles` is the AUTHORITY for a member's roles; `user_company_memberships.roleKey` is only a compatibility mirror.
 */

/** Role keys that carry Company administration. `company_admin` is the F3 key; today every Company's administrator role is `admin`. */
export const ADMIN_ROLE_KEYS: readonly string[] = ['admin', 'company_admin'];

type CompanyUserErrorCode = 'LAST_ADMIN' | 'SELF_ROLE_CHANGE' | 'ROLE_EXCEEDS_GRANTOR' | 'UNKNOWN_ROLE' | 'NOT_A_MEMBER' | 'ALREADY_MEMBER' | 'INVITATION_INVALID' | 'ACCOUNT_EXISTS_SIGN_IN' | 'INVALID_INPUT'
  | 'ROLE_NOT_FOUND' | 'ROLE_PROTECTED' | 'ROLE_IN_USE' | 'ROLE_EXISTS' | 'ROLE_INACTIVE' | 'ROLE_CUSTOMIZED' | 'UNKNOWN_NODE' | 'NODE_NOT_ENTITLED' | 'ADMINISTRATION_WOULD_BE_LOST' | 'NO_TEMPLATE_UPDATE';

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
  ROLE_NOT_FOUND: HttpStatus.NOT_FOUND,
  ROLE_PROTECTED: HttpStatus.CONFLICT,
  ROLE_IN_USE: HttpStatus.CONFLICT,
  ROLE_EXISTS: HttpStatus.CONFLICT,
  ROLE_INACTIVE: HttpStatus.CONFLICT,
  ROLE_CUSTOMIZED: HttpStatus.CONFLICT,
  UNKNOWN_NODE: HttpStatus.BAD_REQUEST,
  NODE_NOT_ENTITLED: HttpStatus.BAD_REQUEST,
  ADMINISTRATION_WOULD_BE_LOST: HttpStatus.CONFLICT,
  NO_TEMPLATE_UPDATE: HttpStatus.CONFLICT,
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
  /** F3: an inactive role cannot be newly assigned (existing holders keep it). */
  isActive: boolean;
}

export async function loadRolesByKeys(manager: EntityManager, keys: readonly string[]): Promise<CompanyRoleRow[]> {
  if (keys.length === 0) return [];
  return manager.query(`SELECT "id", "key", "isActive" FROM "roles" WHERE "key" = ANY($1::text[])`, [keys as string[]]);
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
 * Anti-self-elevation (Blueprint §6.2), risk-aware since F3. Administration authority (the members / roles management nodes the endpoint guard
 * already required) lets an actor assign or remove ANY role whose reach is non-critical; a role that reaches CRITICAL nodes (see `permission-risk.ts`) can be
 * assigned or removed only by an actor who holds each of those critical nodes EXPLICITLY (an `editable` grant reaching them, on their own request-scoped
 * AuthorizationContext) — administration alone never confers critical power, and nobody can hand out what they do not hold. Returns the (role, critical
 * node) pairs the actor lacks; empty = allowed.
 */
export async function grantsBeyondActor(manager: EntityManager, actor: AuthorizationContext, roleKeys: readonly string[]): Promise<GrantRow[]> {
  if (roleKeys.length === 0) return [];
  const rows: GrantRow[] = await manager.query(
    `SELECT r."key" AS "roleKey", rp."nodeKey" AS "nodeKey", rp."access" AS "access"
       FROM "roles" r INNER JOIN "role_permissions" rp ON rp."roleId" = r."id"
      WHERE r."key" = ANY($1::text[])`,
    [roleKeys as string[]],
  );
  const byRole = new Map<string, Grant[]>();
  for (const g of rows) byRole.set(g.roleKey, [...(byRole.get(g.roleKey) ?? []), { node: g.nodeKey, access: g.access }]);
  const beyond: GrantRow[] = [];
  for (const [roleKey, grants] of byRole) {
    for (const node of criticalNodesCovered(grants)) {
      if (!actor.hasAtLeast(node, 'editable')) beyond.push({ roleKey, nodeKey: node, access: 'editable' });
    }
  }
  return beyond;
}
