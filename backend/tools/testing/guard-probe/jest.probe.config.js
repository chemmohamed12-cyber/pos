// Proves the guard layers work INSIDE jest's module registry (setupFiles only, no globalSetup). Targets a CLOSED port, so a guard
// failure would show as ECONNREFUSED, never as a connection to a real database. Run: npm run test:db-guard:jest-probe
const path = require('path');
module.exports = {
  rootDir: __dirname,
  testRegex: 'probe\.spec\.js$',
  testEnvironment: 'node',
  setupFiles: [path.join(__dirname, '..', 'jest-db-guard-setup.js')],
  transformIgnorePatterns: ['/node_modules/', '/tools/testing/'],
};
