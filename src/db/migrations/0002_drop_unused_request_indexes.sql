-- The partial accepted-month indexes fed the monthly_request_cap COUNT
-- queries, which moved onto the usage counter rows in 0001. Nothing on the
-- request path reads them anymore; they only cost every ledger insert two
-- extra index maintenance operations. The stage invariant checker re-derives
-- its counts straight from the ledger and does not need a hot-path index.
DROP INDEX IF EXISTS "requests_account_month_accepted_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "requests_user_month_accepted_idx";
