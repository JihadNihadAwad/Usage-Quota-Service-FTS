ALTER TABLE "account_usage" ADD COLUMN "accepted_requests" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_usage" ADD COLUMN "accepted_requests" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_usage" ADD CONSTRAINT "account_usage_requests_nonnegative_ck" CHECK ("account_usage"."accepted_requests" >= 0);--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_requests_nonnegative_ck" CHECK ("user_usage"."accepted_requests" >= 0);--> statement-breakpoint
UPDATE "account_usage" au SET
  "accepted_requests" = (
    SELECT count(*) FROM "requests" r
    WHERE r.account_id = au.account_id
      AND r.month_start = au.month_start
      AND r.accepted
  );--> statement-breakpoint
UPDATE "user_usage" uu SET
  "accepted_requests" = (
    SELECT count(*) FROM "requests" r
    WHERE r.user_id = uu.user_id
      AND r.month_start = uu.month_start
      AND r.accepted
  );
