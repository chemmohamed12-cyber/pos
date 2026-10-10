import { CompanyDatabaseConfigError, parseCompanyDatabasePool } from './company-database-allocator';

/**
 * Release 1.1.7 on the shared host: COMPANY_DB_POOL was entered as `["a","b","c"]` but the host's environment-variable editor delivered `[a,b,c]` (double quotes stripped), so
 * JSON.parse threw a plain Error and Company creation answered "An unexpected error occurred". The pool list must survive that, and a genuinely bad entry must be reported by name.
 */
describe('parseCompanyDatabasePool', () => {
  const names = ['xnexdrgr_daii_c01', 'xnexdrgr_daii_c02', 'xnexdrgr_daii_c03'];

  it('THE HOST VALUE: quotes stripped by the editor -> [a,b,c] parses', () => {
    expect(parseCompanyDatabasePool('[xnexdrgr_daii_c01,xnexdrgr_daii_c02,xnexdrgr_daii_c03]')).toEqual(names);
  });
  it('a proper JSON array still parses', () => {
    expect(parseCompanyDatabasePool('["xnexdrgr_daii_c01","xnexdrgr_daii_c02","xnexdrgr_daii_c03"]')).toEqual(names);
  });
  it('plain comma list, spaces/semicolons/newlines, stray quotes, duplicates', () => {
    expect(parseCompanyDatabasePool('xnexdrgr_daii_c01,xnexdrgr_daii_c02, xnexdrgr_daii_c03')).toEqual(names);
    expect(parseCompanyDatabasePool(' xnexdrgr_daii_c01 ; xnexdrgr_daii_c02\n xnexdrgr_daii_c03 ')).toEqual(names);
    expect(parseCompanyDatabasePool(`['xnexdrgr_daii_c01',"xnexdrgr_daii_c02",xnexdrgr_daii_c03]`)).toEqual(names);
    expect(parseCompanyDatabasePool('a,a,b')).toEqual(['a', 'b']);
  });
  it('empty / unset => empty pool (the caller reports it as exhausted with the instructions)', () => {
    expect(parseCompanyDatabasePool(undefined)).toEqual([]);
    expect(parseCompanyDatabasePool('')).toEqual([]);
    expect(parseCompanyDatabasePool('   ')).toEqual([]);
    expect(parseCompanyDatabasePool('[]')).toEqual([]);
  });
  it('an entry that is not a plain database identifier is refused BY NAME as a classified error (no SQL-ish names ever reach a connection)', () => {
    for (const bad of ['a/b', 'db-name', 'x'.repeat(64), 'ünï', '[1,2]']) {
      const run = () => parseCompanyDatabasePool(bad.startsWith('[') ? bad : `ok_one,${bad}`);
      expect(run).toThrow(CompanyDatabaseConfigError);
    }
    try { parseCompanyDatabasePool('ok_one,db-name'); } catch (e) { expect((e as Error).message).toContain('"db-name"'); expect((e as CompanyDatabaseConfigError).code).toBe('COMPANY_DB_POOL_INVALID'); }
  });
  it('JSON that is not a list is refused', () => {
    expect(() => parseCompanyDatabasePool('{"a":1}')).toThrow(CompanyDatabaseConfigError);
  });
});
