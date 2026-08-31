CREATE TABLE "public_outcome_write_windows" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"write_count" integer NOT NULL,
	CONSTRAINT "public_outcome_write_windows_count_check" CHECK ("public_outcome_write_windows"."write_count" between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "public_outcome_write_windows" ADD CONSTRAINT "public_outcome_write_windows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;