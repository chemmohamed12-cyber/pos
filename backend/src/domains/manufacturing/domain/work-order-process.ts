import { ProcessDefinition } from '../../../foundation/process-engine/process-definition';

/**
 * ADR-061 §3 — Work Order lifecycle:
 *   draft -> released -> in_progress -> completed
 *   draft -> cancelled
 *   released -> cancelled   [only if zero material has been issued — service-level guard]
 *   in_progress -> on_hold -> in_progress
 * No `reopen` transition — a completed Work Order is closed permanently.
 * `in_progress` is entered automatically on the FIRST Material Issue
 * (action `begin_production`), not a separately user-triggered transition.
 */
export const WORK_ORDER_PROCESS: ProcessDefinition = {
  key: 'manufacturing_work_order',
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'released', action: 'release' },
    { from: 'draft', to: 'cancelled', action: 'cancel' },
    { from: 'released', to: 'cancelled', action: 'cancel' },
    { from: 'released', to: 'in_progress', action: 'begin_production' },
    { from: 'in_progress', to: 'on_hold', action: 'hold' },
    { from: 'on_hold', to: 'in_progress', action: 'resume' },
    { from: 'in_progress', to: 'completed', action: 'complete' },
  ],
};

export const WORK_ORDER_ENTITY_TYPE = 'WorkOrder';
