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
  status: 'pending_approval' | 'approved' | 'rejected' | 'posted' | 'cancelled';
}
export interface ReconHandover {
  amount: string;
  status: 'declared' | 'confirmed' | 'rejected';
}

export interface CustodyReconciliation {
  collections: { recorded: string; confirmed: string; rejected: string; counted: string; remitted: string; notYetRemitted: string };
  expenses: { pendingApproval: string; approvedNotPosted: string; posted: string; rejectedOrCancelled: string };
  handovers: { declared: string; confirmed: string; rejected: string; handedOver: string };
  derived: {
    /** counted collections - posted expenses - handovers (declared or confirmed): the cash the driver is still expected to be carrying. May be negative: that is a shortfall to investigate, never hidden. */
    cashInDriverHand: string;
    cashInDriverHandFormula: string;
    /** counted collections - posted expenses - remitted collections: what the custody ACCOUNT should hold for these collections. */
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
  const handedOver = sumH('declared', 'confirmed');

  const cashInHand = counted - posted - handedOver;
  const expectedAccount = counted - posted - remitted;
  return {
    collections: { recorded: money(recorded), confirmed: money(confirmed), rejected: money(rejected), counted: money(counted), remitted: money(remitted), notYetRemitted: money(counted - remitted) },
    expenses: { pendingApproval: money(sumE('pending_approval')), approvedNotPosted: money(sumE('approved')), posted: money(posted), rejectedOrCancelled: money(sumE('rejected', 'cancelled')) },
    handovers: { declared: money(sumH('declared')), confirmed: money(sumH('confirmed')), rejected: money(sumH('rejected')), handedOver: money(handedOver) },
    derived: {
      cashInDriverHand: money(cashInHand),
      cashInDriverHandFormula: 'collections counted (recorded + confirmed) - expenses posted - handovers (declared + confirmed)',
      expectedCustodyAccountBalance: money(expectedAccount),
      expectedCustodyAccountFormula: 'collections counted - expenses posted - collections remitted',
      ledgerDifference: input.custodyBalance === null ? null : money(cents(input.custodyBalance) - expectedAccount),
    },
  };
}
