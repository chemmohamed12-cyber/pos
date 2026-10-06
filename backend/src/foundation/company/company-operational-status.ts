import { ConflictException } from '@nestjs/common';
import { CompanyStatus } from './company-status';

/**
 * WP-4.1 (DP-9 Layer 1, CTO order 2026-10-06). V1 operational condition:
 * `Company.status === 'READY'` (DP-9 O-4) — every other status
 * (PROVISIONING, DEGRADED, SUSPENDED, MIGRATING, FAILED, DECOMMISSIONED)
 * disallows Company operational access, whether or not the Company's
 * database is reachable. `Company.status` is the ONLY lifecycle authority;
 * the registry's own status stays DB/connection health (DP-9 D-7).
 */
export const COMPANY_NOT_READY_CODE = 'COMPANY_NOT_READY';

export function isCompanyOperational(status: CompanyStatus): boolean {
  return status === 'READY';
}

/**
 * DP-9 O-2: HTTP 409 Conflict with the stable code `COMPANY_NOT_READY`.
 * Deliberately carries NO Company status, no registry/database detail and
 * no other-Company data — the client only learns "unavailable".
 */
export class CompanyNotReadyException extends ConflictException {
  constructor() {
    super({ statusCode: 409, error: 'Conflict', code: COMPANY_NOT_READY_CODE, message: 'This Company is currently unavailable.' });
  }
}
