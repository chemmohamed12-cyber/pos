/**
 * "What happens next on this order, and what is in the way" (UX redesign stage 4). Pure and presentational: it only reads what the order screen already loaded and MIRRORS the server's own
 * closing rules (WIP balance, tracked outcomes, routing operations, process operations) so the screen can say WHY an action is unavailable. The server remains the authority on every action.
 */
export interface NextInput {
  state: string;
  processBound: boolean;
  remaining: number;
  wipValue: number;
  openTracked: number;
  components: Array<{ quantityRequired: number; quantityIssued: number }>;
  legacyOperationsOpen: number;
  /** process-bound orders only */
  process?: { ready: string[]; running: string[]; mandatoryNotDone: string[] } | null;
}

export type NextKey = 'release' | 'issue_materials' | 'start_operation' | 'finish_running' | 'receive_outputs' | 'record_output' | 'complete' | 'resume' | 'none_done' | 'none_cancelled';

export interface Blocker {
  code: string;
  params: string[];
}

export interface NextStep {
  key: NextKey;
  params: string[];
  /** reasons the order cannot be completed yet; empty = nothing known stands in the way */
  completeBlockers: Blocker[];
}

export function nextStep(i: NextInput): NextStep {
  const completeBlockers: Blocker[] = [];
  if (Math.abs(i.wipValue) > 0.01) completeBlockers.push({ code: 'mfg2.wo.block.wip', params: [i.wipValue.toFixed(2)] });
  if (i.openTracked > 0) completeBlockers.push({ code: 'mfg2.wo.block.tracked', params: [String(i.openTracked)] });
  if (i.legacyOperationsOpen > 0) completeBlockers.push({ code: 'mfg2.wo.block.routing', params: [String(i.legacyOperationsOpen)] });
  if (i.processBound && i.process) {
    if (i.process.running.length > 0) completeBlockers.push({ code: 'mfg2.wo.block.running', params: [i.process.running.join(', ')] });
    const open = i.process.mandatoryNotDone.filter((c) => !i.process!.running.includes(c));
    if (open.length > 0) completeBlockers.push({ code: 'mfg2.wo.block.mandatory', params: [open.join(', ')] });
  }
  const issuedAll = i.components.every((c) => c.quantityIssued >= c.quantityRequired);
  switch (i.state) {
    case 'draft':
      return { key: 'release', params: [], completeBlockers };
    case 'released':
      return { key: 'issue_materials', params: [], completeBlockers };
    case 'on_hold':
      return { key: 'resume', params: [], completeBlockers };
    case 'completed':
      return { key: 'none_done', params: [], completeBlockers: [] };
    case 'cancelled':
      return { key: 'none_cancelled', params: [], completeBlockers: [] };
    default:
      break;
  }
  // in progress
  if (i.processBound && i.process) {
    if (i.process.running.length > 0) return { key: 'finish_running', params: [i.process.running.join(', ')], completeBlockers };
    if (!issuedAll && i.process.ready.length === 0 && i.remaining > 0) return { key: 'issue_materials', params: [], completeBlockers };
    if (i.process.ready.length > 0 && i.process.mandatoryNotDone.length > 0) return { key: 'start_operation', params: [i.process.ready.join(', ')], completeBlockers };
    if (i.remaining > 0) return { key: 'receive_outputs', params: [String(i.remaining)], completeBlockers };
    return { key: 'complete', params: [], completeBlockers };
  }
  if (!issuedAll && i.remaining > 0) return { key: 'issue_materials', params: [], completeBlockers };
  if (i.remaining > 0) return { key: 'record_output', params: [String(i.remaining)], completeBlockers };
  return { key: 'complete', params: [], completeBlockers };
}
