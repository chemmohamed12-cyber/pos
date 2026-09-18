import { HttpStatus } from '@nestjs/common';
import { httpStatusToCode } from './http-status-to-code';

describe('httpStatusToCode', () => {
  it('maps known statuses to their canonical codes', () => {
    expect(httpStatusToCode(HttpStatus.BAD_REQUEST)).toBe('VALIDATION_ERROR');
    expect(httpStatusToCode(HttpStatus.UNAUTHORIZED)).toBe('UNAUTHORIZED');
    expect(httpStatusToCode(HttpStatus.FORBIDDEN)).toBe('FORBIDDEN');
    expect(httpStatusToCode(HttpStatus.NOT_FOUND)).toBe('NOT_FOUND');
    expect(httpStatusToCode(HttpStatus.CONFLICT)).toBe('CONFLICT');
  });

  it('falls back to INTERNAL_ERROR for unknown 5xx and REQUEST_ERROR for unknown 4xx', () => {
    expect(httpStatusToCode(503)).toBe('INTERNAL_ERROR');
    expect(httpStatusToCode(418)).toBe('REQUEST_ERROR');
  });
});
