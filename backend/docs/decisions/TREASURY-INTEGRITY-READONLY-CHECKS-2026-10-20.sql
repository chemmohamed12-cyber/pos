-- =====================================================================================
-- DAII Treasury integrity — READ-ONLY data checks (PROPOSAL, NOT EXECUTED)  2026-10-20
-- Run ONE Company database at a time, only against a target the CTO has approved in writing.
-- Preferred target: a disposable restored copy. Never production / hosted company data without separate authorization.
--
--   psql -v ON_ERROR_STOP=1 -v clearing_code='<code>' -f this.sql  <db>
--
-- Safety: the whole script runs in a READ ONLY transaction and ends with ROLLBACK; any write attempt errors out.
-- It repairs, re-drives, reverses or modifies NOTHING. Column/table names are read from the entities in `main`;
-- Q0 proves they exist on the target before anything else is trusted. If Q0 shows a missing column, STOP and adapt.
-- =====================================================================================
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '2s';

\echo '== Q0 schema probe (every column used below must appear) =='
SELECT table_name, string_agg(column_name, ',' ORDER BY column_name) AS cols
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('treasury_transactions','treasury_accounts','accounting_financial_events','accounting_journal_entries',
                     'accounting_journal_lines','accounting_gl_accounts','customer_payments','supplier_payments','event_outbox','deposits')
GROUP BY table_name ORDER BY table_name;
-- Also needed but not entity-verified: a collections table with the custody transaction id (COD). See Q1 note.

\echo '== Q1 treasury legs whose expected Financial Event is missing / not POSTED =='
-- expected_key mirrors the idempotency keys published in code:
--   direct cash   treasury:txn:{legId}:recorded            (only emitted when the account is GL-mapped)
--   transfer      treasury:transfer:{transferGroupId}:completed (one per group; only when BOTH accounts mapped)
--   cust payment  customer-finance:payment:{paymentId}:recorded
--   supp payment  procurement:supplier_payment:{paymentId}:recorded
--   deposit       deposit:{depositId}:verified
--   payroll leg   (no bank GL by design — D2 record "payroll disbursement's cash leg posts no bank GL")
--   COD custody   collection.remitted later (custody leg itself is non-emitting) -> reported as category only
WITH legs AS (
  SELECT t.*,
    CASE
      WHEN t."depositId" IS NOT NULL                       THEN 'deposit'
      WHEN cp.id IS NOT NULL                               THEN 'customer_payment'
      WHEN sp.id IS NOT NULL                               THEN 'supplier_payment'
      WHEN t."employeeId" IS NOT NULL OR t."payrollRunId" IS NOT NULL THEN 'payroll_disbursement'
      WHEN t.reason = 'cod_collection_custody'             THEN 'cod_custody'
      WHEN t."transferGroupId" IS NOT NULL                 THEN 'transfer'
      ELSE 'direct_cash'
    END AS category,
    CASE
      WHEN t."depositId" IS NOT NULL                       THEN 'deposit:'||t."depositId"||':verified'
      WHEN cp.id IS NOT NULL                               THEN 'customer-finance:payment:'||cp.id||':recorded'
      WHEN sp.id IS NOT NULL                               THEN 'procurement:supplier_payment:'||sp.id||':recorded'
      WHEN t."employeeId" IS NOT NULL OR t."payrollRunId" IS NOT NULL THEN NULL
      WHEN t.reason = 'cod_collection_custody'             THEN NULL
      WHEN t."transferGroupId" IS NOT NULL                 THEN 'treasury:transfer:'||t."transferGroupId"||':completed'
      ELSE 'treasury:txn:'||t.id||':recorded'
    END AS expected_key
  FROM treasury_transactions t
  LEFT JOIN customer_payments cp ON cp."treasuryTransactionId" = t.id
  LEFT JOIN supplier_payments sp ON sp."treasuryTransactionId" = t.id
)
SELECT l.category,
       a.code AS account, a."glAccountCode" AS gl_code,
       COALESCE(e.status, CASE WHEN l.expected_key IS NULL THEN 'N/A_NO_KEY' ELSE 'NO_EVENT' END) AS event_status,
       count(*) AS legs, round(sum(l.amount),2) AS sum_amount,
       min(l."movementDate")::date AS first_date, max(l."movementDate")::date AS last_date
FROM legs l
JOIN treasury_accounts a ON a.id = l."treasuryAccountId"
LEFT JOIN accounting_financial_events e ON e."idempotencyKey" = l.expected_key
WHERE COALESCE(e.status,'NO_EVENT') <> 'POSTED'
GROUP BY 1,2,3,4
ORDER BY 1,2,4;
-- INTERPRETATION
--   NO_EVENT + gl_code NULL      -> movement on an unmapped account: OFF-GL by construction (G-04). STOP-condition candidate.
--   NO_EVENT + gl_code NOT NULL  -> mapped account but nothing published: either pre-feature history or a lost event (G-03 variant). STOP-condition candidate.
--   REJECTED / RECEIVED / MAPPED -> treasury row committed, GL not posted (G-03 confirmed in data). STOP-condition candidate.
--   IGNORED                      -> a handler is absent for that topic; expected only for 'collection.recorded'.
--   N/A_NO_KEY                   -> payroll / COD custody legs: by design not posted at leg time; verify via Q3 totals, not here.
-- A transfer counts one expected event per group but 2 legs here; compare group counts, not leg counts, when reconciling.

\echo '== Q1b same, row level (first 200 offenders) =='
WITH legs AS (
  SELECT t.id, t."transactionNumber", t.type, t.amount, t."movementDate", t."treasuryAccountId", t."transferGroupId", t."reversalOfTransactionId", t.status,
    CASE WHEN t."depositId" IS NOT NULL THEN 'deposit:'||t."depositId"||':verified'
         WHEN cp.id IS NOT NULL THEN 'customer-finance:payment:'||cp.id||':recorded'
         WHEN sp.id IS NOT NULL THEN 'procurement:supplier_payment:'||sp.id||':recorded'
         WHEN t."employeeId" IS NOT NULL OR t."payrollRunId" IS NOT NULL OR t.reason='cod_collection_custody' THEN NULL
         WHEN t."transferGroupId" IS NOT NULL THEN 'treasury:transfer:'||t."transferGroupId"||':completed'
         ELSE 'treasury:txn:'||t.id||':recorded' END AS expected_key
  FROM treasury_transactions t
  LEFT JOIN customer_payments cp ON cp."treasuryTransactionId" = t.id
  LEFT JOIN supplier_payments sp ON sp."treasuryTransactionId" = t.id)
SELECT l."transactionNumber", l.type, l.amount, l."movementDate", a.code AS account, a."glAccountCode",
       l.expected_key, e.status AS event_status, e."rejectionReason"
FROM legs l JOIN treasury_accounts a ON a.id = l."treasuryAccountId"
LEFT JOIN accounting_financial_events e ON e."idempotencyKey" = l.expected_key
WHERE l.expected_key IS NOT NULL AND COALESCE(e.status,'NO_EVENT') <> 'POSTED'
ORDER BY l."movementDate" LIMIT 200;

\echo '== Q1c outbox rows for treasury/payment topics that did not dispatch =='
SELECT topic, status, count(*), min("createdAt") AS oldest, max(attempts) AS max_attempts
FROM event_outbox
WHERE status <> 'dispatched' AND (topic LIKE 'treasury.%' OR topic LIKE 'finance.%' OR topic LIKE 'deposit.%' OR topic LIKE 'collection.%' OR topic LIKE 'procurement.supplier%')
GROUP BY 1,2 ORDER BY 1,2;
-- failed = exhausted retries (dead letter). pending older than minutes = dispatcher not running for this Company.

\echo '== Q2 treasury accounts without a valid GL mapping, with their movement footprint =='
SELECT a.code, a.name, a.status AS account_status, a."glAccountCode",
       CASE WHEN a."glAccountCode" IS NULL OR btrim(a."glAccountCode") = '' THEN 'UNMAPPED'
            WHEN g.id IS NULL THEN 'MAPPED_CODE_NOT_IN_CHART'
            WHEN NOT g."isActive" THEN 'MAPPED_TO_INACTIVE_ACCOUNT'
            WHEN NOT g."isPostable" THEN 'MAPPED_TO_NON_POSTABLE'
            WHEN g."controlFunction" IS DISTINCT FROM 'bank' THEN 'MAPPED_NOT_BANK_CONTROL (informational)'
            ELSE 'OK' END AS mapping_state,
       count(t.id) AS legs,
       round(COALESCE(sum(CASE WHEN t.type IN ('cash_in','transfer_in') THEN t.amount ELSE -t.amount END),0),2) AS treasury_balance,
       min(t."movementDate")::date AS first_move, max(t."movementDate")::date AS last_move
FROM treasury_accounts a
LEFT JOIN accounting_gl_accounts g ON g.code = a."glAccountCode"
LEFT JOIN treasury_transactions t ON t."treasuryAccountId" = a.id
GROUP BY a.id, a.code, a.name, a.status, a."glAccountCode", g.id, g."isActive", g."isPostable", g."controlFunction"
ORDER BY (CASE WHEN g.id IS NOT NULL AND g."isActive" AND g."isPostable" THEN 1 ELSE 0 END), a.code;
-- INTERPRETATION: any row with mapping_state <> 'OK' AND legs > 0 is an account that has moved money without (or with a broken) GL bank leg.
-- MAPPED_NOT_BANK_CONTROL is informational (the D2 rule requires a mapping, not a specific control function).

\echo '== Q3a Treasury balance vs GL balance, per GL account code (a GL account may serve several treasury accounts) =='
WITH tb AS (
  SELECT a."glAccountCode" AS gl_code,
         sum(CASE WHEN t.type IN ('cash_in','transfer_in') THEN t.amount ELSE -t.amount END) AS treasury_balance,
         string_agg(DISTINCT a.code, ',') AS treasury_accounts
  FROM treasury_accounts a JOIN treasury_transactions t ON t."treasuryAccountId" = a.id
  WHERE a."glAccountCode" IS NOT NULL
  GROUP BY 1),
gb AS (
  SELECT g.code AS gl_code, sum(l."debitBase" - l."creditBase") AS gl_balance, count(*) AS gl_lines
  FROM accounting_gl_accounts g
  JOIN accounting_journal_lines l ON l."accountId" = g.id
  JOIN accounting_journal_entries j ON j.id = l."journalEntryId" AND j."postedAt" IS NOT NULL   -- posted entries only (drafts have no postedAt)
  GROUP BY 1)
SELECT tb.gl_code, tb.treasury_accounts, round(tb.treasury_balance,2) AS treasury_balance,
       round(COALESCE(gb.gl_balance,0),2) AS gl_balance,
       round(tb.treasury_balance - COALESCE(gb.gl_balance,0),2) AS drift, COALESCE(gb.gl_lines,0) AS gl_lines
FROM tb LEFT JOIN gb USING (gl_code)
ORDER BY abs(tb.treasury_balance - COALESCE(gb.gl_balance,0)) DESC;
-- INTERPRETATION: drift = 0 -> reconciled. drift <> 0 -> compare with Q1 offenders. Legitimate non-zero causes: GL-only entries on the bank account
-- (opening balance / approved adjustments / fees, via the FA-01 flow) and payroll/COD legs that are off-bank-GL by design. A drift that Q1 does not explain
-- is a STOP-condition candidate. Base currency amounts are compared; the system is single-currency (EGP) today.

\echo '== Q3b same, per company-wide total and per day of the last 30 days movement (spot timing) =='
SELECT (t."movementDate")::date AS day, count(*) AS legs,
       round(sum(CASE WHEN t.type IN ('cash_in','transfer_in') THEN t.amount ELSE -t.amount END),2) AS net
FROM treasury_transactions t WHERE t."movementDate" >= now() - interval '30 days' GROUP BY 1 ORDER BY 1 DESC;

\echo '== Q4 clearing account: balance and originating transactions (pass -v clearing_code=...) =='
SELECT g.code, g.name, g."controlFunction", g."isActive",
       round(sum(l."debitBase" - l."creditBase"),2) AS balance, count(*) AS lines
FROM accounting_gl_accounts g
LEFT JOIN accounting_journal_lines l ON l."accountId" = g.id
LEFT JOIN accounting_journal_entries j ON j.id = l."journalEntryId" AND j."postedAt" IS NOT NULL
WHERE g.code = :'clearing_code'
GROUP BY 1,2,3,4;
-- If unknown, find candidates first: SELECT code,name FROM accounting_gl_accounts WHERE name ILIKE '%clearing%' OR "nameAr" LIKE '%تسوية%';

SELECT j."businessDate", j."entryNumber", e."eventType", e."sourceEntityType", e."sourceEntityId",
       t."transactionNumber", t.type AS leg_type, t.reason, t.reference, t."customerId", t."salesOrderId",
       l."debitBase", l."creditBase", (current_date - j."businessDate") AS age_days
FROM accounting_gl_accounts g
JOIN accounting_journal_lines l ON l."accountId" = g.id
JOIN accounting_journal_entries j ON j.id = l."journalEntryId" AND j."postedAt" IS NOT NULL
LEFT JOIN accounting_financial_events e ON e.id = j."financialEventId"
LEFT JOIN treasury_transactions t ON e."sourceEntityId" = t.id::text
WHERE g.code = :'clearing_code'
ORDER BY j."businessDate" DESC LIMIT 500;
-- INTERPRETATION: every unlinked cash-in/out (no customer/supplier flow) lands here. Non-zero balance = unclassified money (G-01). Rows with
-- customerId/salesOrderId set are G-02 evidence (labelled as a customer receipt but AR was not credited). age_days feeds the aging of unexplained items.

\echo '== Q5 stop-condition probes: unbalanced / duplicate / orphan postings (all entries, not only treasury) =='
SELECT 'unbalanced_journal' AS probe, j.id::text AS ref, j."entryNumber", j."totalDebitBase"::text AS a, j."totalCreditBase"::text AS b
FROM accounting_journal_entries j WHERE j."postedAt" IS NOT NULL AND j."totalDebitBase" <> j."totalCreditBase"
UNION ALL
SELECT 'lines_vs_header_mismatch', j.id::text, j."entryNumber", sum(l."debitBase")::text, j."totalDebitBase"::text
FROM accounting_journal_entries j JOIN accounting_journal_lines l ON l."journalEntryId" = j.id
WHERE j."postedAt" IS NOT NULL GROUP BY j.id, j."entryNumber", j."totalDebitBase" HAVING sum(l."debitBase") <> j."totalDebitBase"
UNION ALL
SELECT 'event_posted_without_journal', e.id::text, e."idempotencyKey", e.status, NULL
FROM accounting_financial_events e WHERE e.status = 'POSTED' AND e."journalEntryId" IS NULL
UNION ALL
SELECT 'two_posted_journals_for_one_event', j."financialEventId"::text, count(*)::text, NULL, NULL
FROM accounting_journal_entries j WHERE j."financialEventId" IS NOT NULL AND j."postedAt" IS NOT NULL AND j."reversalOfEntryId" IS NULL
GROUP BY j."financialEventId" HAVING count(*) > 1;
-- Expected: ZERO rows. Any row is an immediate stop-and-report (unbalanced journal or duplicate posting).

\echo '== Q6 treasury legs that are reversed but whose subledger/invoice effect remains (G-06 evidence) =='
SELECT 'customer_payment_with_reversed_treasury_leg' AS probe, cp."paymentNumber", cp.amount, t."transactionNumber", t.status
FROM customer_payments cp JOIN treasury_transactions t ON t.id = cp."treasuryTransactionId" WHERE t.status = 'reversed'
UNION ALL
SELECT 'supplier_payment_with_reversed_treasury_leg', sp."paymentNumber", sp.amount, t."transactionNumber", t.status
FROM supplier_payments sp JOIN treasury_transactions t ON t.id = sp."treasuryTransactionId" WHERE t.status = 'reversed';
-- Any row means someone reversed the cash leg of a payment directly: the payment row, AR/AP ledger entry and invoice status were NOT unwound.

ROLLBACK;
