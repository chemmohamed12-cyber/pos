import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression guard for the 2026-09-21 release-candidate blocker: `v1.1.0`
 * failed the real Release Engine's own `dependencies_resolve` check on
 * the actual Hosting target (`checkDependenciesResolve`,
 * `dependency-check.ts`) because `@types/yauzl` — a TypeScript
 * type-definitions-only package (zero runtime `.js` code, by convention
 * for every `@types/*` package on npm) — was declared under
 * `dependencies` instead of `devDependencies`. A production-only
 * install (`npm ci --omit=dev`, what a real Hosting target runs)
 * correctly never installs it, so the real `yauzl` package (a genuine
 * runtime dependency, used by `package-validator.service.ts`) resolved
 * fine, but the misclassified `@types/yauzl` did not — exactly the
 * class of "declared in package.json but never actually verified against
 * a real install" gap `dependency-check.ts`'s own doc comment already
 * cites as Production Incident 2026-09-15's lesson.
 *
 * `@types/*` packages never contain runtime code — moving one to
 * `dependencies` is always a misclassification, never a deliberate
 * choice. This test fails CI the moment it happens again, rather than
 * waiting for the next real Hosting candidate-verification attempt to
 * catch it.
 */
describe('package.json dependency classification', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('has dependencies to check (sanity check that this test isn\'t silently a no-op)', () => {
    expect(Object.keys(pkg.dependencies ?? {}).length).toBeGreaterThan(5);
  });

  it('never declares an @types/* package under "dependencies" — type-definitions packages contain no runtime code and belong in devDependencies', () => {
    const misclassified = Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@types/'));
    expect(misclassified).toEqual([]);
  });
});
