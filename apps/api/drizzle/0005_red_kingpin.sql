CREATE TABLE "agent_certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"domain_slug" text NOT NULL,
	"level" text DEFAULT 'none' NOT NULL,
	"score" real NOT NULL,
	"exam_score" real,
	"evidence_score" real,
	"live_check_score" real,
	"confidence" real,
	"exam_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_live_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_slug" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"task" text NOT NULL,
	"rubric" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" text,
	"judgement" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"submitted_by" uuid NOT NULL,
	"domain_slug" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"claim" text DEFAULT '' NOT NULL,
	"url" text,
	"storage_path" text,
	"mime_type" text,
	"size_bytes" integer,
	"sha256" text,
	"ownership_token" text,
	"ownership_status" text DEFAULT 'unverified' NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"judgement" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trust_weight" real,
	"quality_score" real,
	"evidence_score" real,
	"moderation" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pro_calibration_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"level" text NOT NULL,
	"answer" text NOT NULL,
	"scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total" real NOT NULL,
	"red_flags_fired" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"provenance" text DEFAULT 'synthetic' NOT NULL,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pro_exam_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"twist" text,
	"rendered_prompt" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"judgement" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pro_exams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_slug" text NOT NULL,
	"requested_by" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"mode" text DEFAULT 'certification' NOT NULL,
	"seed_hash" text NOT NULL,
	"target_items" integer DEFAULT 12 NOT NULL,
	"ability" real,
	"ability_se" real,
	"score" real,
	"axes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real,
	"judge_model" text,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pro_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"source" text NOT NULL,
	"domain_name" text NOT NULL,
	"domain_slug" text,
	"subtopic" text DEFAULT '' NOT NULL,
	"task_type" text NOT NULL,
	"difficulty" text NOT NULL,
	"case_material" text DEFAULT '' NOT NULL,
	"task" text NOT NULL,
	"rubric" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reference_solution" text DEFAULT '' NOT NULL,
	"red_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deterministic_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grading_mode" text NOT NULL,
	"visibility" text DEFAULT 'public_example' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"expert_review_required" boolean DEFAULT false NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"validation_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"license" text DEFAULT '' NOT NULL,
	"canary" text NOT NULL,
	"irt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"times_served" integer DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pro_twists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_name" text NOT NULL,
	"domain_slug" text,
	"twist" text NOT NULL,
	"rubric_effect" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_certifications" ADD CONSTRAINT "agent_certifications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_certifications" ADD CONSTRAINT "agent_certifications_exam_id_pro_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."pro_exams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_live_checks" ADD CONSTRAINT "evidence_live_checks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_live_checks" ADD CONSTRAINT "evidence_live_checks_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_submissions" ADD CONSTRAINT "evidence_submissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_submissions" ADD CONSTRAINT "evidence_submissions_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_submissions" ADD CONSTRAINT "evidence_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_calibration_answers" ADD CONSTRAINT "pro_calibration_answers_question_id_pro_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."pro_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_calibration_answers" ADD CONSTRAINT "pro_calibration_answers_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_exam_items" ADD CONSTRAINT "pro_exam_items_exam_id_pro_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."pro_exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_exam_items" ADD CONSTRAINT "pro_exam_items_question_id_pro_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."pro_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_exams" ADD CONSTRAINT "pro_exams_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_exams" ADD CONSTRAINT "pro_exams_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_exams" ADD CONSTRAINT "pro_exams_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_questions" ADD CONSTRAINT "pro_questions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_cert_uq" ON "agent_certifications" USING btree ("agent_id","domain_slug");--> statement-breakpoint
CREATE INDEX "evidence_live_agent_idx" ON "evidence_live_checks" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "evidence_agent_idx" ON "evidence_submissions" USING btree ("agent_id","domain_slug");--> statement-breakpoint
CREATE INDEX "pro_calibration_q_idx" ON "pro_calibration_answers" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "pro_exam_items_exam_idx" ON "pro_exam_items" USING btree ("exam_id","position");--> statement-breakpoint
CREATE INDEX "pro_exams_agent_idx" ON "pro_exams" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pro_questions_ext_uq" ON "pro_questions" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "pro_questions_domain_idx" ON "pro_questions" USING btree ("domain_slug","status","difficulty");--> statement-breakpoint
CREATE INDEX "pro_twists_domain_idx" ON "pro_twists" USING btree ("domain_slug");