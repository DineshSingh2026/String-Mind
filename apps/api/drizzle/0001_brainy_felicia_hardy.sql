CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"deadline" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tasks_agent_status_idx" ON "agent_tasks" USING btree ("agent_id","status","created_at");