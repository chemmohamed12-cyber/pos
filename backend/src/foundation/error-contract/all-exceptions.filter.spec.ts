import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { EntityNotFoundError } from 'typeorm';
import { AllExceptionsFilter } from './all-exceptions.filter';

class Customer {}

function run(exception: unknown) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ correlationId: 'corr-1' }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status: status.mock.calls[0][0] as number, body: json.mock.calls[0][0] as { success: boolean; error: { code: string; message: string; details?: unknown } } };
}

describe('AllExceptionsFilter — missing / inaccessible records', () => {
  it('maps a TypeORM EntityNotFoundError (e.g. another Company\'s record id) to a non-disclosing 404', () => {
    const { status, body } = run(new EntityNotFoundError(Customer, { where: { id: '4bbf21b8-b330-4cc8-b873-d4bb98485065' } }));
    expect(status).toBe(404);
    expect(body).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Not Found', details: undefined }, meta: { correlationId: 'corr-1' } });
    // nothing about the entity, the lookup criteria or the id reaches the client
    const text = JSON.stringify(body);
    expect(text).not.toContain('Customer');
    expect(text).not.toContain('4bbf21b8');
    expect(text).not.toContain('where');
  });

  it('keeps an explicit NotFoundException a 404 as before', () => {
    expect(run(new NotFoundException('Company not found: x')).status).toBe(404);
  });

  it('still returns a generic 500 for a genuinely unexpected error, leaking nothing', () => {
    const { status, body } = run(new Error('relation "secret_table" does not exist'));
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', details: undefined });
  });
});
