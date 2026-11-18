CREATE TABLE "agent_payout_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"address" text NOT NULL,
	"status" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_payout_addresses_status" CHECK ("agent_payout_addresses"."status" in ('pending','active','superseded','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "blockchain_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"tx_signature" text NOT NULL,
	"detected_via" text NOT NULL,
	"source_address" text,
	"destination_address" text NOT NULL,
	"destination_token_account" text,
	"asset" text NOT NULL,
	"mint_address" text,
	"decimals" integer NOT NULL,
	"raw_amount" numeric(30, 0) NOT NULL,
	"block_time" timestamp with time zone,
	"slot" bigint,
	"asset_usd_price" text,
	"usd_value" text,
	"idlemine_usd_price" text,
	"idlemine_amount" text,
	"idle_credited" bigint,
	"price_source" text,
	"priced_at" timestamp with time zone,
	"status" text DEFAULT 'detected' NOT NULL,
	"rejection_reason" text,
	"sweep_signature" text,
	"sweep_tx_b64" text,
	"sweep_last_valid_block_height" bigint,
	"sweep_attempts" integer DEFAULT 0 NOT NULL,
	"swept_raw_amount" numeric(30, 0),
	"ledger_tx_id" uuid,
	"last_error" text,
	"verified_at" timestamp with time zone,
	"swept_at" timestamp with time zone,
	"credited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_blockchain_deposits_asset" CHECK ("blockchain_deposits"."asset" in ('USDC','USDT','SOL','IDLEMINE')),
	CONSTRAINT "ck_blockchain_deposits_status" CHECK ("blockchain_deposits"."status" in ('detected','verified','sweeping','swept','credited','rejected','failed')),
	CONSTRAINT "ck_blockchain_deposits_raw_positive" CHECK ("blockchain_deposits"."raw_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "onchain_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'platform_fee' NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"amount_idle" bigint NOT NULL,
	"amount_raw" numeric(30, 0) NOT NULL,
	"mint_address" text NOT NULL,
	"source_wallet" text NOT NULL,
	"destination_wallet" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"transfer_signature" text,
	"pending_signature" text,
	"pending_tx_b64" text,
	"pending_last_valid_block_height" bigint,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ck_onchain_settlements_status" CHECK ("onchain_settlements"."status" in ('pending','sending','completed','failed')),
	CONSTRAINT "ck_onchain_settlements_amount_positive" CHECK ("onchain_settlements"."amount_raw" > 0)
);
--> statement-breakpoint
CREATE TABLE "onchain_withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"requested_by" uuid,
	"amount_idle" bigint NOT NULL,
	"destination_wallet" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_signature" text,
	"payout_last_valid_block_height" bigint,
	"payout_tx_b64" text,
	"payout_source" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"reserve_tx_id" uuid,
	"final_tx_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ck_onchain_withdrawals_amount" CHECK ("onchain_withdrawals"."amount_idle" > 0),
	CONSTRAINT "ck_onchain_withdrawals_status" CHECK ("onchain_withdrawals"."status" in ('pending','processing','completed','failed'))
);
--> statement-breakpoint
CREATE TABLE "solana_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text NOT NULL,
	"agent_id" uuid,
	"public_address" text NOT NULL,
	"key_source" text NOT NULL,
	"derivation_scope" text,
	"derivation_id" uuid,
	"key_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_scanned_block_time" bigint,
	"last_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_solana_wallets_role" CHECK ("solana_wallets"."role" in ('AGENT','MID','ADMIN')),
	CONSTRAINT "ck_solana_wallets_agent_role" CHECK (("solana_wallets"."role" = 'AGENT') = ("solana_wallets"."agent_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "token_price_samples" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "token_price_samples_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"mint" text NOT NULL,
	"usd_price" text NOT NULL,
	"source" text NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_reconciliation_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_key" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_payout_addresses" ADD CONSTRAINT "agent_payout_addresses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockchain_deposits" ADD CONSTRAINT "blockchain_deposits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockchain_deposits" ADD CONSTRAINT "blockchain_deposits_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockchain_deposits" ADD CONSTRAINT "blockchain_deposits_wallet_id_solana_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."solana_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onchain_withdrawals" ADD CONSTRAINT "onchain_withdrawals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onchain_withdrawals" ADD CONSTRAINT "onchain_withdrawals_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onchain_withdrawals" ADD CONSTRAINT "onchain_withdrawals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solana_wallets" ADD CONSTRAINT "solana_wallets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_agent_payout_addresses_agent" ON "agent_payout_addresses" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_payout_addresses_active" ON "agent_payout_addresses" USING btree ("agent_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_payout_addresses_pending" ON "agent_payout_addresses" USING btree ("agent_id") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_blockchain_deposits_sig_wallet_asset" ON "blockchain_deposits" USING btree ("tx_signature","wallet_id","asset");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_blockchain_deposits_sweep_signature" ON "blockchain_deposits" USING btree ("sweep_signature") WHERE sweep_signature is not null;--> statement-breakpoint
CREATE INDEX "ix_blockchain_deposits_agent_created" ON "blockchain_deposits" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_blockchain_deposits_open" ON "blockchain_deposits" USING btree ("status") WHERE status in ('detected','verified','sweeping','swept');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_onchain_settlements_fee" ON "onchain_settlements" USING btree ("source_type","source_id") WHERE kind = 'platform_fee';--> statement-breakpoint
CREATE INDEX "ix_onchain_settlements_open" ON "onchain_settlements" USING btree ("status") WHERE status in ('pending','sending');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_onchain_withdrawals_signature" ON "onchain_withdrawals" USING btree ("tx_signature") WHERE tx_signature is not null;--> statement-breakpoint
CREATE INDEX "ix_onchain_withdrawals_status" ON "onchain_withdrawals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ix_onchain_withdrawals_agent" ON "onchain_withdrawals" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_solana_wallets_address" ON "solana_wallets" USING btree ("public_address");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_solana_wallets_active_agent" ON "solana_wallets" USING btree ("agent_id") WHERE role = 'AGENT' and status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_solana_wallets_active_platform_role" ON "solana_wallets" USING btree ("role") WHERE role in ('MID','ADMIN') and status = 'active';--> statement-breakpoint
CREATE INDEX "ix_token_price_samples_mint_time" ON "token_price_samples" USING btree ("mint","sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_wallet_recon_issues_open" ON "wallet_reconciliation_issues" USING btree ("kind","ref_type","ref_key") WHERE status = 'open';