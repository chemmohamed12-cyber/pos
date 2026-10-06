import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult, JournalDraftLine } from './handler-registry';

/**
 * F12 — Fixed Assets (ADR-045 D2/D10). The GL posting for an **approved** disposal. Every account is
 * already an explicit, resolved id in the payload (the asset's own `costAccountId`/
 * `accumulatedDepreciationAccountId`, the maker's chosen `proceedsAccountId`, and the config-resolved
 * gain/loss account) — this handler builds the balanced draft and lets F03's posting gate
 * (`assertPostable`, called on every line) perform the AUTHORITATIVE, posting-time revalidation of
 * each one (ADR-045 D10, Mandatory Correction #2: nothing here is trusted from submission time alone).
 *
 * Shape: Dr accumulatedDepreciationAccountId (accumulated depreciation to date, fetched FRESH via
 * `ctx.manager` at this exact moment — never the submission-time snapshot, since a Depreciation Run
 * could have posted in the interim), Dr proceedsAccountId (if proceeds > 0), Cr costAccountId (full
 * cost), and the balancing plug on gain (Cr) or loss (Dr) — never both, computed once from the three
 * already-known numbers.
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** FA-02 (2026-10-06, CTO) — two SEPARATE configured accounts; the result of the disposal decides which one is used. */
export const DISPOSAL_GAIN_ACCOUNT_CONFIG_KEY = 'accounting.fixed_asset_gain_on_disposal_account_code';
export const DISPOSAL_LOSS_ACCOUNT_CONFIG_KEY = 'accounting.fixed_asset_loss_on_disposal_account_code';

/**
 * proceeds + accumulated depreciation − cost. Positive = gain (Cr gain account), negative = loss (Dr loss account). The ONE
 * calculation shared by the posting handler and the pre-mutation pre-flight, so they can never disagree.
 */
export function disposalGainLoss(proceeds: string | number, accumulatedDepreciation: string | number, cost: string | number): { gainLoss: number; side: 'gain' | 'loss' | 'none' } {
  const gainLoss = num(proceeds) + num(accumulatedDepreciation) - num(cost);
  const plug = Math.abs(gainLoss).toFixed(4);
  if (Number(plug) === 0) return { gainLoss, side: 'none' };
  return { gainLoss, side: gainLoss > 0 ? 'gain' : 'loss' };
}

export async function handleFixedAssetDisposalApproved(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const fixedAssetId = str(p.fixedAssetId);
  const costAccountId = str(p.costAccountId);
  const accumulatedDepreciationAccountId = str(p.accumulatedDepreciationAccountId);
  const cost = str(p.cost);
  const proceeds = str(p.proceeds) ?? '0';
  const proceedsAccountId = str(p.proceedsAccountId);

  if (!fixedAssetId || !costAccountId || !accumulatedDepreciationAccountId || !cost) {
    return { kind: 'rejected', reason: 'fixed asset disposal: missing required fields in payload' };
  }
  if (Number(proceeds) > 0 && !proceedsAccountId) {
    return { kind: 'rejected', reason: 'fixed asset disposal: proceeds > 0 but no proceedsAccountId' };
  }

  // ADR-045 D10 / FA-02 — the accounts are resolved HERE, at posting time, fail-closed, never a hard-coded fallback (the exact
  // `resolveConfiguredPostableAccount` mechanism F06/F10 built). Only the account the RESULT needs is required (a gain disposal does
  // not need the loss account configured, and vice-versa) — resolved after the fresh accumulated depreciation is known, below.

  // Accumulated depreciation to date, fetched FRESH at this exact posting moment — not a stale
  // submission-time snapshot (ADR-045 D10). A Depreciation Run posted between submission and approval
  // is correctly reflected here.
  const [row] = (await ctx.manager.query(
    `SELECT COALESCE(SUM("calculatedAmount"), 0)::numeric(20,4) AS total FROM accounting_depreciation_run_lines WHERE "fixedAssetId" = $1`,
    [fixedAssetId],
  )) as Array<{ total: string }>;
  const accumulatedDepreciationToDate = row.total;

  const { gainLoss, side } = disposalGainLoss(proceeds, accumulatedDepreciationToDate, cost);
  let plugAccountId: string | null = null;
  if (side !== 'none') {
    const key = side === 'gain' ? DISPOSAL_GAIN_ACCOUNT_CONFIG_KEY : DISPOSAL_LOSS_ACCOUNT_CONFIG_KEY;
    const plugAccount = await ctx.resolveConfiguredPostableAccount(key);
    if (!plugAccount.ok) return { kind: 'rejected', reason: `fixed asset disposal: ${side}-on-disposal account unresolved (${plugAccount.reason}) — configure "${key}"` };
    plugAccountId = plugAccount.id;
  }

  const lines: JournalDraftLine[] = [];
  if (Number(accumulatedDepreciationToDate) > 0) {
    lines.push({ accountId: accumulatedDepreciationAccountId, debit: accumulatedDepreciationToDate, description: 'Accumulated depreciation removed on disposal' });
  }
  if (Number(proceeds) > 0 && proceedsAccountId) {
    lines.push({ accountId: proceedsAccountId, debit: proceeds, description: 'Disposal proceeds' });
  }
  lines.push({ accountId: costAccountId, credit: cost, description: 'Asset cost removed on disposal' });

  const plugAmount = Math.abs(gainLoss).toFixed(4);
  if (Number(plugAmount) > 0 && plugAccountId) {
    if (gainLoss > 0) {
      lines.push({ accountId: plugAccountId, credit: plugAmount, description: 'Gain on disposal' });
    } else {
      lines.push({ accountId: plugAccountId, debit: plugAmount, description: 'Loss on disposal' });
    }
  }

  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Fixed asset disposal — ${event.sourceEntityId}`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines,
    },
  };
}
