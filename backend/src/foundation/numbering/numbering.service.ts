import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { runInTransaction } from '../transaction/run-in-transaction';

interface SequenceRow {
  documentType: string;
  prefix: string;
  includeYear: boolean;
  lastNumber: number;
  lastYear: number | null;
}

/**
 * Numbering Engine — Stage 2 build-order item 17.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §12.
 *
 * Issuance is transactional with a row lock (`SELECT ... FOR UPDATE`) on
 * the sequence row — two concurrent callers for the same document type
 * cannot receive the same number, closing the concurrency gap `baseline`'s
 * free-standing counter never had a guarantee against.
 */
@Injectable()
export class NumberingService {
  constructor(private readonly dataSource: DataSource) {}

  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added — same additive shape as `getNextNumber` below, needed by any Company-scoped caller that registers a per-rep/per-entity document type on the fly (e.g. `SalesOrdersService.createOrder`'s `sales_order_rep_<id>` type). */
  async registerDocumentType(documentType: string, prefix: string, includeYear = true, manager?: EntityManager): Promise<void> {
    // N-01 (concurrent first use): one atomic statement instead of find-then-save — concurrent callers of a not-yet-registered type no longer collide on the primary key (23505); idempotent as before.
    await (manager ?? this.dataSource).query(
      'INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear", "lastNumber", "lastYear") VALUES ($1, $2, $3, 0, NULL) ON CONFLICT ("documentType") DO NOTHING',
      [documentType, prefix, includeYear],
    );
  }

  /**
   * Issue the next number for `documentType`.
   *
   * Accepts an optional external `manager` — same additive pattern as
   * `AuditService.record(input, manager?)` and `LimitService.consume(key,
   * delta, manager?)`: a caller that already holds its own open
   * transaction (e.g. F03's journal-posting gate) passes it so the number
   * is drawn INSIDE that transaction and released on rollback — no
   * permanent gap in the sequence when the surrounding operation aborts
   * after the number was drawn. Without a supplied `manager`, opens its
   * own transaction (every existing caller — `CustomersService`,
   * `InvoicesService`, … — is unchanged).
   */
  async getNextNumber(documentType: string, manager?: EntityManager): Promise<string> {
    const run = async (m: EntityManager): Promise<string> => {
      const rows: SequenceRow[] = await m.query(
        'SELECT * FROM numbering_sequences WHERE "documentType" = $1 FOR UPDATE',
        [documentType],
      );
      if (rows.length === 0) {
        throw new NotFoundException(`No numbering sequence registered for document type "${documentType}".`);
      }
      const seq = rows[0];
      const currentYear = new Date().getFullYear();

      let nextNumber: number;
      let yearToUse: number;
      if (seq.includeYear && seq.lastYear !== currentYear) {
        nextNumber = 1; // year rollover resets the running count
        yearToUse = currentYear;
      } else {
        nextNumber = seq.lastNumber + 1;
        yearToUse = seq.lastYear ?? currentYear;
      }

      await m.query(
        'UPDATE numbering_sequences SET "lastNumber" = $1, "lastYear" = $2, "updatedAt" = now() WHERE "documentType" = $3',
        [nextNumber, yearToUse, documentType],
      );

      const padded = String(nextNumber).padStart(6, '0');
      return seq.includeYear ? `${seq.prefix}-${yearToUse}-${padded}` : `${seq.prefix}-${padded}`;
    };
    // N-01: the FOR UPDATE row lock must outlive the read-modify-write — join an active caller transaction, otherwise open one (a plain manager would release the lock at once)
    return runInTransaction(this.dataSource, manager, run);
  }

  /**
   * What the next number WOULD be, without issuing it (no lock, no counter change) — for a form that shows the default code. `ahead` looks further
   * (0 = the next number, 1 = the one after …) so a caller can step over numbers a hand-typed code already took. `null` when no sequence is registered.
   * It is only a preview: the number is really issued by `getNextNumber`, which is what makes a code unique.
   */
  async peekNextNumber(documentType: string, ahead = 0, manager?: EntityManager): Promise<string | null> {
    const rows: SequenceRow[] = await (manager ?? this.dataSource).query('SELECT * FROM numbering_sequences WHERE "documentType" = $1', [documentType]);
    if (rows.length === 0) return null;
    const seq = rows[0];
    const currentYear = new Date().getFullYear();
    const rollover = seq.includeYear && seq.lastYear !== currentYear;
    const next = (rollover ? 1 : seq.lastNumber + 1) + ahead;
    const year = rollover ? currentYear : (seq.lastYear ?? currentYear);
    const padded = String(next).padStart(6, '0');
    return seq.includeYear ? `${seq.prefix}-${year}-${padded}` : `${seq.prefix}-${padded}`;
  }

  /**
   * The TD-29 fix: cross-checks the registry against an externally-known
   * maximum (e.g. after a bulk import or a restore that bypassed normal
   * issuance) and bumps the counter forward if the registry undercounts.
   * Never moves the counter backward — that would risk reissuing a
   * number already in use, exactly the defect this method exists to
   * prevent.
   */
  async reconcileAgainstObservedMax(documentType: string, observedMaxNumber: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        'UPDATE numbering_sequences SET "lastNumber" = GREATEST("lastNumber", $1) WHERE "documentType" = $2',
        [observedMaxNumber, documentType],
      );
    });
  }
}
