/**
 * The ONE business-date convention for "which calendar day is this instant on" in the
 * Financial/Subledger path: the **UTC calendar day**.
 *
 * Why UTC (and not the DB session timezone, `Africa/Cairo`, UTC+3):
 *  - The GL side stamps `businessDate` with the UTC date by default (`FinancialEventService`) and
 *    every reconciliation defaults its `asOfDate` to the UTC date.
 *  - Subledgers store a `timestamptz` instant. Comparing it with a bare `($1::date + INTERVAL '1 day')`
 *    lets Postgres cast the date using the SESSION timezone, so between 00:00 and 03:00 Cairo
 *    (= 21:00-24:00 UTC of the previous day) a subledger row lands on a different calendar day than
 *    its GL journal -> phantom reconciliation drift. Same defect class as the Commission UTC
 *    day-boundary fix.
 *
 * Moving the whole business date to a Company timezone is a separate, deliberate decision (it would
 * change what `businessDate` GL postings are stamped with); until then both sides use this one rule.
 */

/** UTC calendar date (`YYYY-MM-DD`) of `now`. `now` is injectable so the clock can be pinned in tests. */
export function utcBusinessDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * SQL fragment: the exclusive upper bound `timestamptz` of the UTC calendar day `<dateParam>`, i.e.
 * the instant 00:00:00Z of the next day. Use as `"someTimestamptz" < ${utcDayEndExclusiveSql('$1')}`.
 * Independent of the DB session timezone. `dateParam` must be a trusted positional placeholder
 * (`$1`), never user input.
 */
export function utcDayEndExclusiveSql(dateParam: string): string {
  return `((${dateParam}::date + INTERVAL '1 day') AT TIME ZONE 'UTC')`;
}
