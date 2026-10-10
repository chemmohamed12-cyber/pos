// Probe config = the REAL unit-mode config with only the spec location replaced, so the probe exercises exactly what unit specs get.
const base = require('../../../jest.unit.config.js');
const path = require('path');
module.exports = {
  ...base,
  rootDir: path.join(__dirname, '..', '..', '..', 'src'),
  roots: [__dirname],
  testMatch: [path.join(__dirname, 'probe.spec.js').split('\\').join('/')],
  transform: {},
};
