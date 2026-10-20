import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';

/**
 * T2 transitional restriction on the generic cash-in / cash-out endpoints (no DB): a customer / sales-order label is refused (it would settle nothing), and a purpose
 * (reason) + a supporting reference are mandatory. The refusal happens BEFORE the idempotency wrapper or the Treasury service is touched.
 */
describe('TreasuryController — generic cash entry restrictions', () => {
  const idempotency = { withIdempotencyInTransaction: jest.fn() };
  const treasury = { cashInDirect: jest.fn(), cashOutDirect: jest.fn() };
  const events = { dispatchAfterCommit: jest.fn() };
  const controller = new TreasuryController(treasury as never, idempotency as never, events as never);
  const req = { user: { id: 'u1' }, companyContext: { dataSource: { manager: {} } } } as never;
  const base = { accountId: '11111111-1111-1111-1111-111111111111', amount: '10.00', reason: 'Petty cash top-up', reference: 'DOC-1' };

  beforeEach(() => jest.clearAllMocks());

  it.each(['cashIn', 'cashOut'] as const)('%s: a customer label is refused with 422 and nothing runs', async (m) => {
    await expect(controller[m](req, { ...base, customerId: '22222222-2222-2222-2222-222222222222' }, 'k')).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(controller[m](req, { ...base, salesOrderId: '33333333-3333-3333-3333-333333333333' }, 'k')).rejects.toThrow(/customer payment/);
    expect(idempotency.withIdempotencyInTransaction).not.toHaveBeenCalled();
  });

  it.each(['cashIn', 'cashOut'] as const)('%s: a missing/short reason or a missing reference is refused with 400', async (m) => {
    await expect(controller[m](req, { ...base, reason: undefined }, 'k')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller[m](req, { ...base, reason: 'ab' }, 'k')).rejects.toThrow(/purpose/);
    await expect(controller[m](req, { ...base, reference: '  ' }, 'k')).rejects.toThrow(/reference/);
    expect(idempotency.withIdempotencyInTransaction).not.toHaveBeenCalled();
  });

  it('a compliant request goes through the idempotency wrapper', async () => {
    idempotency.withIdempotencyInTransaction.mockResolvedValue({ id: 'txn' });
    await expect(controller.cashIn(req, base, 'k')).resolves.toEqual({ id: 'txn' });
    expect(idempotency.withIdempotencyInTransaction).toHaveBeenCalledWith('treasury.cash-in', 'k', expect.any(Function), expect.anything());
  });
});
