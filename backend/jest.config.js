/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
  // Test-database identity guard (M-R2 §11): default DENY — see tools/testing/db-guard.js and approved-test-databases.json.
  // the guard itself is plain CommonJS: keep ts-jest from trying to compile it
  transformIgnorePatterns: ['/node_modules/', '/tools/testing/(db-guard|jest-db-guard-)'],
  globalSetup: '<rootDir>/../tools/testing/jest-db-guard-global.js',
  setupFiles: ['<rootDir>/../tools/testing/jest-db-guard-setup.js'],
};
