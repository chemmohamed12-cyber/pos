BEGIN TRANSACTION READ ONLY;
\echo '-- A. legs by account family and mapping (summary of Q2)'
SELECT CASE WHEN a.code LIKE 'E2EACC-%' THEN 'E2EACC-* (test fixtures)' WHEN a.code LIKE 'PACC-%' THEN 'PACC-* (test fixtures)' ELSE a.code END AS family,
       (a."glAccountCode" IS NOT NULL) AS mapped, count(DISTINCT a.id) accounts, count(t.id) legs,
       round(COALESCE(sum(CASE WHEN t.type IN ('cash_in','transfer_in') THEN t.amount ELSE -t.amount END),0),2) net
FROM treasury_accounts a LEFT JOIN treasury_transactions t ON t."treasuryAccountId"=a.id GROUP BY 1,2 ORDER BY 4 DESC;
\echo '-- B. event status for every GL-owned treasury leg expected event (not only offenders)'
SELECT e.status, e."eventType", count(*) FROM accounting_financial_events e GROUP BY 1,2 ORDER BY 1,2;
\echo '-- C. REJECTED/RECEIVED events, reasons'
SELECT e."eventType", e.status, left(e."rejectionReason",140) reason, count(*), min(e."businessDate") first_bd, max(e."businessDate") last_bd
FROM accounting_financial_events e WHERE e.status NOT IN ('POSTED','IGNORED') GROUP BY 1,2,3 ORDER BY 4 DESC;
\echo '-- D. M0001 and MAIN-CASH legs'
SELECT a.code, t."transactionNumber", t.type, t.amount, t.status, t.reason, t."movementDate"::date, t."depositId" IS NOT NULL dep, t."reversalOfTransactionId" IS NOT NULL is_rev
FROM treasury_transactions t JOIN treasury_accounts a ON a.id=t."treasuryAccountId" WHERE a.code IN ('M0001','MAIN-CASH') ORDER BY a.code, t."movementDate";
\echo '-- E. GL lines on 1101 (what makes -2000)'
SELECT j."entryNumber", j."businessDate", e."eventType", e."sourceEntityType", l."debitBase", l."creditBase", left(j.description,70) descr
FROM accounting_gl_accounts g JOIN accounting_journal_lines l ON l."accountId"=g.id
JOIN accounting_journal_entries j ON j.id=l."journalEntryId" AND j."postedAt" IS NOT NULL
LEFT JOIN accounting_financial_events e ON e.id=j."financialEventId" WHERE g.code='1101' ORDER BY j."businessDate";
\echo '-- F. 1102 and any other bank-control balance vs treasury (all bank-control GL accounts)'
SELECT g.code, round(sum(l."debitBase"-l."creditBase"),2) gl_balance, count(*) lines FROM accounting_gl_accounts g
JOIN accounting_journal_lines l ON l."accountId"=g.id JOIN accounting_journal_entries j ON j.id=l."journalEntryId" AND j."postedAt" IS NOT NULL
WHERE g."controlFunction"='bank' GROUP BY 1;
\echo '-- G. payments / deposits linked to treasury legs and their events'
SELECT 'customer_payments' src, count(*) n, round(sum(amount),2) amt FROM customer_payments UNION ALL
SELECT 'supplier_payments', count(*), round(sum(amount),2) FROM supplier_payments UNION ALL
SELECT 'deposits', count(*), round(sum(amount),2) FROM deposits;
\echo '-- H. treasury legs that are status=reversed, and reversal rows'
SELECT status, type, count(*) FROM treasury_transactions WHERE status='reversed' OR "reversalOfTransactionId" IS NOT NULL GROUP BY 1,2;
\echo '-- I. distinct posted-entry sourceTypes vs events'
SELECT j."sourceType", count(*) FROM accounting_journal_entries j WHERE j."postedAt" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;
ROLLBACK;
