/**
 * Database-free unit mode — `npm run test:unit`. Runs ONLY the reviewed list in tools/testing/unit-specs.txt.
 * It has no globalSetup and needs no database; instead every connection / listener / child process / DB driver /
 * AppModule load is a hard error (tools/testing/unit-mode-setup.js + the moduleNameMapper below).
 * The DB-backed configuration (jest.config.js) is unchanged and stays fail-closed under the DB guard.
 */
const fs = require('fs');
const path = require('path');

const list = fs
  .readFileSync(path.join(__dirname, 'tools', 'testing', 'unit-specs.txt'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const BLOCKED = '<rootDir>/../tools/testing/unit-mode-blocked.js';

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  // exact files only: a spec that is not in the reviewed list can never run in this mode
  testRegex: undefined,
  testMatch: list.map((rel) => `<rootDir>/${rel.replace(/^src\//, '')}`),
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/../tools/testing/unit-mode-setup.js'],
  transformIgnorePatterns: ['/node_modules/', '/tools/testing/unit-mode-'],
  moduleNameMapper: {
    // database drivers: only `pg` is used by the project; anything else is refused as well
    '^(pg|pg-native|pg-pool|postgres|pg-promise|mysql2?|mariadb|sqlite3|better-sqlite3|mssql|oracledb|mongodb|slonik|knex)$': BLOCKED,
    '(^|/)node_modules/(pg|pg-native|pg-pool|postgres|pg-promise|mysql2?|mariadb|sqlite3|better-sqlite3|mssql|oracledb|mongodb|slonik|knex)(/.*)?$': BLOCKED,
    // the full application and every database-backed harness / data source
    '(^|/)app\\.module$': BLOCKED,
    '(^|/)(two-company-real-pg-harness|ambient-test-datasource|saas-characterization\\.helpers|saas-provisioning-kit|company-pool-worker)$': BLOCKED,
    '(^|/)database/(data-source|database\\.module)$': BLOCKED,
  },
};
