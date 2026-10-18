CREATE TABLE "account_usage" (
	"account_id" uuid NOT NULL,
	"month_start" date NOT NULL,
	"used_units" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_usage_account_id_month_start_pk" PRIMARY KEY("account_id","month_start"),
	CONSTRAINT "account_usage_nonnegative_ck" CHECK ("account_usage"."used_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"account_plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"rules" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_owner_scope_name_key" UNIQUE NULLS NOT DISTINCT("account_id","scope","name"),
	CONSTRAINT "plans_scope_ck" CHECK ("plans"."scope" in ('account', 'user'))
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"units" bigint NOT NULL,
	"month_start" date NOT NULL,
	"accepted" boolean NOT NULL,
	"units_consumed" bigint NOT NULL,
	"rejection_level" text,
	"rejection_rule" text,
	"account_plan_id" uuid NOT NULL,
	"user_plan_id" uuid NOT NULL,
	"account_rules" jsonb NOT NULL,
	"user_rules" jsonb NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_units_positive_ck" CHECK ("requests"."units" > 0),
	CONSTRAINT "requests_consumed_nonnegative_ck" CHECK ("requests"."units_consumed" >= 0),
	CONSTRAINT "requests_rejection_shape_ck" CHECK ("requests"."accepted" or ("requests"."rejection_level" is not null and "requests"."rejection_rule" is not null and "requests"."units_consumed" = 0)),
	CONSTRAINT "requests_accepted_shape_ck" CHECK (not "requests"."accepted" or ("requests"."units_consumed" = "requests"."units" and "requests"."rejection_level" is null and "requests"."rejection_rule" is null))
);
--> statement-breakpoint
CREATE TABLE "user_usage" (
	"user_id" uuid NOT NULL,
	"month_start" date NOT NULL,
	"used_units" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_usage_user_id_month_start_pk" PRIMARY KEY("user_id","month_start"),
	CONSTRAINT "user_usage_nonnegative_ck" CHECK ("user_usage"."used_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_usage" ADD CONSTRAINT "account_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_account_plan_id_plans_id_fk" FOREIGN KEY ("account_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_account_plan_id_plans_id_fk" FOREIGN KEY ("account_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_user_plan_id_plans_id_fk" FOREIGN KEY ("user_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_account_request_key" ON "requests" USING btree ("account_id","request_id");--> statement-breakpoint
CREATE INDEX "requests_account_recent_idx" ON "requests" USING btree ("account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "requests_user_recent_idx" ON "requests" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "requests_account_month_accepted_idx" ON "requests" USING btree ("account_id","month_start") WHERE "requests"."accepted";--> statement-breakpoint
CREATE INDEX "requests_user_month_accepted_idx" ON "requests" USING btree ("user_id","month_start") WHERE "requests"."accepted";--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_external_key" ON "users" USING btree ("account_id","external_id");