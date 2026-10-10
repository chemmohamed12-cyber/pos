'use strict';
// jest setupFiles — runs inside every test file's module registry BEFORE the test imports anything. Defence in depth:
// even a spec that builds its own DataSource / pg Client (disposable databases, admin connections), shells out to a libpq CLI
// or spawns a Node worker is checked per connection / per command; Node children inherit the guard via NODE_OPTIONS.
require('./db-guard-process').installAll();
