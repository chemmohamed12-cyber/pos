'use strict';
// jest setupFiles — runs inside every test file's module registry BEFORE the test imports anything. Defence in depth:
// even a spec that builds its own DataSource / pg Client (disposable databases, admin connections) is checked per connection.
require('./db-guard').install();
