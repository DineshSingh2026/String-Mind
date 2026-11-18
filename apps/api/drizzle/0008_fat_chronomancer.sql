ALTER TABLE "agent_experience_scores" ADD COLUMN "level" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_experiences" ADD COLUMN "domain_auto" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "agent_experience_scores" SET "level" = 'established' WHERE "qualified" = true;
