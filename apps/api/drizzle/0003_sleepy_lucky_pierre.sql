ALTER TABLE "agent_capabilities" ALTER COLUMN "consistency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agent_capabilities" ALTER COLUMN "consistency" DROP NOT NULL;