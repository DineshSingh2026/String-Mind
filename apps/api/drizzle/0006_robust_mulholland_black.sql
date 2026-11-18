CREATE TABLE "agent_experience_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"domain_slug" text NOT NULL,
	"score" real NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"resolved_count" integer DEFAULT 0 NOT NULL,
	"witnessed_count" integer DEFAULT 0 NOT NULL,
	"success_rate" real,
	"span_days" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone,
	"last_at" timestamp with time zone,
	"replay_score" real,
	"replay_id" uuid,
	"replay_at" timestamp with time zone,
	"qualified" boolean DEFAULT false NOT NULL,
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid,
	"situation" text NOT NULL,
	"action" text NOT NULL,
	"reasoning" text DEFAULT '' NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"lesson" text DEFAULT '' NOT NULL,
	"result" text DEFAULT 'pending' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome_recorded_at" timestamp with time zone,
	"source" text NOT NULL,
	"evidence_url" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"witnessed" boolean DEFAULT false NOT NULL,
	"checksum" text NOT NULL,
	"embedding" vector(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experience_replay_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"replay_id" uuid NOT NULL,
	"experience_id" uuid,
	"ordinal" integer NOT NULL,
	"prompt" text NOT NULL,
	"expected" text NOT NULL,
	"avoid" text DEFAULT '' NOT NULL,
	"response" text,
	"score" real,
	"grade" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"task_id" uuid,
	"graded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "experience_replays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"domain_slug" text NOT NULL,
	"purpose" text DEFAULT 'self' NOT NULL,
	"training_session_id" uuid,
	"requested_by" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"mode" text DEFAULT 'sync' NOT NULL,
	"score" real,
	"items_total" integer DEFAULT 0 NOT NULL,
	"items_graded" integer DEFAULT 0 NOT NULL,
	"method" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_experience_scores" ADD CONSTRAINT "agent_experience_scores_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_experiences" ADD CONSTRAINT "agent_experiences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_experiences" ADD CONSTRAINT "agent_experiences_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_experiences" ADD CONSTRAINT "agent_experiences_domain_id_capability_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."capability_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_replay_items" ADD CONSTRAINT "experience_replay_items_replay_id_experience_replays_id_fk" FOREIGN KEY ("replay_id") REFERENCES "public"."experience_replays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_replay_items" ADD CONSTRAINT "experience_replay_items_experience_id_agent_experiences_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."agent_experiences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_replays" ADD CONSTRAINT "experience_replays_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_replays" ADD CONSTRAINT "experience_replays_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_replays" ADD CONSTRAINT "experience_replays_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_replays" ADD CONSTRAINT "experience_replays_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_experience_scores_uq" ON "agent_experience_scores" USING btree ("agent_id","domain_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_experiences_checksum_uq" ON "agent_experiences" USING btree ("agent_id","checksum");--> statement-breakpoint
CREATE INDEX "agent_experiences_agent_idx" ON "agent_experiences" USING btree ("agent_id","domain_id","occurred_at");--> statement-breakpoint
CREATE INDEX "experience_replay_items_replay_idx" ON "experience_replay_items" USING btree ("replay_id","ordinal");--> statement-breakpoint
CREATE INDEX "experience_replays_agent_idx" ON "experience_replays" USING btree ("agent_id","created_at");