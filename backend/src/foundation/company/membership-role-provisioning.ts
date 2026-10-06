import { DataSource, EntityManager } from 'typeorm';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';

export class RoleNotSeededError extends Error {}

/** Either a whole Company `DataSource` or an `EntityManager` already inside that Company's own transaction. Both expose `.getRepository()`, which is all these functions need. */
type CompanyConnection = DataSource | EntityManager;

/**
 * Multi-Company Area 6/5 (2026-09-23, Model B decision). `Membership`
 * (Platform DB) is the source of the User↔Company relationship; this is
 * the mechanical follow-through into a Company's own database — the exact
 * seeding mechanism `company-role-seeding.ts` already established, reused
 * rather than reinvented (locked instruction: "أعيدوا استخدام الـ
 * seeding/provisioning mechanism الموجود بالفعل"). `Role`/`UserRole` here
 * are the SAME entity classes `AuthorizationService` queries — just bound
 * to `dataSource`, a specific Company's own connection, not the ambient
 * one.
 *
 * Fails loudly (never silently grants nothing) if the named role isn't in
 * that Company's own `roles` table yet — this is exactly the "provisioning
 * sequencing" invariant `Membership`'s own doc comment already describes
 * (role catalog seeded before a Membership can grant it).
 */
export async function provisionUserRoleForMembership(dataSource: CompanyConnection, userId: string, roleKey: string): Promise<void> {
  const roleRepo = dataSource.getRepository(Role);
  const role = await roleRepo.findOne({ where: { key: roleKey } });
  if (!role) {
    throw new RoleNotSeededError(
      `Role "${roleKey}" does not exist in this Company's database — the role catalog must be seeded (company-role-seeding.ts) before a Membership can grant it.`,
    );
  }
  const userRoleRepo = dataSource.getRepository(UserRole);
  const existing = await userRoleRepo.findOne({ where: { userId, roleId: role.id } });
  if (existing) return; // idempotent — a repeat grant of the same role is a no-op, not a duplicate row
  await userRoleRepo.save(userRoleRepo.create({ userId, roleId: role.id }));
}

/** Reverse of `provisionUserRoleForMembership` — removes the Company-DB `UserRole` grant a revoked `Membership` provisioned. A missing role/grant is not an error (nothing to remove). */
export async function deprovisionUserRoleForMembership(dataSource: CompanyConnection, userId: string, roleKey: string): Promise<void> {
  const roleRepo = dataSource.getRepository(Role);
  const role = await roleRepo.findOne({ where: { key: roleKey } });
  if (!role) return;
  const userRoleRepo = dataSource.getRepository(UserRole);
  await userRoleRepo.delete({ userId, roleId: role.id });
}
