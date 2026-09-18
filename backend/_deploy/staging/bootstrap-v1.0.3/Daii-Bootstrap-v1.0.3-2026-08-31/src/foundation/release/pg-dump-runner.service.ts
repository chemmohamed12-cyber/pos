import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AppConfigService, DatabaseConfig } from '../configuration/app-config.service';

const execFileAsync = promisify(execFile);

/** 10 minutes — generous for this project's current data volume (confirmed small in every prior live check this session — tens of rows per table); revisit if the real catalog grows enough to need a longer ceiling. */
const DUMP_TIMEOUT_MS = 10 * 60 * 1000;
const RESTORE_LIST_TIMEOUT_MS = 60 * 1000;
const RESTORE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Release Center — Phase A (Backup Foundation). The ONLY place in this
 * codebase that shells out to an external binary — confirmed via a full
 * repo search that no `child_process` precedent existed before this.
 * Deliberately isolated in its own tiny service (not inlined into
 * `BackupManagerService`) so it's independently mockable in tests and
 * reusable by the Restore Manager in a later phase.
 *
 * SECURITY: always `execFile` with an argument ARRAY, never `exec` with a
 * shell string — no argument here is ever concatenated into a command
 * string, so there is no shell-injection surface regardless of what a
 * database/user/host value contains. The password is passed via the
 * `PGPASSWORD` environment variable (the standard libpq mechanism), never
 * as a CLI argument — CLI arguments are visible to any other process on
 * the same host via `ps`/`/proc`, environment variables passed to a
 * specific child process are not exposed the same way.
 */
@Injectable()
export class PgDumpRunnerService {
  private readonly logger = new Logger(PgDumpRunnerService.name);

  constructor(private readonly config: AppConfigService) {}

  /**
   * Runs `pg_dump` in custom format (`-Fc`) directly to `outputFilePath` —
   * pg_dump writes the file itself; this process never buffers the dump
   * content in memory, which matters since a production dump could be
   * arbitrarily large.
   */
  async dump(db: DatabaseConfig, outputFilePath: string): Promise<void> {
    const { pgDumpBin } = this.config.releaseBackup;
    const args = ['-h', db.host, '-p', String(db.port), '-U', db.username, '-Fc', '-f', outputFilePath, db.database];
    try {
      await execFileAsync(pgDumpBin, args, {
        env: { ...process.env, PGPASSWORD: db.password },
        timeout: DUMP_TIMEOUT_MS,
      });
    } catch (err) {
      this.logger.error(`pg_dump failed for database "${db.database}"`, err instanceof Error ? err.stack : String(err));
      throw new Error(`pg_dump failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Read-only structural check — `pg_restore --list` parses the dump's
   * table-of-contents without ever connecting to any database or writing
   * anything. This is the "controlled restore verification mechanism"
   * `BackupManagerService.verifyBackup` uses to confirm a dump is more
   * than just a same-sized file — real proof the archive is internally
   * well-formed, without the cost/risk of a real restore.
   */
  async verifyDumpStructure(filePath: string): Promise<boolean> {
    const { pgRestoreBin } = this.config.releaseBackup;
    try {
      const { stdout } = await execFileAsync(pgRestoreBin, ['--list', filePath], { timeout: RESTORE_LIST_TIMEOUT_MS });
      return stdout.trim().length > 0;
    } catch (err) {
      this.logger.warn(`pg_restore --list failed for "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Release Center — Phase B (Restore). `--clean --if-exists` drops each
   * object before recreating it (the standard, documented way to restore
   * a custom-format dump ON TOP of an existing database with the same
   * schema, rather than requiring a pre-emptied target) — never `DROP
   * DATABASE`/`CREATE DATABASE`, so the connection/role/grants on the
   * target database are untouched. Same argument-array + `PGPASSWORD`-via-
   * env discipline as `dump()`. Callers MUST take their own safety backup
   * before calling this — this method has no opinion about that, it only
   * runs the restore itself (see `RestoreManagerService.confirmAndRestore`).
   */
  async restore(db: DatabaseConfig, dumpFilePath: string): Promise<void> {
    const { pgRestoreBin } = this.config.releaseBackup;
    const args = ['-h', db.host, '-p', String(db.port), '-U', db.username, '-d', db.database, '--clean', '--if-exists', dumpFilePath];
    try {
      await execFileAsync(pgRestoreBin, args, {
        env: { ...process.env, PGPASSWORD: db.password },
        timeout: RESTORE_TIMEOUT_MS,
      });
    } catch (err) {
      this.logger.error(`pg_restore failed for database "${db.database}"`, err instanceof Error ? err.stack : String(err));
      throw new Error(`pg_restore failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
