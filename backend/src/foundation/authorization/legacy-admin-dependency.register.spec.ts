import * as fs from 'fs';
import * as path from 'path';

/**
 * CTO Decision 2 (2026-10-07) — the legacy `admin` role key is a TRANSITIONAL ALIAS on its way to retirement (Map -> Dual-check -> Migrate -> Retire). It must never
 * become `company_admin`, and NO NEW authorization dependency on it may be added.
 *
 * This is the register of every production reference to the `admin` role key as of Foundation closure. It is a CEILING, not a target: a file may keep fewer references,
 * never more, and a file that is not listed may have none. Retirement (a later, separately authorized step) removes entries until the register is empty — only after
 * zero remaining authorization dependencies are proven. Platform plane (`PlatformGuard`, `AdminController`, register) and the menu entries of the platform tools keep
 * the alias by design (see the F5 report, residual 2); `integrations` (15) waits for F4-B; `media` for AZ-14.
 */
const RE = /hasRole\('admin'\)|RequireRole\([^)]*'admin'|includes\('admin'\)|=== 'admin'|!== 'admin'|\['admin'|'admin'\]|ADMIN_ROLE_KEY\b|key: 'admin'|roleKey: 'admin'/g;

const REGISTER: Record<string, number> = {
  'domains/crm/application/customers.service.ts': 1,
  'domains/sales-orders/application/sales-orders.service.ts': 2,
  'domains/treasury/interface/treasury.controller.ts': 1,
  'foundation/admin/admin.controller.ts': 2,
  'foundation/authentication/auth-me.service.ts': 3,
  'foundation/authentication/auth.controller.ts': 1,
  'foundation/authorization/role-classification.ts': 1,
  'foundation/authorization/roles.guard.ts': 1,
  'foundation/authorization/workflow-access.ts': 1,
  'foundation/authorization/workflow-rules.ts': 1,
  'foundation/company/company-membership-provisioning.service.ts': 6,
  'foundation/company/company-registry.controller.ts': 1,
  'foundation/company/company-role-seeding.ts': 5,
  'foundation/company/company-user-roles.ts': 1,
  'foundation/database-provisioning/database-provisioning.service.ts': 6,
  'foundation/integrations/application/connectors/qr-store.connector.ts': 1,
  'foundation/integrations/interface/integrations.controller.ts': 15,
  'foundation/media/media.controller.ts': 1,
  'foundation/module-registry/role-templates.ts': 1,
  'foundation/navigation/navigation-registry.ts': 7,
  'foundation/plans/company-package.service.ts': 1,
  'foundation/platform/platform-nodes.ts': 1,
  'foundation/platform/platform.controller.ts': 2,
  'foundation/platform/platform.guard.ts': 1,
  'foundation/release/release.controller.ts': 2,
};

function scan(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['migrations', 'testing', 'node_modules'].includes(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.ts') && !/\.spec\.ts$|test-helper|\.d\.ts$/.test(e.name)) {
        const n = (fs.readFileSync(p, 'utf8').match(RE) ?? []).length;
        if (n > 0) out[path.relative(root, p).split(path.sep).join('/')] = n;
      }
    }
  };
  walk(root);
  return out;
}

describe('Decision 2 — legacy `admin` role: no new authorization dependency', () => {
  const current = scan(path.resolve(__dirname, '../..'));

  it('no file references the `admin` role key more often than the frozen register allows, and no unlisted file references it at all', () => {
    const violations = Object.entries(current)
      .filter(([file, n]) => n > (REGISTER[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} reference(s), register allows ${REGISTER[file] ?? 0}`);
    expect(violations).toEqual([]);
  });

  it('the register only ever shrinks: a listed file that no longer references the alias must be removed from it (retirement progress is recorded)', () => {
    const stale = Object.entries(REGISTER).filter(([file, n]) => (current[file] ?? 0) < n).map(([file, n]) => `${file}: register ${n}, now ${current[file] ?? 0}`);
    expect(stale).toEqual([]);
  });

  it('`company_admin` is never derived from `admin`: no source line maps the alias onto the Company administrator', () => {
    const MAPPING = /'admin'\s*(:|=>|->)\s*['"]?company_admin|admin.{0,12}(becomes|maps to|alias of|replaced by)\s+`?company_admin/i;
    const offenders = Object.keys(current).filter((f) => fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8').split(/\r?\n/).some((l) => MAPPING.test(l)));
    expect(offenders).toEqual([]);
  });
});
