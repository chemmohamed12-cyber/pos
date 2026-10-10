import { utcBusinessDate, utcDayEndExclusiveSql } from './business-date';

describe('business-date (UTC business-day convention)', () => {
  // 2026-10-06T23:57:33Z == 2026-10-07 02:57:33 Africa/Cairo (UTC+3): the instant the latent
  // grni-posting.spec / AP reconciliation false drift was observed.
  const CAIRO_WINDOW = new Date('2026-10-06T23:57:33Z');

  it('derives the UTC calendar date, not the local (Cairo) one, inside the 00:00-03:00 Cairo window', () => {
    expect(utcBusinessDate(CAIRO_WINDOW)).toBe('2026-10-06');
    // The Cairo calendar day for the same instant is the NEXT day — the two conventions differ here, which is
    // exactly why the GL default and the subledger filter must share one source.
    expect(CAIRO_WINDOW.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' })).toBe('2026-10-07');
  });

  it('is identical to the legacy new Date().toISOString().slice(0,10) outside the window', () => {
    for (const iso of ['2026-10-07T00:00:00Z', '2026-10-07T12:00:00Z', '2026-10-07T20:59:59Z', '2026-12-31T21:00:00Z']) {
      const d = new Date(iso);
      expect(utcBusinessDate(d)).toBe(d.toISOString().slice(0, 10));
    }
  });

  it('defaults to the (fake-timer-pinned) current clock', () => {
    jest.useFakeTimers({ now: CAIRO_WINDOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval'] });
    try {
      expect(utcBusinessDate()).toBe('2026-10-06');
    } finally {
      jest.useRealTimers();
    }
  });

  it('builds a session-timezone-independent exclusive day-end bound', () => {
    expect(utcDayEndExclusiveSql('$1')).toBe(`(($1::date + INTERVAL '1 day') AT TIME ZONE 'UTC')`);
  });
});
