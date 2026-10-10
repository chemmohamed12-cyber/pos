'use strict';
// Side-effect entry point: `node -r ./tools/testing/db-guard-register.js …`, or `require('…/db-guard-register')` as the very first
// statement of a test tool. Installs every guard layer (pg.Client/Pool/TypeORM, pg.native block, libpq CLI check, children inherit it).
// It is also injected into NODE_OPTIONS of every Node child a guarded process spawns, so workers cannot escape the guard.
require('./db-guard-process').installAll();
