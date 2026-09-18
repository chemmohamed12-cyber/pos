import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * F01 — Financial Foundation (Blueprint §2/§3.3/§3.4). Reuses
 * `foundation/process-engine` rather than a hand-rolled status enum —
 * same convention as Sales Order. Neither `FiscalYear` nor `FiscalPeriod`
 * stores its own `status` column; the live state is always read via
 * `ProcessEngineService.getState(...)`, matching `SalesOrder`'s own
 * convention of never denormalizing process state onto the entity.
 */
export const FISCAL_YEAR_PROCESS: ProcessDefinition = {
  key: 'accounting_fiscal_year',
  initialState: 'planned',
  transitions: [
    { from: 'planned', to: 'active', action: 'activate' },
    { from: 'active', to: 'closed', action: 'close' },
  ],
};

/**
 * F01 defines the states and legal transitions only. F13 defines who may
 * fire `reopen` and under what approval (the Generic Approval Engine,
 * ADR-033) — that policy is explicitly out of scope here (Blueprint §12).
 */
export const FISCAL_PERIOD_PROCESS: ProcessDefinition = {
  key: 'accounting_fiscal_period',
  initialState: 'open',
  transitions: [
    { from: 'open', to: 'soft_close', action: 'soft_close' },
    { from: 'soft_close', to: 'open', action: 'reopen_from_soft_close' },
    { from: 'soft_close', to: 'closed', action: 'close' },
    { from: 'closed', to: 'reopened', action: 'reopen' },
    { from: 'reopened', to: 'closed', action: 'close_after_reopen' },
  ],
};

export const FISCAL_YEAR_ENTITY_TYPE = 'FiscalYear';
export const FISCAL_PERIOD_ENTITY_TYPE = 'FiscalPeriod';
