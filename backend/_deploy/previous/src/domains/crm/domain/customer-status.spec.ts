import { canTransitionCustomerStatus } from './customer-status';

describe('canTransitionCustomerStatus', () => {
  it('allows pending -> active', () => {
    expect(canTransitionCustomerStatus('pending', 'active')).toBe(true);
  });

  it('allows active -> suspended and suspended -> active (reactivation)', () => {
    expect(canTransitionCustomerStatus('active', 'suspended')).toBe(true);
    expect(canTransitionCustomerStatus('suspended', 'active')).toBe(true);
  });

  it('rejects pending -> suspended (must go through active first)', () => {
    expect(canTransitionCustomerStatus('pending', 'suspended')).toBe(false);
  });

  it('rejects a no-op transition to the same state', () => {
    expect(canTransitionCustomerStatus('active', 'active')).toBe(false);
  });
});
