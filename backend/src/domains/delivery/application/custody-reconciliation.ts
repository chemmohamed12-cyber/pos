/**
 * Vehicle Driver Workspace, Stage C / C4 - the PURE custody reconciliation of one vehicle, computed on the server from verified rows only (whole-cent integer arithmetic). Nothing is
 * netted into a hidden figure: every fact is its own line, and the two derived figures state their formula. "Remitted" (finance moved the money into the settlement account) and
 * "handed over" (the driver gave cash to the cashier) are different facts and are never merged.
 */
export interface ReconCollection {
  amount: string;
  verificationStatus: 'recorded' | 'confirmed' | 'rejected';
  remittanceStatus: 'pending' | 'remitted';
}
export interface ReconExpense {
  amount: string;
  status: 'pending_approval' | 'approved' | 'rejected' | 'posted' | 'cancelled' | 'reversed';
}
export interface ReconHandover {
  amount: string;
  status: 'declared' | 'confirmed' | 'rejected';
}

export interface CustodyReconciliation {
  collections: { recorded: string; confirmed: string; rejected: string; counted: string; remitted: string; notYetRemitted: string };
  expenses: { pendingApproval: string; approvedNotPosted: string; posted: string; rejectedOrCancelled: string };
  handovers: { declared: string; confirmed: string; rejected: string; handedOver: string };
  /** The separate expense float (policy 2026-10-26). Expenses never touch collections; these figures are about the float account only. */
  float: { assigned: boolean; balance: string | null; expectedBalance: string | null; difference: string | null; pendingApproval: string; approvedNotPosted: string; posted: string; reversed: string; availableAfterCommitments: string | null };
  derived: {
    /** counted collections - handovers (declared or confirmed): the customer cash the driver is still expected to be carrying. Expenses are NOT part of it. May be negative: that is a shortfall to investigate, never hidden. */
    cashInDriverHand: string;
    cashInDriverHandFormula: string;
    /** counted collections - remitted collections: what the collection custody ACCOUNT should hold. */
    expectedCustodyAccountBalance: string;
    expectedCustodyAccountFormula: string;
    /** actual Treasury custody balance - expectedCustodyAccountBalance; null when the balance is not available. The account may legitimately hold other cash, so this is a flag, not a verdict. */
    ledgerDifference: string | null;
  };
}

const cents = (a: string): number => Math.round(Number(a) * 100);
const money = (c: number): string => (c / 100).toFixed(2);

export function computeCustodyReconciliation(input: {
  collections: readonly ReconCollection[];
  expenses: readonly ReconExpense[];
  handovers: readonly ReconHandover[];
  custodyBalance: string | null;
  /** The vehicle's float: assigned? Treasury balance of the float account (null = not available), and the net funded amount (transfers in - transfers out) read from the float ledger. */
  float?: { assigned: boolean; balance: string | null; netFunded: string | null };
}): CustodyReconciliation {
  const sumC = (f: (c: ReconCollection) => boolean) => input.collections.filter(f).reduce((t, c) => t + cents(c.amount), 0);
  const sumE = (...st: ReconExpense['status'][]) => input.expenses.filter((e) => st.includes(e.status)).reduce((t, e) => t + cents(e.amount), 0);
  const sumH = (...st: ReconHandover['status'][]) => input.handovers.filter((h) => st.includes(h.status)).reduce((t, h) => t + cents(h.amount), 0);

  const recorded = sumC((c) => c.verificationStatus === 'recorded');
  const confirmed = sumC((c) => c.verificationStatus === 'confirmed');
  const rejected = sumC((c) => c.verificationStatus === 'rejected');
  const counted = recorded + confirmed;
  const remitted = sumC((c) => c.verificationStatus !== 'rejected' && c.remittanceStatus === 'remitted');
  const posted = sumE('posted');
  const reversed = sumE('reversed');
  const handedOver = sumH('declared', 'confirmed');

  const cashInHand = counted - handedOver;
  const expectedAccount = counted - remitted;
  const fl = input.float ?? { assigned: false, balance: null, netFunded: null };
  const pendingCents = sumE('pending_approval');
  const approvedCents = sumE('approved');
  // expected float balance = net funded by transfers - posted expenses (a reversed expense nets to zero: it is in neither sum)
  const expectedFloat = fl.netFunded === null ? null : cents(fl.netFunded) - posted;
  return {
    collections: { recorded: money(recorded), confirmed: money(confirmed), rejected: money(rejected), counted: money(counted), remitted: money(remitted), notYetRemitted: money(counted - remitted) },
    expenses: { pendingApproval: money(pendingCents), approvedNotPosted: money(approvedCents), posted: money(posted), rejectedOrCancelled: money(sumE('rejected', 'cancelled', 'reversed')) },
    handovers: { declared: money(sumH('declared')), confirmed: money(sumH('confirmed')), rejected: money(sumH('rejected')), handedOver: money(handedOver) },
    float: {
      assigned: fl.assigned,
      balance: fl.balance,
      expectedBalance: expectedFloat === null ? null : money(expectedFloat),
      difference: fl.balance === null || expectedFloat === null ? null : money(cents(fl.balance) - expectedFloat),
      pendingApproval: money(pendingCents),
      approvedNotPosted: money(approvedCents),
      posted: money(posted),
      reversed: money(reversed),
      availableAfterCommitments: fl.balance === null ? null : money(cents(fl.balance) - pendingCents - approvedCents),
    },
    derived: {
      cashInDriverHand: money(cashInHand),
      cashInDriverHandFormula: 'collections counted (recorded + confirmed) - handovers (declared + confirmed); expenses are paid from the separate float and are not part of this',
      expectedCustodyAccountBalance: money(expectedAccount),
      expectedCustodyAccountFormula: 'collections counted - collections remitted (expenses never touch this account)',
      ledgerDifference: input.custodyBalance === null ? null : money(cents(input.custodyBalance) - expectedAccount),
    },
  };
}
