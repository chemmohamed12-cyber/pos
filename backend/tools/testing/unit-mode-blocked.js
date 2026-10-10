'use strict';
// jest.unit.config.js maps database drivers, AppModule, the real-PG harnesses and the TypeORM CLI data source to this file.
throw new Error('DAII unit mode (database-free): loading a database driver, AppModule, a real-PG harness or the TypeORM data source is not allowed. Run this spec under the DB guard (npm test) with an approved database.');
