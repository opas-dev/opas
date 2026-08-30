CREATE TABLE "support_handoffs" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"contact" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "support_handoffs_id_workspace_id_pk" PRIMARY KEY("id","workspace_id"),
	CONSTRAINT "support_handoffs_identity_check" CHECK (length("support_handoffs"."id") = 36 and length("support_handoffs"."payload_hash") = 64),
	CONSTRAINT "support_handoffs_status_check" CHECK ("support_handoffs"."status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "support_handoffs_lifecycle_check" CHECK (("support_handoffs"."status" = 'pending' and "support_handoffs"."finished_at" is null) or ("support_handoffs"."status" <> 'pending' and "support_handoffs"."finished_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "support_handoffs" ADD CONSTRAINT "support_handoffs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_handoffs_workspace_status_created_index" ON "support_handoffs" USING btree ("workspace_id","status","created_at");