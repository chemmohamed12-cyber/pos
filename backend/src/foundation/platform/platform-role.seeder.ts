import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PLATFORM_NODE_KEYS, PLATFORM_ROLES } from './platform-nodes';

/**
 * Authorization Foundation F4 — seeds the four platform roles (and the compatibility grants of the legacy ambient `admin`) into the CONTROL-PLANE `roles` /
 * `role_permissions` tables. Idempotent and additive: it never removes a grant, never touches a role it did not create (except to ADD platform nodes to the
 * legacy `admin`, which is the Super Admin alias), and — because it runs on the ambient DataSource only — it can never write into a Company database.
 *
 * It is a boot seeder (like `ModuleRoleTemplateSeeder`) rather than a `core` migration on purpose: `core` migrations also run on every Company database, and the
 * platform roles must never appear in a Company's role catalog.
 */
@Injectable()
export class PlatformRoleSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformRoleSeeder.name);

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const r = await this.seed();
      this.logger.log(`platform roles: +${r.roles} role(s), +${r.grants} grant(s)`);
    } catch (err) {
      // Never block boot: the guard still honours the legacy `admin` alias, and the seed retries on the next boot.
      this.logger.warn(`platform roles seed skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async seed(): Promise<{ roles: number; grants: number }> {
    let roles = 0;
    let grants = 0;
    await this.dataSource.transaction(async (m) => {
      const upsertGrant = async (roleId: string, node: string, access: string): Promise<void> => {
        const res = await m.query(
          `INSERT INTO "role_permissions" ("roleId", "nodeKey", "access") VALUES ($1, $2, $3) ON CONFLICT ("roleId", "nodeKey") DO NOTHING RETURNING "id"`,
          [roleId, node, access],
        );
        if (res.length) grants++;
      };
      for (const def of PLATFORM_ROLES) {
        const existing = await m.query(`SELECT "id" FROM "roles" WHERE "key" = $1`, [def.key]);
        let roleId: string;
        if (existing.length) roleId = existing[0].id;
        else {
          const [row] = await m.query(
            `INSERT INTO "roles" ("key", "type", "nameEn", "nameAr", "descriptionEn", "descriptionAr") VALUES ($1, 'system', $2, $3, $4, $5) RETURNING "id"`,
            [def.key, def.nameEn, def.nameAr, def.descriptionEn, def.descriptionAr],
          );
          roleId = row.id;
          roles++;
        }
        for (const g of def.grants) await upsertGrant(roleId, g.node, g.access);
      }
      // Compatibility: today's single platform super-user keeps everything and gains every platform node (no ability loss; retired with the alias in F5).
      const admin = await m.query(`SELECT "id" FROM "roles" WHERE "key" = 'admin'`);
      if (admin.length) for (const node of PLATFORM_NODE_KEYS) await upsertGrant(admin[0].id, node, node.endsWith('.view') ? 'read-only' : 'editable');
    });
    return { roles, grants };
  }
}
