CREATE TABLE "agent_badges" (
	"agent_id" uuid NOT NULL,
	"badge" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_badges_agent_id_badge_pk" PRIMARY KEY("agent_id","badge")
);
--> statement-breakpoint
CREATE TABLE "debate_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"debate_id" uuid NOT NULL,
	"agent_id" uuid,
	"role" text DEFAULT 'agent' NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"content" text NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_reason" text,
	"moderation" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debate_votes" (
	"debate_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "debate_votes_debate_id_user_id_pk" PRIMARY KEY("debate_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "debates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'debate' NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"domain_id" uuid,
	"created_by" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_a_id" uuid NOT NULL,
	"agent_b_id" uuid NOT NULL,
	"agent_b_accepted" boolean DEFAULT false NOT NULL,
	"rounds" integer DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"winner_agent_id" uuid,
	"votes_a" integer DEFAULT 0 NOT NULL,
	"votes_b" integer DEFAULT 0 NOT NULL,
	"voting_ends_at" timestamp with time zone,
	"moderation" text DEFAULT 'visible' NOT NULL,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"user_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_user_id_target_type_target_id_pk" PRIMARY KEY("user_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "hive_learning_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text NOT NULL,
	"lessons_created" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" real DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hive_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"domain_id" uuid,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirm_count" integer DEFAULT 0 NOT NULL,
	"dispute_count" integer DEFAULT 0 NOT NULL,
	"moderation" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"moderation" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "moderation" text DEFAULT 'visible' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_badges" ADD CONSTRAINT "agent_badges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_messages" ADD CONSTRAINT "debate_messages_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_messages" ADD CONSTRAINT "debate_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_votes" ADD CONSTRAINT "debate_votes_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_votes" ADD CONSTRAINT "debate_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_votes" ADD CONSTRAINT "debate_votes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_domain_id_capability_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."capability_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_agent_a_id_agents_id_fk" FOREIGN KEY ("agent_a_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_agent_b_id_agents_id_fk" FOREIGN KEY ("agent_b_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_winner_agent_id_agents_id_fk" FOREIGN KEY ("winner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive_lessons" ADD CONSTRAINT "hive_lessons_domain_id_capability_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."capability_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_verdicts" ADD CONSTRAINT "knowledge_verdicts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_verdicts" ADD CONSTRAINT "knowledge_verdicts_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "debate_messages_debate_idx" ON "debate_messages" USING btree ("debate_id","created_at");--> statement-breakpoint
CREATE INDEX "debates_status_idx" ON "debates" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "follows_target_idx" ON "follows" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "hive_learning_runs_created_idx" ON "hive_learning_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hive_learning_runs_source_uq" ON "hive_learning_runs" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "hive_lessons_source_idx" ON "hive_lessons" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_verdicts_uq" ON "knowledge_verdicts" USING btree ("target_type","target_id","agent_id");--> statement-breakpoint
CREATE INDEX "knowledge_verdicts_target_idx" ON "knowledge_verdicts" USING btree ("target_type","target_id");