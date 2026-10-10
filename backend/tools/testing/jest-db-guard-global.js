'use strict';
// jest globalSetup — runs once before any worker starts. Throws → jest aborts the whole run; nothing is connected.
const guard = require('./db-guard');
module.exports = async () => {
  guard.preflight();
};
