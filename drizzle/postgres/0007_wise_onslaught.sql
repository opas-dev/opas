CREATE TABLE "conversation_analytics" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"conversation" jsonb NOT NULL,
	"retrieval_trace" jsonb NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"duration_milliseconds" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_microdollars" integer,
	"bucket_day" text NOT NULL,
	"bucket_slot" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_analytics_id_workspace_id_pk" PRIMARY KEY("id","workspace_id"),
	CONSTRAINT "conversation_analytics_identity_check" CHECK (length("conversation_analytics"."id") = 36 and length("conversation_analytics"."provider") between 1 and 64 and length("conversation_analytics"."model") between 1 and 256),
	CONSTRAINT "conversation_analytics_outcome_check" CHECK ("conversation_analytics"."outcome" in ('abandoned', 'abstained', 'answered', 'escalated', 'low-rated')),
	CONSTRAINT "conversation_analytics_reason_check" CHECK ("conversation_analytics"."reason" is null or octet_length("conversation_analytics"."reason") <= 256),
	CONSTRAINT "conversation_analytics_json_check" CHECK (jsonb_typeof("conversation_analytics"."conversation") = 'array' and jsonb_typeof("conversation_analytics"."retrieval_trace") = 'array' and octet_length("conversation_analytics"."conversation"::text) <= 16384 and octet_length("conversation_analytics"."retrieval_trace"::text) <= 8192),
	CONSTRAINT "conversation_analytics_measurements_check" CHECK ("conversation_analytics"."duration_milliseconds" between 0 and 300000 and ("conversation_analytics"."input_tokens" is null or "conversation_analytics"."input_tokens" between 0 and 1000000) and ("conversation_analytics"."output_tokens" is null or "conversation_analytics"."output_tokens" between 0 and 1000000) and ("conversation_analytics"."cost_microdollars" is null or "conversation_analytics"."cost_microdollars" between 0 and 2000000000)),
	CONSTRAINT "conversation_analytics_bucket_check" CHECK ("conversation_analytics"."bucket_day" ~ '^[0-9]{8}$' and "conversation_analytics"."bucket_slot" between 0 and 1023),
	CONSTRAINT "conversation_analytics_lifecycle_check" CHECK ("conversation_analytics"."updated_at" >= "conversation_analytics"."started_at" and "conversation_analytics"."expires_at" > "conversation_analytics"."started_at")
);
--> statement-breakpoint
CREATE TABLE "public_write_reservations" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "public_write_reservations_id_workspace_id_kind_pk" PRIMARY KEY("id","workspace_id","kind"),
	CONSTRAINT "public_write_reservations_identity_check" CHECK (length("public_write_reservations"."id") = 36 and "public_write_reservations"."kind" = 'handoff'),
	CONSTRAINT "public_write_reservations_lifecycle_check" CHECK ("public_write_reservations"."expires_at" > "public_write_reservations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "workspace_public_write_states" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_analytics" ADD CONSTRAINT "conversation_analytics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_write_reservations" ADD CONSTRAINT "public_write_reservations_workspace_id_workspace_public_write_states_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace_public_write_states"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_public_write_states" ADD CONSTRAINT "workspace_public_write_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_analytics_workspace_bucket_unique" ON "conversation_analytics" USING btree ("workspace_id","bucket_day","bucket_slot");--> statement-breakpoint
CREATE INDEX "conversation_analytics_workspace_expiry_index" ON "conversation_analytics" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "conversation_analytics_workspace_started_index" ON "conversation_analytics" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "public_write_reservations_workspace_kind_created_index" ON "public_write_reservations" USING btree ("workspace_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "public_write_reservations_workspace_expiry_index" ON "public_write_reservations" USING btree ("workspace_id","expires_at");
