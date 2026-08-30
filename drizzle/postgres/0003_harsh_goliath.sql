-- ABOUTME: Adds versioned evidence, embedding, job, indexing, fixture, and evaluation records.
-- ABOUTME: Preserves the existing Postgres data while introducing workspace-scoped constraints.
CREATE TABLE "chunk_embeddings" (
	"chunk_id" text NOT NULL,
	"embedding_generation_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_input_hash" text NOT NULL,
	"dimension" integer NOT NULL,
	"vector" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunk_embeddings_chunk_id_embedding_generation_id_pk" PRIMARY KEY("chunk_id","embedding_generation_id"),
	CONSTRAINT "chunk_embeddings_hashes_check" CHECK (length("chunk_embeddings"."content_hash") = 64 and length("chunk_embeddings"."embedding_input_hash") = 64),
	CONSTRAINT "chunk_embeddings_vector_check" CHECK ("chunk_embeddings"."dimension" between 1 and 4096 and jsonb_typeof("chunk_embeddings"."vector") = 'array' and jsonb_array_length("chunk_embeddings"."vector") = "chunk_embeddings"."dimension")
);
--> statement-breakpoint
CREATE TABLE "embedding_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimension" integer NOT NULL,
	"configuration_hash" text NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "embedding_generations_dimension_check" CHECK ("embedding_generations"."dimension" between 1 and 4096),
	CONSTRAINT "embedding_generations_configuration_hash_check" CHECK (length("embedding_generations"."configuration_hash") = 64),
	CONSTRAINT "embedding_generations_status_check" CHECK ("embedding_generations"."status" in ('building', 'active', 'retired', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "embedding_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"article_id" text NOT NULL,
	"article_content_hash" text NOT NULL,
	"embedding_generation_id" text,
	"index_generation" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"maximum_attempts" integer DEFAULT 3 NOT NULL,
	"checkpoint" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "embedding_jobs_hash_check" CHECK (length("embedding_jobs"."article_content_hash") = 64),
	CONSTRAINT "embedding_jobs_status_check" CHECK ("embedding_jobs"."status" in ('pending', 'leased', 'retryable', 'completed', 'failed', 'superseded')),
	CONSTRAINT "embedding_jobs_attempts_check" CHECK ("embedding_jobs"."attempts" between 0 and "embedding_jobs"."maximum_attempts" and "embedding_jobs"."maximum_attempts" between 1 and 10 and "embedding_jobs"."checkpoint" >= 0),
	CONSTRAINT "embedding_jobs_lease_check" CHECK ("embedding_jobs"."status" <> 'leased' or ("embedding_jobs"."lease_token" is not null and "embedding_jobs"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"question_set_id" text NOT NULL,
	"index_generation" integer NOT NULL,
	"embedding_generation_id" text,
	"retrieval_mode" text NOT NULL,
	"provider" text,
	"model" text,
	"status" text DEFAULT 'running' NOT NULL,
	"results" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "evaluation_runs_generation_check" CHECK ("evaluation_runs"."index_generation" >= 0),
	CONSTRAINT "evaluation_runs_status_check" CHECK ("evaluation_runs"."status" in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "evidence_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"article_id" text NOT NULL,
	"article_content_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_input_hash" text NOT NULL,
	"index_generation" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"heading_path" jsonb NOT NULL,
	"canonical_url" text NOT NULL,
	"markdown" text NOT NULL,
	"evidence_text" text NOT NULL,
	"embedding_text" text NOT NULL,
	"source_line_start" integer NOT NULL,
	"source_line_end" integer NOT NULL,
	"publication_state" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_chunks_hashes_check" CHECK (length("evidence_chunks"."article_content_hash") = 64 and length("evidence_chunks"."content_hash") = 64 and length("evidence_chunks"."embedding_input_hash") = 64),
	CONSTRAINT "evidence_chunks_position_check" CHECK ("evidence_chunks"."index_generation" >= 1 and "evidence_chunks"."ordinal" >= 0 and "evidence_chunks"."source_line_start" >= 1 and "evidence_chunks"."source_line_end" >= "evidence_chunks"."source_line_start"),
	CONSTRAINT "evidence_chunks_heading_path_check" CHECK (jsonb_typeof("evidence_chunks"."heading_path") = 'array'),
	CONSTRAINT "evidence_chunks_publication_state_check" CHECK ("evidence_chunks"."publication_state" = 'published')
);
--> statement-breakpoint
CREATE TABLE "saved_question_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"source_content_hash" text NOT NULL,
	"questions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_question_sets_version_check" CHECK ("saved_question_sets"."version" >= 1 and length("saved_question_sets"."source_content_hash") = 64 and jsonb_typeof("saved_question_sets"."questions") = 'array')
);
--> statement-breakpoint
CREATE TABLE "workspace_index_states" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"active_embedding_generation_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_index_states_generation_check" CHECK ("workspace_index_states"."generation" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_generations_id_workspace_unique" ON "embedding_generations" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_chunks_identity_unique" ON "evidence_chunks" USING btree ("id","workspace_id","content_hash","embedding_input_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_question_sets_id_workspace_unique" ON "saved_question_sets" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_chunk_id_workspace_id_content_hash_embedding_input_hash_evidence_chunks_id_workspace_id_content_hash_embedding_input_hash_fk" FOREIGN KEY ("chunk_id","workspace_id","content_hash","embedding_input_hash") REFERENCES "public"."evidence_chunks"("id","workspace_id","content_hash","embedding_input_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_embedding_generation_id_workspace_id_embedding_generations_id_workspace_id_fk" FOREIGN KEY ("embedding_generation_id","workspace_id") REFERENCES "public"."embedding_generations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_generations" ADD CONSTRAINT "embedding_generations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_jobs" ADD CONSTRAINT "embedding_jobs_article_id_workspace_id_articles_id_workspace_id_fk" FOREIGN KEY ("article_id","workspace_id") REFERENCES "public"."articles"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_jobs" ADD CONSTRAINT "embedding_jobs_embedding_generation_id_workspace_id_embedding_generations_id_workspace_id_fk" FOREIGN KEY ("embedding_generation_id","workspace_id") REFERENCES "public"."embedding_generations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_question_set_id_workspace_id_saved_question_sets_id_workspace_id_fk" FOREIGN KEY ("question_set_id","workspace_id") REFERENCES "public"."saved_question_sets"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_embedding_generation_id_workspace_id_embedding_generations_id_workspace_id_fk" FOREIGN KEY ("embedding_generation_id","workspace_id") REFERENCES "public"."embedding_generations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_chunks" ADD CONSTRAINT "evidence_chunks_article_id_workspace_id_articles_id_workspace_id_fk" FOREIGN KEY ("article_id","workspace_id") REFERENCES "public"."articles"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_question_sets" ADD CONSTRAINT "saved_question_sets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_index_states" ADD CONSTRAINT "workspace_index_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_index_states" ADD CONSTRAINT "workspace_index_states_active_embedding_generation_id_workspace_id_embedding_generations_id_workspace_id_fk" FOREIGN KEY ("active_embedding_generation_id","workspace_id") REFERENCES "public"."embedding_generations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_embeddings_workspace_generation_index" ON "chunk_embeddings" USING btree ("workspace_id","embedding_generation_id");--> statement-breakpoint
CREATE INDEX "embedding_generations_workspace_status_index" ON "embedding_generations" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_jobs_id_workspace_unique" ON "embedding_jobs" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_jobs_workspace_lease_token_unique" ON "embedding_jobs" USING btree ("workspace_id","lease_token");--> statement-breakpoint
CREATE INDEX "embedding_jobs_claim_index" ON "embedding_jobs" USING btree ("workspace_id","status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "embedding_jobs_article_index" ON "embedding_jobs" USING btree ("workspace_id","article_id");--> statement-breakpoint
CREATE INDEX "evaluation_runs_workspace_started_index" ON "evaluation_runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_chunks_article_ordinal_unique" ON "evidence_chunks" USING btree ("workspace_id","article_id","ordinal");--> statement-breakpoint
CREATE INDEX "evidence_chunks_workspace_generation_index" ON "evidence_chunks" USING btree ("workspace_id","index_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_question_sets_workspace_name_version_unique" ON "saved_question_sets" USING btree ("workspace_id","name","version");
