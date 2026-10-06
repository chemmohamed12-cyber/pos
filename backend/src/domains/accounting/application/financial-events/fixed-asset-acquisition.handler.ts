import { FinancialEvent } from '../../infrastructure/financial-event.entity';
import { HandlerContext, HandlerResult } from './handler-registry';

/** D8 helper (2026-10-06, CTO: Option C) — the configured, postable, NON-control Fixed Asset Acquisition Clearing account. No default, no fallback. */
export const ACQUISITION_CLEARING_ACCOUNT_CONFIG_KEY = 'accounting.fixed_asset_acquisition_clearing_account_code';

/** The internal FinancialEvent type the acquisition-journal helper ingests (same engine path as depreciation / disposal). */
export const FIXED_ASSET_ACQUISITION_REQUESTED_EVENT = 'accounting.fixed_asset.acquisition.requested';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * D8 helper — the GL posting of an acquisition journal: **Dr the asset's cost account / Cr Fixed Asset Acquisition Clearing**, for exactly the
 * asset's cost. Deliberately knows nothing about Accounts Payable or Treasury: the clearing account is later settled against the real source
 * (a vendor invoice → AP, a payment → Bank, a transfer → another account) by those workflows. The clearing account is resolved HERE, at posting
 * time, fail-closed (the same `resolveConfiguredPostableAccount` mechanism as the disposal gain/loss accounts) — never a hard-coded or
 * defaulted account. The cost account is an explicit id in the payload; F03's posting gate revalidates every line at posting time.
 */
export async function handleFixedAssetAcquisitionRequested(event: FinancialEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const p = event.payload;
  const fixedAssetId = str(p.fixedAssetId);
  const costAccountId = str(p.costAccountId);
  const cost = str(p.cost);
  if (!fixedAssetId || !costAccountId || !cost || !(Number(cost) > 0)) {
    return { kind: 'rejected', reason: 'fixed asset acquisition: missing/invalid fixedAssetId, costAccountId or cost in payload' };
  }
  const clearing = await ctx.resolveConfiguredPostableAccount(ACQUISITION_CLEARING_ACCOUNT_CONFIG_KEY);
  if (!clearing.ok) {
    return { kind: 'rejected', reason: `fixed asset acquisition: clearing account unresolved (${clearing.reason}) — configure "${ACQUISITION_CLEARING_ACCOUNT_CONFIG_KEY}"` };
  }
  return {
    kind: 'draft',
    draft: {
      businessDate: event.businessDate,
      description: `Fixed asset acquisition — ${event.sourceEntityId}`,
      transactionCurrencyCode: event.transactionCurrencyCode,
      orgUnitId: event.orgUnitId,
      lines: [
        { accountId: costAccountId, debit: cost, description: 'Fixed asset cost (acquisition)' },
        { accountId: clearing.id, credit: cost, description: 'Fixed asset acquisition clearing' },
      ],
    },
  };
}
