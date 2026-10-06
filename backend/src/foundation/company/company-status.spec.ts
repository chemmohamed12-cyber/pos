import { COMPANY_STATUSES, CompanyStatus, isCompanyVisible, isValidCompanyTransition } from './company-status';

describe('company-status', () => {
  describe('isValidCompanyTransition — V7 chain + reactivation: PROVISIONING → READY ⇄ {DEGRADED,SUSPENDED,MIGRATING,FAILED} → DECOMMISSIONED', () => {
    it('allows PROVISIONING -> READY', () => {
      expect(isValidCompanyTransition('PROVISIONING', 'READY')).toBe(true);
    });

    it.each(['DEGRADED', 'SUSPENDED', 'MIGRATING', 'FAILED'] as const)('allows READY -> %s', (to) => {
      expect(isValidCompanyTransition('READY', to)).toBe(true);
    });

    it.each(['DEGRADED', 'SUSPENDED', 'MIGRATING', 'FAILED'] as const)('allows %s -> DECOMMISSIONED', (from) => {
      expect(isValidCompanyTransition(from, 'DECOMMISSIONED')).toBe(true);
    });

    it('rejects DECOMMISSIONED -> anything (terminal state)', () => {
      for (const to of COMPANY_STATUSES) {
        expect(isValidCompanyTransition('DECOMMISSIONED', to)).toBe(false);
      }
    });

    it('rejects PROVISIONING -> anything other than READY', () => {
      for (const to of COMPANY_STATUSES.filter((s) => s !== 'READY' && s !== 'PROVISIONING')) {
        expect(isValidCompanyTransition('PROVISIONING', to)).toBe(false);
      }
    });

    it.each(['DEGRADED', 'SUSPENDED', 'MIGRATING', 'FAILED'] as const)(
      'allows %s -> READY (reactivation — Area 2/19 decision, 2026-09-22)',
      (from) => {
        expect(isValidCompanyTransition(from, 'READY')).toBe(true);
      },
    );

    it('rejects READY -> DECOMMISSIONED directly (chain requires an intermediate state)', () => {
      expect(isValidCompanyTransition('READY', 'DECOMMISSIONED')).toBe(false);
    });

    it('rejects a self-transition for every status', () => {
      for (const status of COMPANY_STATUSES) {
        expect(isValidCompanyTransition(status, status)).toBe(false);
      }
    });
  });

  describe('isCompanyVisible — "a company is never visible to end users before READY"', () => {
    it('hides PROVISIONING', () => {
      expect(isCompanyVisible('PROVISIONING')).toBe(false);
    });

    it.each(['READY', 'DEGRADED', 'SUSPENDED', 'MIGRATING', 'FAILED', 'DECOMMISSIONED'] as CompanyStatus[])(
      'shows %s',
      (status) => {
        expect(isCompanyVisible(status)).toBe(true);
      },
    );
  });
});
