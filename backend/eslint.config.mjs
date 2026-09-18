// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Boundary-enforcement rule, adapted from XNEXUS RMS Step 30's ADR-006
 * ESLint rule (Daii/_source-audits/rms-step30/, Class C pattern extraction
 * per Daii/architecture/decisions/ADR-006-domain-boundaries.md and
 * ADR-019). Blocks the two violations Daii/architecture/DAII_DOMAIN_BOUNDARIES.md
 * and DAII_INFRASTRUCTURE_ABSTRACTION.md §1 prohibit:
 *   1. A Business Domain importing another Business Domain's internals directly.
 *   2. Any file importing a Foundation submodule's internals instead of
 *      its published contract (once Foundation contracts exist as
 *      published index barrels — enforced fully starting build-order
 *      item 19).
 *
 * KNOWN LIMITATION (disclosed, not silently trusted): `no-restricted-imports`
 * matches the literal import-specifier string, so it only catches paths
 * that spell out e.g. `domains/commerce/infrastructure/...`. A same-level
 * relative import like `../../commerce/infrastructure/product.entity`
 * does NOT contain that literal substring and is NOT caught by this rule
 * — exactly this shape of violation slipped through during the Sales
 * Orders milestone and was caught by manual review, not by this tooling.
 * A real fix needs either TypeScript path aliases (`@domains/*`) so
 * cross-domain imports are lexically distinguishable from same-domain
 * ones, or a resolved-path-aware rule (e.g. eslint-plugin-boundaries).
 * Neither is built yet — tracked as backlog, not silently assumed solved.
 */
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/domains/*/domain/**', '**/domains/*/application/**', '**/domains/*/infrastructure/**'],
              message:
                'Cross-domain internal import blocked (DAII_DOMAIN_BOUNDARIES.md: no domain leakage). Import only another domain\'s published interface/ contract.',
            },
            {
              group: ['**/foundation/*/!(index)'],
              message:
                'Foundation internal import blocked (ADR-006/ADR-019: no Shared Engine internals imported directly). Import only the Foundation module\'s published contract.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'tools/**'],
  },
);
