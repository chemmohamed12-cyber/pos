import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { DaiiException } from './daii-exception';

/**
 * The invariant that matters per CTO Execution Policy §5: every error
 * shape resolves to the same canonical envelope, and an unexpected
 * error never leaks its raw message/stack to the client.
 */
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jsonMock = jest.fn();
    statusMock = jest.fn(() => ({ json: jsonMock }));
    const response = { status: statusMock };
    const request = { correlationId: 'corr-123' };
    host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as unknown as ArgumentsHost;
  });

  it('formats a DaiiException with its own canonical code and status', () => {
    filter.catch(new DaiiException('SALES_ORDER_NOT_FOUND', 'Not found.', HttpStatus.NOT_FOUND), host);
    expect(statusMock).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(jsonMock).toHaveBeenCalledWith({
      success: false,
      error: { code: 'SALES_ORDER_NOT_FOUND', message: 'Not found.', details: undefined },
      meta: { correlationId: 'corr-123' },
    });
  });

  it('maps a standard NestJS HttpException to a canonical code by status', () => {
    filter.catch(new NotFoundException('User not found'), host);
    expect(statusMock).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const body = jsonMock.mock.calls[0][0];
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.meta.correlationId).toBe('corr-123');
  });

  it('never leaks a raw unexpected error message to the client', () => {
    filter.catch(new Error('leaked-db-connection-string-or-stack-trace'), host);
    expect(statusMock).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = jsonMock.mock.calls[0][0];
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred.');
    expect(JSON.stringify(body)).not.toContain('leaked-db-connection-string-or-stack-trace');
  });

  it('includes the request correlationId on every response shape', () => {
    filter.catch(new Error('anything'), host);
    expect(jsonMock.mock.calls[0][0].meta.correlationId).toBe('corr-123');
  });
});
