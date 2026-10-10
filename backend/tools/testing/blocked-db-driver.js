'use strict';
// jest moduleNameMapper target for any database driver other than `pg`. Loading one is refused: the DB guard only covers `pg`.
throw new Error('DB guard: this database driver is not covered by the DB guard; use pg (TypeORM type "postgres") or extend the guard first.');
